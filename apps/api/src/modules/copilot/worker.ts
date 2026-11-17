import type { CopilotJob, CopilotMonitoring } from "@corelogistics/contracts";
import type { FastifyInstance } from "fastify";
import { many, newId, one, run, scalar, tx } from "../../db.js";
import { badRequest, notFound } from "../../errors.js";
import { subscribe, toEvent } from "../../events.js";
import { evaluateDisruption, revalidatePendingRecommendations } from "./service.js";

/** Trip events the worker evaluates. Copilot's own events are recorded and then skipped. */
export const COPILOT_MONITORED_EVENTS = [
  "trip.issue",
  "trip.updated",
  "trip.dispatched",
  "trip.departed",
  "trip.arrived",
  "trip.stop_arrived",
  "trip.stop_departed",
  "trip.completed",
  "trip.cancelled",
] as const;

const MONITORED = new Set<string>(COPILOT_MONITORED_EVENTS);
const RETRY_MS = [5_000, 30_000];

interface JobRow {
  id: string;
  event_id: number;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  processing_error: string | null;
  created_at: string;
  updated_at: string;
}

interface CopilotLog {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
}

let refs = 0;
let running = false;
let draining = false;
let pendingWake = false;
let unsubscribe: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const retryTimers = new Set<ReturnType<typeof setTimeout>>();
let log: CopilotLog = { info() {}, error() {} };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : "Copilot processing failed";
}

function logInfo(obj: Record<string, unknown>, msg: string) {
  try {
    log.info(obj, msg);
  } catch {
    // A logger failure must not change job state.
  }
}

function logError(obj: Record<string, unknown>, msg: string) {
  try {
    log.error(obj, msg);
  } catch {
    // A logger failure must not change job state.
  }
}

function touch(which: "heartbeat" | "sweep" | "both") {
  const now = new Date().toISOString();
  if (which === "heartbeat" || which === "both") {
    run("UPDATE copilot_cursor SET heartbeat_at = ? WHERE id = 1", [now]);
  }
  if (which === "sweep" || which === "both") {
    run("UPDATE copilot_cursor SET sweep_at = ? WHERE id = 1", [now]);
  }
}

function ensureCursor() {
  if (one("SELECT id FROM copilot_cursor WHERE id = 1")) return;
  const max = Number(scalar<number>("SELECT COALESCE(MAX(id), 0) FROM events") ?? 0);
  const now = new Date().toISOString();
  run(
    "INSERT INTO copilot_cursor (id, event_id, initialized_at, heartbeat_at, sweep_at) VALUES (1, ?, ?, ?, ?)",
    [max, now, now, now],
  );
  revalidatePendingRecommendations();
}

/** Queues monitored events past the cursor, then moves the cursor to the last id read. */
export function catchUp() {
  const cursor = one<{ event_id: number }>("SELECT event_id FROM copilot_cursor WHERE id = 1");
  if (!cursor) return;
  const rows = many<{ id: number; type: string }>("SELECT id, type FROM events WHERE id > ? ORDER BY id ASC", [
    Number(cursor.event_id),
  ]);
  if (!rows.length) return;
  const ceiling = Number(rows[rows.length - 1]!.id);
  const now = new Date().toISOString();
  tx(() => {
    for (const row of rows) {
      if (!MONITORED.has(row.type)) continue;
      run(
        `INSERT OR IGNORE INTO copilot_jobs (id, event_id, status, attempts, created_at, updated_at)
         VALUES (?, ?, 'queued', 0, ?, ?)`,
        [newId("job"), Number(row.id), now, now],
      );
    }
    run("UPDATE copilot_cursor SET event_id = ? WHERE id = 1 AND event_id < ?", [ceiling, ceiling]);
  });
}

function claimNext(): JobRow | null {
  const now = new Date().toISOString();
  return tx(() => {
    const row = one<JobRow>(
      `SELECT * FROM copilot_jobs
       WHERE status IN ('queued', 'retry')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY event_id ASC
       LIMIT 1`,
      [now],
    );
    if (!row) return null;
    const updated = run(
      `UPDATE copilot_jobs SET status = 'processing', updated_at = ? WHERE id = ? AND status IN ('queued', 'retry')`,
      [now, row.id],
    );
    if (Number(updated.changes) !== 1) return null;
    return row;
  });
}

function scheduleRetry(job: JobRow, message: string) {
  const attempts = Number(job.attempts) + 1;
  const now = new Date().toISOString();
  if (attempts >= 3) {
    run(
      `UPDATE copilot_jobs
       SET status = 'failed', attempts = ?, processing_error = ?, next_attempt_at = NULL, updated_at = ?
       WHERE id = ?`,
      [attempts, message, now, job.id],
    );
    return;
  }
  const delay = RETRY_MS[attempts - 1] ?? 30_000;
  const next = new Date(Date.now() + delay).toISOString();
  run(
    `UPDATE copilot_jobs
     SET status = 'retry', attempts = ?, processing_error = ?, next_attempt_at = ?, updated_at = ?
     WHERE id = ?`,
    [attempts, message, next, now, job.id],
  );
  const retry = setTimeout(() => {
    retryTimers.delete(retry);
    try {
      wake();
    } catch (err) {
      logError({ jobId: job.id, eventId: Number(job.event_id), error: errText(err) }, "copilot retry wake failed");
    }
  }, delay);
  retry.unref();
  retryTimers.add(retry);
}

