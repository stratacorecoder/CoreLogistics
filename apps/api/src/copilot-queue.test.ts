import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { one, run, scalar } from "./db.js";
import { toEvent } from "./events.js";
import { migrate } from "./migrate.js";
import { evaluateDisruption } from "./modules/copilot/service.js";
import { copilotRuntime, COPILOT_MONITORED_EVENTS, runCopilotSweep } from "./modules/copilot/worker.js";
import { ensureDemoUsers, seedIfEmpty } from "./seed.js";

describe("Copilot disruption queue", () => {
  let app: FastifyInstance;
  let towerToken: string;
  let warehouseToken: string;
  let whId: string;
  let depotId: string;
  let n = 0;

  const tower = () => ({ "x-session": towerToken });
  const iso = (ms: number) => new Date(ms).toISOString();

  before(async () => {
    migrate();
    seedIfEmpty();
    ensureDemoUsers();
    const maxBefore = Number(scalar<number>("SELECT COALESCE(MAX(id), 0) FROM events"));
    app = await buildApp({ logger: false });
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "ava", password: "planner" },
    });
    towerToken = JSON.parse(login.payload).token;
    const floor = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "mina", password: "floor" },
    });
    warehouseToken = JSON.parse(floor.payload).token;
    whId = one<{ id: string }>("SELECT id FROM sites WHERE code = 'WH-C'")!.id;
    depotId = one<{ id: string }>("SELECT id FROM sites WHERE code = 'DEP-N'")!.id;

    const health = await app.inject({ method: "GET", url: "/health" });
    const healthBody = JSON.parse(health.payload);
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.backlog, 0);
    assert.equal(healthBody.failedJobs, 0);
    assert.equal(typeof healthBody.heartbeatAt, "string");

    const monitoring = await app.inject({ method: "GET", url: "/copilot/monitoring", headers: tower() });
    assert.equal(monitoring.statusCode, 200, monitoring.payload);
    const body = JSON.parse(monitoring.payload);
    assert.equal(body.running, true);
    assert.equal(body.cursor, maxBefore);
    assert.equal(body.backlog, 0);
    assert.equal(body.failedJobs, 0);
    assert.deepEqual(body.monitoredEvents, [...COPILOT_MONITORED_EVENTS]);
    assert.equal(body.monitoredEvents.includes("vehicle.position"), false);
    assert.equal(Number(scalar("SELECT COUNT(*) FROM copilot_recommendations")), 0);
    const runtime = copilotRuntime();
    assert.equal(runtime.listeners, 1);
    assert.equal(runtime.sweeping, true);
  });

  function label() {
    n += 1;
    return String(n).padStart(2, "0");
  }

  function addVehicle(siteId: string) {
    const id = `veh_queue_${label()}`;
    const plate = `QUE${id.slice(-4).toUpperCase()}`;
    run(
      `INSERT INTO vehicles (id, code, plate, kind, model, status, home_site_id)
       VALUES (?, ?, ?, 'truck', 'Queue test', 'available', ?)`,
      [id, `V-${id}`, plate, siteId],
    );
    return { id, plate };
  }

  function addDriver(siteId: string) {
    const id = `drv_queue_${label()}`;
    run(
      `INSERT INTO drivers (id, code, name, license_class, license_expiry, status, home_site_id)
       VALUES (?, ?, 'Queue Driver', 'C', '2030-01-01', 'available', ?)`,
      [id, `D-${id}`, siteId],
    );
    return id;
  }

  async function dispatchTrip(plannedDeparture: string, plannedArrival: string) {
    const vehicle = addVehicle(depotId);
    const driverId = addDriver(depotId);
    const created = await app.inject({
      method: "POST",
      url: "/trips",
      headers: tower(),
      payload: {
        kind: "inbound",
        originSiteId: depotId,
        destinationSiteId: whId,
        vehicleId: vehicle.id,
        driverId,
        plannedDeparture,
        plannedArrival,
        notes: "",
      },
    });
    assert.equal(created.statusCode, 200, created.payload);
    const trip = JSON.parse(created.payload);
    const dispatched = await app.inject({
      method: "POST",
      url: `/trips/${trip.id}/dispatch`,
      headers: tower(),
    });
    assert.equal(dispatched.statusCode, 200, dispatched.payload);
    return JSON.parse(dispatched.payload) as { id: string; code: string };
  }

  async function issue(tripId: string, kind: string, message: string) {
    const res = await app.inject({
      method: "POST",
      url: `/trips/${tripId}/issues`,
      headers: tower(),
      payload: { kind, message },
    });
    assert.equal(res.statusCode, 200, res.payload);
    return JSON.parse(res.payload) as { id: number };
  }

  async function recommendations(tripId: string) {
    const res = await app.inject({ method: "GET", url: "/copilot/recommendations?limit=200", headers: tower() });
    assert.equal(res.statusCode, 200, res.payload);
    const rows = JSON.parse(res.payload) as Array<Record<string, any>>;
    return rows.filter((rec) => rec.tripId === tripId);
  }

  it("does not open a recommendation for an on-time trip update", async () => {
    const now = Date.now();
    const trip = await dispatchTrip(iso(now + 30 * 60_000), iso(now + 90 * 60_000));
    const updated = await app.inject({
      method: "PATCH",
      url: `/trips/${trip.id}`,
      headers: tower(),
      payload: { notes: "paperwork only" },
    });
    assert.equal(updated.statusCode, 200, updated.payload);
    assert.equal((await recommendations(trip.id)).length, 0);
  });

  it("dedups the same event and ignores copilot's own events", async () => {
    const now = Date.now();
    const trip = await dispatchTrip(iso(now - 20 * 60_000), iso(now + 40 * 60_000));
    const event = await issue(trip.id, "delay", "Same event must not revise twice");
    const [rec] = await recommendations(trip.id);
    assert.ok(rec);
    assert.equal(rec.revision, 1);
    assert.deepEqual(rec.triggeringEventIds, [event.id]);

    const row = one("SELECT * FROM events WHERE id = ?", [event.id]);
    const again = evaluateDisruption(toEvent(row!));
    assert.equal(again?.id, rec.id);
    assert.equal(again?.revision, 1);
    runCopilotSweep();
    const [afterSweep] = await recommendations(trip.id);
    assert.equal(afterSweep?.revision, 1);
    assert.equal(
      Number(
        scalar(
          `SELECT COUNT(*) FROM copilot_jobs j JOIN events e ON e.id = j.event_id WHERE e.type LIKE 'copilot.%'`,
        ),
      ),
      0,
    );
  });

  it("evaluates a new disruption after dismissal", async () => {
    const now = Date.now();
    const trip = await dispatchTrip(iso(now - 25 * 60_000), iso(now + 30 * 60_000));
    await issue(trip.id, "delay", "First disruption");
    const [first] = await recommendations(trip.id);
    const dismissed = await app.inject({
      method: "POST",
      url: `/copilot/recommendations/${first!.id}/dismiss`,
      headers: tower(),
      payload: { revision: first!.revision },
    });
    assert.equal(dismissed.statusCode, 200, dismissed.payload);
    await issue(trip.id, "cargo", "A later disruption is still evaluated");
    const rows = await recommendations(trip.id);
    assert.equal(rows.length, 2);
    const pending = rows.find((rec) => rec.status === "pending");
    const closed = rows.find((rec) => rec.status === "dismissed");
    assert.ok(pending && closed);
    assert.notEqual(pending.id, closed.id);
    assert.equal(pending.lifecycle === "actionable" || pending.lifecycle === "human_review", true);
  });

  it("escalates severity upward, keeps the prior revision, and leaves lifecycle updates pending", async () => {
    const now = Date.now();
    const trip = await dispatchTrip(iso(now - 40 * 60_000), iso(now + 20 * 60_000));
    await issue(trip.id, "delay", "First delay");
    const [opened] = await recommendations(trip.id);
    assert.equal(opened?.severity, "medium");
    assert.equal(opened?.revision, 1);

    await issue(trip.id, "breakdown", "Engine seized");
    const [critical] = await recommendations(trip.id);
    assert.equal(critical?.id, opened?.id);
    assert.equal(critical?.severity, "critical");
    assert.equal(critical?.revision, 2);
    assert.match(critical?.rootCause, /Engine seized/);
    assert.equal(critical?.priorRevisions.length, 1);
    assert.equal(critical?.priorRevisions[0].revision, 1);
    assert.equal(critical?.priorRevisions[0].severity, "medium");
    assert.equal(critical?.priorRevisions[0].lifecycle, "superseded");
    assert.match(critical?.priorRevisions[0].rootCause, /First delay/);
    assert.equal(critical?.triggeringEventIds.length, 2);

    await issue(trip.id, "delay", "Follow-up delay");
    const [held] = await recommendations(trip.id);
    assert.equal(held?.severity, "critical");
    assert.match(held?.rootCause, /Follow-up delay/);
    const cause = held?.rootCause;

    const departed = await app.inject({ method: "POST", url: `/trips/${trip.id}/depart`, headers: tower() });
    assert.equal(departed.statusCode, 200, departed.payload);
    const [live] = await recommendations(trip.id);
    assert.equal(live?.status, "pending");
    assert.equal(live?.severity, "critical");
    assert.equal(live?.rootCause, cause);
    assert.ok(live!.revision > held!.revision);
  });

  it("resolves an open recommendation when the trip is cancelled or completed", async () => {
    const now = Date.now();
    const cancelledTrip = await dispatchTrip(iso(now + 60 * 60_000), iso(now + 2 * 60 * 60_000));
    await issue(cancelledTrip.id, "delay", "Cancel this disruption");
    const cancelled = await app.inject({
      method: "POST",
      url: `/trips/${cancelledTrip.id}/cancel`,
      headers: tower(),
    });
    assert.equal(cancelled.statusCode, 200, cancelled.payload);
    const [closed] = await recommendations(cancelledTrip.id);
    assert.equal(closed?.status, "resolved");
    assert.equal(closed?.lifecycle, "resolved");
    assert.match(closed?.resolution, /cancelled/);

    const completedTrip = await dispatchTrip(iso(now + 45 * 60_000), iso(now + 100 * 60_000));
    await issue(completedTrip.id, "cargo", "Finish this disruption");
    const completed = await app.inject({
      method: "POST",
      url: `/trips/${completedTrip.id}/complete`,
      headers: tower(),
      payload: {},
    });
    assert.equal(completed.statusCode, 200, completed.payload);
    const [done] = await recommendations(completedTrip.id);
    assert.equal(done?.status, "resolved");
    assert.equal(done?.lifecycle, "resolved");
    assert.match(done?.resolution, /completed/);
  });

  it("does not start a second listener when the app is created again", async () => {
    const before = copilotRuntime();
    const second = await buildApp({ logger: false });
    await second.ready();
    const after = copilotRuntime();
    assert.equal(before.listeners, 1);
    assert.equal(after.listeners, 1);
    assert.equal(after.sweeping, true);
    assert.equal(after.refs, before.refs + 1);
    await second.close();
    const remaining = copilotRuntime();
    assert.equal(remaining.listeners, 1);
    assert.equal(remaining.sweeping, true);
    assert.equal(remaining.refs, before.refs);
  });

  it("retries a processing failure at 5s and 30s, then lets only Tower requeue it", async () => {
    const occurred = new Date().toISOString();
    const inserted = run(
      `INSERT INTO events (type, source, message, payload, occurred_at, recorded_at, trip_id)
       VALUES ('trip.issue', 'manual', 'missing trip', ?, ?, ?, 'trip_missing')`,
      [JSON.stringify({ kind: "breakdown" }), occurred, occurred],
    );
    const eventId = Number(inserted.lastInsertRowid);
    runCopilotSweep();
    const first = one<{ id: string; status: string; attempts: number; next_attempt_at: string; processing_error: string; updated_at: string }>(
      "SELECT id, status, attempts, next_attempt_at, processing_error, updated_at FROM copilot_jobs WHERE event_id = ?",
      [eventId],
    );
    assert.ok(first);
    assert.equal(first.status, "retry");
    assert.equal(first.attempts, 1);
    assert.match(first.processing_error, /not found/i);
    const firstDelay = Date.parse(first.next_attempt_at) - Date.parse(first.updated_at);
    assert.ok(firstDelay >= 4_500 && firstDelay <= 5_500);

    run("UPDATE copilot_jobs SET next_attempt_at = ? WHERE id = ?", [iso(Date.now() - 1000), first.id]);
    runCopilotSweep();
    const second = one<{ status: string; attempts: number; next_attempt_at: string; updated_at: string }>(
      "SELECT status, attempts, next_attempt_at, updated_at FROM copilot_jobs WHERE id = ?",
      [first.id],
    );
    assert.equal(second?.status, "retry");
    assert.equal(second?.attempts, 2);
    const secondDelay = Date.parse(second!.next_attempt_at) - Date.parse(second!.updated_at);
    assert.ok(secondDelay >= 29_000 && secondDelay <= 31_000);

    run("UPDATE copilot_jobs SET next_attempt_at = ? WHERE id = ?", [iso(Date.now() - 1000), first.id]);
    runCopilotSweep();
    const failed = one<{ status: string; attempts: number; processing_error: string }>(
      "SELECT status, attempts, processing_error FROM copilot_jobs WHERE id = ?",
      [first.id],
    );
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.attempts, 3);
    assert.equal(Number(scalar("SELECT COUNT(*) FROM copilot_recommendations WHERE trip_id = 'trip_missing'")), 0);
    const health = JSON.parse((await app.inject({ method: "GET", url: "/health" })).payload);
    assert.ok(health.failedJobs >= 1);
    const jobs = await app.inject({
      method: "GET",
      url: "/copilot/jobs?status=failed",
      headers: tower(),
    });
    assert.equal(jobs.statusCode, 200, jobs.payload);
    const listed = JSON.parse(jobs.payload) as Array<{ id: string; processingError: string | null }>;
    assert.equal(listed.some((job) => job.id === first.id && /not found/i.test(job.processingError ?? "")), true);

    const denied = await app.inject({
      method: "POST",
      url: `/copilot/jobs/${first.id}/retry`,
      headers: { "x-session": warehouseToken },
    });
    assert.equal(denied.statusCode, 403, denied.payload);

    const retried = await app.inject({
      method: "POST",
      url: `/copilot/jobs/${first.id}/retry`,
      headers: tower(),
    });
    assert.equal(retried.statusCode, 200, retried.payload);
    const body = JSON.parse(retried.payload);
    assert.equal(body.attempts, 1);
    assert.equal(body.status, "retry");
    assert.match(body.processingError, /not found/i);
  });

  it("records an undecodable event as a retry instead of leaving it processing", async () => {
    const occurred = new Date().toISOString();
    const inserted = run(
      `INSERT INTO events (type, source, message, payload, occurred_at, recorded_at)
       VALUES ('trip.issue', 'manual', 'poison', 'NOT JSON', ?, ?)`,
      [occurred, occurred],
    );
    const eventId = Number(inserted.lastInsertRowid);
    runCopilotSweep();
    const job = one<{ id: string; status: string; attempts: number; processing_error: string | null }>(
      "SELECT id, status, attempts, processing_error FROM copilot_jobs WHERE event_id = ?",
      [eventId],
    );
    assert.ok(job);
    assert.equal(job.status, "retry");
    assert.equal(job.attempts, 1);
    assert.match(job.processing_error ?? "", /JSON|token/i);
    run("UPDATE copilot_jobs SET status = 'failed', next_attempt_at = NULL WHERE id = ?", [job.id]);
  });
});