function processJob(job: JobRow) {
  const row = one("SELECT * FROM events WHERE id = ?", [job.event_id]);
  if (!row) {
    scheduleRetry(job, "Event no longer exists");
    logError({ jobId: job.id, eventId: Number(job.event_id), tripId: null, siteId: null, recommendationId: null }, "copilot job failed");
    return;
  }
  let event;
  try {
    event = toEvent(row);
  } catch (err) {
    const message = errText(err);
    scheduleRetry(job, message);
    logError(
      { jobId: job.id, eventId: Number(job.event_id), tripId: null, siteId: null, recommendationId: null, error: message },
      "copilot job failed",
    );
    return;
  }
  try {
    const rec = evaluateDisruption(event);
    run(`UPDATE copilot_jobs SET status = 'done', processing_error = NULL, updated_at = ? WHERE id = ?`, [
      new Date().toISOString(),
      job.id,
    ]);
    logInfo(
      {
        jobId: job.id,
        eventId: event.id,
        tripId: event.tripId,
        siteId: rec?.siteId ?? event.siteId,
        recommendationId: rec?.id ?? null,
      },
      "copilot job processed",
    );
  } catch (err) {
    const message = errText(err);
    scheduleRetry(job, message);
    logError(
      {
        jobId: job.id,
        eventId: event.id,
        tripId: event.tripId,
        siteId: event.siteId,
        recommendationId: null,
        error: message,
      },
      "copilot job failed",
    );
  }
}

/** Processes every due job before returning. Re-entrant wakes wait until the current drain finishes. */
export function wake() {
  if (!running) return;
  if (draining) {
    pendingWake = true;
    return;
  }
  draining = true;
  try {
    touch("heartbeat");
    for (;;) {
      const job = claimNext();
      if (!job) break;
      processJob(job);
    }
  } finally {
    draining = false;
    if (pendingWake) {
      pendingWake = false;
      wake();
    }
  }
}

export function runCopilotSweep() {
  touch("both");
  catchUp();
  wake();
}

function recoverProcessing() {
  run(`UPDATE copilot_jobs SET status = 'queued', updated_at = ? WHERE status = 'processing'`, [
    new Date().toISOString(),
  ]);
}

function startWorker() {
  if (running) return;
  running = true;
  unsubscribe = subscribe(() => {
    try {
      catchUp();
      wake();
    } catch (err) {
      logError({ error: errText(err) }, "copilot wake failed");
    }
  });
  ensureCursor();
  recoverProcessing();
  timer = setInterval(() => {
    try {
      touch("both");
      catchUp();
      wake();
    } catch (err) {
      logError({ error: errText(err) }, "copilot sweep failed");
    }
  }, 5_000);
  timer.unref();
  try {
    touch("both");
    wake();
  } catch (err) {
    logError({ error: errText(err) }, "copilot startup wake failed");
  }
}

function stopWorker() {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  for (const retry of retryTimers) clearTimeout(retry);
  retryTimers.clear();
}

export function initCopilot(app: FastifyInstance) {
  refs += 1;
  log = {
    info: (obj, msg) => app.log.info(obj, msg),
    error: (obj, msg) => app.log.error(obj, msg),
  };
  if (refs === 1) startWorker();
  app.addHook("onClose", async () => {
    refs = Math.max(0, refs - 1);
    if (refs === 0) stopWorker();
  });
}

export function copilotRuntime() {
  return { listeners: unsubscribe ? 1 : 0, sweeping: timer !== null, refs };
}

function toJob(row: JobRow): CopilotJob {
  return {
    id: row.id,
    eventId: Number(row.event_id),
    status: row.status as CopilotJob["status"],
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at ?? null,
    processingError: row.processing_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getCopilotMonitoring(): CopilotMonitoring {
  const cursor = one<{ event_id: number; heartbeat_at: string | null; sweep_at: string | null }>(
    "SELECT event_id, heartbeat_at, sweep_at FROM copilot_cursor WHERE id = 1",
  );
  return {
    running,
    heartbeatAt: cursor?.heartbeat_at ?? null,
    lastSweepAt: cursor?.sweep_at ?? null,
    cursor: cursor ? Number(cursor.event_id) : null,
    backlog: Number(scalar<number>("SELECT COUNT(*) FROM copilot_jobs WHERE status IN ('queued', 'retry', 'processing')") ?? 0),
    failedJobs: Number(scalar<number>("SELECT COUNT(*) FROM copilot_jobs WHERE status = 'failed'") ?? 0),
    monitoredEvents: [...COPILOT_MONITORED_EVENTS],
  };
}

export function listCopilotJobs(status?: string): CopilotJob[] {
  const rows = status
    ? many<JobRow>("SELECT * FROM copilot_jobs WHERE status = ? ORDER BY updated_at DESC LIMIT 50", [status])
    : many<JobRow>("SELECT * FROM copilot_jobs ORDER BY updated_at DESC LIMIT 50");
  return rows.map(toJob);
}

/** Requeues a failed job. The route allows only Tower. Processing happens before the response returns. */
export function retryFailedJob(id: string): CopilotJob {
  const row = one<JobRow>("SELECT * FROM copilot_jobs WHERE id = ?", [id]);
  if (!row) throw notFound("Copilot job");
  if (row.status !== "failed") throw badRequest(`Job is ${row.status}`);
  const now = new Date().toISOString();
  run(
    `UPDATE copilot_jobs
     SET status = 'queued', attempts = 0, next_attempt_at = NULL, processing_error = NULL, updated_at = ?
     WHERE id = ? AND status = 'failed'`,
    [now, id],
  );
  wake();
  return toJob(one<JobRow>("SELECT * FROM copilot_jobs WHERE id = ?", [id])!);
}
