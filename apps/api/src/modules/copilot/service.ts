import {
  CopilotPreconditionsSchema,
  CopilotPrescribedActionSchema,
  type CopilotLifecycle,
  type CopilotPreconditions,
  type CopilotPrescribedAction,
  type CopilotProposedWindow,
  type CopilotRecommendation,
  type CopilotSeverity,
  type DockAppointment,
  type EventRecord,
  type Trip,
} from "@corelogistics/contracts";
import { many, newId, one, run, tx, type Row } from "../../db.js";
import { badRequest, conflict, forbidden, HttpError, must } from "../../errors.js";
import { emit, systemCtx, type Ctx } from "../../events.js";
import {
  assessDockSwap,
  executeDockSwap,
  findAppointmentOverlap,
  findEligibleDockSwap,
  findTripAppointment,
  getAppointment,
  rescheduleAppointment,
  type DockSwapAssessment,
} from "../gate/service.js";
import { getTrip } from "../trips/service.js";

interface Plan {
  actions: CopilotPrescribedAction[];
  preconditions: CopilotPreconditions;
  impactSummary: string;
  /** An appointment exists but no safe action does. The disruption stays pending for a person. */
  review: boolean;
}

class StaleRecommendation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleRecommendation";
  }
}

function emptyPreconditions(evaluatedAt: string): CopilotPreconditions {
  return {
    evaluatedAt,
    trip: null,
    appointment: null,
    dockSwap: null,
    proposedWindow: null,
    manualReviewReason: null,
  };
}

function parsePreconditions(raw: string, createdAt: string): CopilotPreconditions {
  try {
    const parsed = CopilotPreconditionsSchema.safeParse(JSON.parse(raw || "{}"));
    if (parsed.success) return parsed.data;
  } catch {
    // Rows written before revision tracking fall through to a rebuild on apply.
  }
  return emptyPreconditions(createdAt);
}

function parseActions(raw: string): CopilotPrescribedAction[] {
  try {
    const value = JSON.parse(raw || "[]") as unknown;
    if (!Array.isArray(value)) return [];
    const actions: CopilotPrescribedAction[] = [];
    for (const item of value) {
      const parsed = CopilotPrescribedActionSchema.safeParse(item);
      if (parsed.success) actions.push(parsed.data);
    }
    return actions;
  } catch {
    return [];
  }
}

function priorRevisions(id: string): CopilotRecommendation["priorRevisions"] {
  return many<{
    revision: number;
    disruption_event_id: number | null;
    severity: string;
    lifecycle: string;
    root_cause: string;
    created_at: string;
  }>(
    `SELECT revision, disruption_event_id, severity, lifecycle, root_cause, created_at
     FROM copilot_recommendation_revisions WHERE recommendation_id = ? ORDER BY revision ASC`,
    [id],
  ).map((row) => ({
    revision: Number(row.revision),
    disruptionEventId: row.disruption_event_id != null ? Number(row.disruption_event_id) : null,
    severity: row.severity as CopilotSeverity,
    lifecycle: row.lifecycle as CopilotLifecycle,
    rootCause: row.root_cause,
    createdAt: row.created_at,
  }));
}

function triggeringEventIds(id: string): number[] {
  return many<{ event_id: number }>(
    "SELECT event_id FROM copilot_recommendation_events WHERE recommendation_id = ? ORDER BY event_id ASC",
    [id],
  ).map((row) => Number(row.event_id));
}

function toRecommendation(r: Row): CopilotRecommendation {
  return {
    id: r.id,
    disruptionEventId: r.disruption_event_id != null ? Number(r.disruption_event_id) : null,
    revision: Number(r.revision ?? 1),
    severity: r.severity as CopilotSeverity,
    title: r.title,
    rootCause: r.root_cause,
    impactSummary: r.impact_summary,
    prescribedActions: parseActions(r.prescribed_actions),
    preconditions: parsePreconditions(r.preconditions, r.created_at),
    status: r.status as CopilotRecommendation["status"],
    lifecycle: (r.lifecycle ?? "actionable") as CopilotLifecycle,
    triggeringEventIds: triggeringEventIds(r.id),
    resolution: r.resolution ?? null,
    executionError: r.execution_error ?? null,
    priorRevisions: priorRevisions(r.id),
    siteId: r.site_id ?? null,
    tripId: r.trip_id ?? null,
    createdAt: r.created_at,
    appliedAt: r.applied_at ?? null,
    actor: r.actor ?? null,
  };
}

export function listRecommendations(q?: {
  siteId?: string;
  status?: string;
  limit?: number;
}): CopilotRecommendation[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q?.siteId) {
    where.push("site_id = ?");
    params.push(q.siteId);
  }
  if (q?.status) {
    const statuses = q.status.split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
  }
  const limit = q?.limit ?? 50;
  return many(
    `SELECT * FROM copilot_recommendations ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT ?`,
    [...params, limit],
  ).map(toRecommendation);
}

export function getRecommendation(id: string): CopilotRecommendation {
  return toRecommendation(
    must(one("SELECT * FROM copilot_recommendations WHERE id = ?", [id]), "Copilot recommendation"),
  );
}

export function getAutoPilotConfig(): boolean {
  const row = one("SELECT value FROM copilot_config WHERE key = 'auto_pilot'");
  return row ? row.value === "1" : false;
}

export function setAutoPilotConfig(enabled: boolean, ctx: Ctx): boolean {
  return tx(() => {
    const previous = getAutoPilotConfig();
    run("INSERT OR REPLACE INTO copilot_config (key, value) VALUES ('auto_pilot', ?)", [enabled ? "1" : "0"]);
    emit(ctx, {
      type: "copilot.config",
      message: `Auto-pilot ${enabled ? "enabled" : "disabled"}`,
      payload: { autoPilot: enabled, previous, actor: ctx.actor },
    });
    return enabled;
  });
}

function tripFacts(trip: Trip): NonNullable<CopilotPreconditions["trip"]> {
  return {
    id: trip.id,
    status: trip.status,
    destinationSiteId: trip.destinationSiteId,
    plannedDeparture: trip.plannedDeparture,
    plannedArrival: trip.plannedArrival,
    actualDeparture: trip.actualDeparture,
    actualArrival: trip.actualArrival,
    etaAt: trip.etaAt,
  };
}

function appointmentFacts(appt: DockAppointment): NonNullable<CopilotPreconditions["appointment"]> {
  return {
    id: appt.id,
    status: appt.status,
    tripId: appt.tripId,
    siteId: appt.siteId,
    locationId: appt.locationId,
    windowStart: appt.windowStart,
    windowEnd: appt.windowEnd,
  };
}

function swapFacts(assessment: DockSwapAssessment): NonNullable<CopilotPreconditions["dockSwap"]> {
  return {
    visitId: assessment.visitId,
    siteId: assessment.siteId ?? "",
    status: assessment.status ?? "",
    locationId: assessment.locationId,
    locationActive: assessment.locationActive,
    dockFree: assessment.dockFree,
    reservationClear: assessment.reservationClear,
  };
}

function swapAction(assessment: DockSwapAssessment): CopilotPrescribedAction {
  return {
    type: "swap_dock",
    targetId: assessment.visitId,
    description: `Assign ${assessment.dockCode} to waiting truck ${assessment.plate}`,
    payload: {
      visitId: assessment.visitId,
      locationId: assessment.locationId,
      plate: assessment.plate ?? "",
      dockCode: assessment.dockCode ?? "",
    },
  };
}

/**
 * A later window that keeps the booked duration. Missing or unusable trip timing
 * does not invent a delay; the caller asks for manual review instead.
 */
function proposeWindow(
  appt: DockAppointment,
  trip: Trip,
  now: number,
): { kind: "move"; window: CopilotProposedWindow } | { kind: "hold" } | { kind: "review"; reason: string } {
  const origStart = Date.parse(appt.windowStart);
  const origEnd = Date.parse(appt.windowEnd);
  if (!Number.isFinite(origStart) || !Number.isFinite(origEnd) || origEnd <= origStart) {
    return { kind: "review", reason: "Appointment window timestamps are missing or invalid; manual review is required" };
  }
  if (!trip.etaAt || !Number.isFinite(Date.parse(trip.etaAt))) {
    return { kind: "review", reason: "Trip timing is missing or insufficient; manual review is required" };
  }
  const anchorAt = Date.parse(trip.etaAt);
  const duration = origEnd - origStart;
  if (anchorAt <= origEnd) return { kind: "hold" };
  const newStart = Math.max(origStart, anchorAt);
  if (newStart <= now) {
    return { kind: "review", reason: "Trip timing does not yield a future window; manual review is required" };
  }
  return {
    kind: "move",
    window: {
      windowStart: new Date(newStart).toISOString(),
      windowEnd: new Date(newStart + duration).toISOString(),
      durationMs: duration,
      anchor: "eta",
      anchorAt: new Date(anchorAt).toISOString(),
    },
  };
}

function planForTrip(trip: Trip, siteId: string, now = Date.now()): Plan | null {
  const evaluatedAt = new Date(now).toISOString();
  const appt = findTripAppointment(siteId, trip.id);
  const preconditions = emptyPreconditions(evaluatedAt);
  preconditions.trip = tripFacts(trip);

  if (!appt) {
    const swap = findEligibleDockSwap(siteId, { now: evaluatedAt });
    if (!swap) return null;
    preconditions.dockSwap = swapFacts(swap);
    return {
      review: false,
      impactSummary: `Waiting truck ${swap.plate} can use free dock ${swap.dockCode}.`,
      preconditions,
      actions: [swapAction(swap)],
    };
  }

  preconditions.appointment = appointmentFacts(appt);
  if (appt.status !== "scheduled") {
    const reason = `Appointment ${appt.code} is ${appt.status}; manual review is required`;
    preconditions.manualReviewReason = reason;
    return { review: true, impactSummary: reason, preconditions, actions: [] };
  }

  const proposal = proposeWindow(appt, trip, now);
  let proposed: CopilotProposedWindow | null = null;
  if (proposal.kind === "review") {
    preconditions.manualReviewReason = proposal.reason;
  } else if (proposal.kind === "move") {
    const clash = appt.locationId
      ? findAppointmentOverlap(appt.siteId, appt.locationId, proposal.window.windowStart, proposal.window.windowEnd, appt.id)
      : undefined;
    if (clash) {
      preconditions.manualReviewReason = `Proposed window overlaps appointment ${clash.code}; manual review is required`;
    } else {
      proposed = proposal.window;
      preconditions.proposedWindow = proposed;
    }
  }

  const swap = appt.locationId
    ? findEligibleDockSwap(siteId, {
        locationId: appt.locationId,
        ignoreAppointmentId: proposed ? appt.id : undefined,
        now: evaluatedAt,
      })
    : null;
  if (swap) preconditions.dockSwap = swapFacts(swap);

  const actions: CopilotPrescribedAction[] = [];
  if (swap) actions.push(swapAction(swap));
  if (proposed) {
    actions.push({
      type: "reschedule_appointment",
      targetId: appt.id,
      description: `Move ${trip.code} dock window to ${proposed.windowStart} – ${proposed.windowEnd} without changing its duration`,
      payload: {
        appointmentId: appt.id,
        newWindowStart: proposed.windowStart,
        newWindowEnd: proposed.windowEnd,
      },
    });
  }

  if (!actions.length && !preconditions.manualReviewReason) return null;
  let impactSummary = preconditions.manualReviewReason ?? "";
  if (proposed && swap) {
    impactSummary = `Trip ${trip.code} misses its dock window. ${swap.plate} can take ${swap.dockCode}; the appointment keeps its duration and moves later.`;
  } else if (proposed) {
    impactSummary = `Trip ${trip.code} misses its dock window. The appointment keeps its duration and moves to ${proposed.windowStart}.`;
  } else if (swap) {
    impactSummary = `Waiting truck ${swap.plate} can use ${swap.dockCode} while ${trip.code} is disrupted.`;
  }
  return { actions, preconditions, impactSummary, review: actions.length === 0 };
}

const SEVERITY_RANK: Record<CopilotSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function severityOf(event: EventRecord): CopilotSeverity {
  if (event.type !== "trip.issue") return "medium";
  const kind = String(event.payload?.kind ?? "delay");
  if (kind === "breakdown" || kind === "accident") return "critical";
  if (kind === "seal_breach" || kind === "traffic") return "high";
  return "medium";
}

function higherSeverity(current: CopilotSeverity, incoming: CopilotSeverity): CopilotSeverity {
  return SEVERITY_RANK[incoming] > SEVERITY_RANK[current] ? incoming : current;
}

const REVIEW_EXPLANATION = "No safe automatic action; the disruption stays open for manual review";

function reviewPlan(trip: Trip, reason: string): Plan {
  const preconditions = emptyPreconditions(new Date().toISOString());
  preconditions.trip = tripFacts(trip);
  preconditions.manualReviewReason = reason;
  return { review: true, actions: [], preconditions, impactSummary: reason };
}

function planOrReview(trip: Trip, siteId: string): Plan {
  return planForTrip(trip, siteId) ?? reviewPlan(trip, REVIEW_EXPLANATION);
}

function lifecycleFor(actions: CopilotPrescribedAction[]): "actionable" | "human_review" {
  return actions.length ? "actionable" : "human_review";
}

function canAutoApply(rec: CopilotRecommendation): boolean {
  if (!getAutoPilotConfig()) return false;
  if (rec.severity !== "low" && rec.severity !== "medium") return false;
  if (!rec.prescribedActions.length) return false;
  return rec.prescribedActions.every((action) => action.type === "reschedule_appointment");
}

function assertAutoPolicy(rec: CopilotRecommendation, actions: CopilotPrescribedAction[]): void {
  if (rec.severity === "high" || rec.severity === "critical") {
    throw forbidden("High and critical disruptions require Tower approval");
  }
  if (!actions.length || actions.some((action) => action.type !== "reschedule_appointment")) {
    throw forbidden("Auto-pilot can run only validated appointment reschedules");
  }
}

/** Stored facts against the database. The proposed window must still cover the live ETA. */
function factsHold(rec: CopilotRecommendation, actions: CopilotPrescribedAction[]): boolean {
  const stored = rec.preconditions;
  if (rec.tripId && !stored.trip) return false;
  if (stored.trip) {
    if (stored.trip.id !== rec.tripId) return false;
    const trip = getTrip(stored.trip.id);
    if (trip.status !== stored.trip.status) return false;
    if (trip.destinationSiteId !== stored.trip.destinationSiteId) return false;
    if (trip.plannedDeparture !== stored.trip.plannedDeparture) return false;
    if (trip.plannedArrival !== stored.trip.plannedArrival) return false;
    if ((trip.actualDeparture ?? null) !== (stored.trip.actualDeparture ?? null)) return false;
    if ((trip.actualArrival ?? null) !== (stored.trip.actualArrival ?? null)) return false;
    if (stored.proposedWindow) {
      const liveEta = trip.etaAt ? Date.parse(trip.etaAt) : NaN;
      const proposedEnd = Date.parse(stored.proposedWindow.windowEnd);
      if (!Number.isFinite(liveEta) || !Number.isFinite(proposedEnd) || liveEta >= proposedEnd) return false;
    }
  }

  const swaps = actions.filter((action) => action.type === "swap_dock");
  const moves = actions.filter((action) => action.type === "reschedule_appointment");
  if (swaps.length !== (stored.dockSwap ? 1 : 0)) return false;
  if (moves.length !== (stored.proposedWindow ? 1 : 0)) return false;

  if (stored.appointment) {
    let appt: DockAppointment;
    try {
      appt = getAppointment(stored.appointment.id);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) return false;
      throw err;
    }
    if (appt.status !== stored.appointment.status) return false;
    if (appt.tripId !== stored.appointment.tripId) return false;
    if (appt.siteId !== stored.appointment.siteId) return false;
    if (appt.locationId !== stored.appointment.locationId) return false;
    if (appt.windowStart !== stored.appointment.windowStart) return false;
    if (appt.windowEnd !== stored.appointment.windowEnd) return false;
    if (stored.proposedWindow) {
      const start = Date.parse(stored.proposedWindow.windowStart);
      const end = Date.parse(stored.proposedWindow.windowEnd);
      const origStart = Date.parse(appt.windowStart);
      const origEnd = Date.parse(appt.windowEnd);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
      if (end - start !== stored.proposedWindow.durationMs) return false;
      if (end - start !== origEnd - origStart) return false;
      if (start < origStart || start <= Date.now()) return false;
      if (appt.locationId) {
        const clash = findAppointmentOverlap(
          appt.siteId,
          appt.locationId,
          stored.proposedWindow.windowStart,
          stored.proposedWindow.windowEnd,
          appt.id,
        );
        if (clash) return false;
      }
      const move = moves[0];
      if (!move || move.payload.appointmentId !== appt.id) return false;
      if (move.payload.newWindowStart !== stored.proposedWindow.windowStart) return false;
      if (move.payload.newWindowEnd !== stored.proposedWindow.windowEnd) return false;
    }
  } else if (moves.length) {
    return false;
  }

  if (stored.dockSwap) {
    const swap = swaps[0];
    if (!swap || swap.payload.visitId !== stored.dockSwap.visitId || swap.payload.locationId !== stored.dockSwap.locationId) {
      return false;
    }
    const live = assessDockSwap(stored.dockSwap.visitId, stored.dockSwap.locationId, {
      ignoreAppointmentId: stored.proposedWindow && stored.appointment ? stored.appointment.id : undefined,
    });
    if (!live.eligible || live.status !== stored.dockSwap.status || live.siteId !== stored.dockSwap.siteId) return false;
  }
  return true;
}

function readRawActions(id: string): unknown[] {
  const row = must(
    one<{ prescribed_actions: string }>("SELECT prescribed_actions FROM copilot_recommendations WHERE id = ?", [id]),
    "Copilot recommendation",
  );
  let value: unknown;
  try {
    value = JSON.parse(row.prescribed_actions || "[]");
  } catch {
    throw badRequest("Unsupported or invalid copilot action");
  }
  if (!Array.isArray(value)) throw badRequest("Unsupported or invalid copilot action");
  return value;
}

function parseExecutable(raw: unknown[]): CopilotPrescribedAction[] {
  return raw.map((item) => {
    const parsed = CopilotPrescribedActionSchema.safeParse(item);
    if (!parsed.success) {
      const type =
        item && typeof item === "object" && "type" in item ? String((item as { type: unknown }).type) : "unknown";
      throw badRequest(`Unsupported or invalid copilot action: ${type}`);
    }
    return parsed.data;
  });
}

function linkEvent(recommendationId: string, eventId: number) {
  run("INSERT OR IGNORE INTO copilot_recommendation_events (recommendation_id, event_id) VALUES (?, ?)", [
    recommendationId,
    eventId,
  ]);
}

function recommendationIdForEvent(eventId: number): string | undefined {
  return one<{ recommendation_id: string }>(
    "SELECT recommendation_id FROM copilot_recommendation_events WHERE event_id = ?",
    [eventId],
  )?.recommendation_id;
}

function archiveRevision(rec: CopilotRecommendation) {
  run(
    `INSERT OR IGNORE INTO copilot_recommendation_revisions
       (recommendation_id, revision, disruption_event_id, severity, lifecycle, root_cause, impact_summary, prescribed_actions, preconditions, created_at)
     VALUES (?, ?, ?, ?, 'superseded', ?, ?, ?, ?, ?)`,
    [
      rec.id,
      rec.revision,
      rec.disruptionEventId,
      rec.severity,
      rec.rootCause,
      rec.impactSummary,
      JSON.stringify(rec.prescribedActions),
      JSON.stringify(rec.preconditions),
      rec.preconditions.evaluatedAt || rec.createdAt,
    ],
  );
}

function insertRecommendation(
  event: EventRecord,
  trip: Trip,
  siteId: string,
  severity: CopilotSeverity,
  plan: Plan,
): CopilotRecommendation {
  return tx(() => {
    const linked = recommendationIdForEvent(event.id);
    if (linked) return getRecommendation(linked);
    const id = newId("cop");
    const now = new Date().toISOString();
    const title = `Disruption detected for ${trip.code}`;
    const lifecycle = lifecycleFor(plan.actions);
    run(
      `INSERT INTO copilot_recommendations
         (id, disruption_event_id, severity, title, root_cause, impact_summary, prescribed_actions, preconditions, revision, status, lifecycle, site_id, trip_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?)`,
      [
        id,
        event.id,
        severity,
        title,
        event.message,
        plan.impactSummary,
        JSON.stringify(plan.actions),
        JSON.stringify(plan.preconditions),
        lifecycle,
        siteId,
        trip.id,
        now,
      ],
    );
    linkEvent(id, event.id);
    const rec = getRecommendation(id);
    emit(systemCtx, {
      type: "copilot.recommendation",
      siteId,
      tripId: trip.id,
      entityId: id,
      message: `Copilot: ${title}`,
      payload: { recommendationId: id, revision: rec.revision, severity, lifecycle, actor: null },
    });
    return rec;
  });
}

function refreshRecommendation(id: string, ctx: Ctx): CopilotRecommendation {
  return tx(() => {
    const rec = getRecommendation(id);
    if (rec.status !== "pending" || !rec.tripId) return rec;
    const raw = readRawActions(id);
    let actions: CopilotPrescribedAction[] = [];
    try {
      actions = parseExecutable(raw);
    } catch {
      actions = rec.prescribedActions;
    }
    if (factsHold(rec, actions.length ? actions : rec.prescribedActions)) return rec;
    const trip = getTrip(rec.tripId);
    const plan = planOrReview(trip, rec.siteId ?? trip.destinationSiteId);
    archiveRevision(rec);
    const next = rec.revision + 1;
    const impact = plan.impactSummary;
    const nextActions = plan.actions;
    const nextPreconditions = plan.preconditions;
    const lifecycle = lifecycleFor(nextActions);
    run(
      `UPDATE copilot_recommendations
       SET prescribed_actions = ?, preconditions = ?, impact_summary = ?, revision = ?, lifecycle = ?
       WHERE id = ? AND status = 'pending'`,
      [JSON.stringify(nextActions), JSON.stringify(nextPreconditions), impact, next, lifecycle, id],
    );
    emit(ctx, {
      type: "copilot.recommendation",
      siteId: rec.siteId,
      tripId: rec.tripId,
      entityId: id,
      message: `Copilot recommendation refreshed to revision ${next}`,
      payload: { recommendationId: id, revision: next, refreshed: true, severity: rec.severity, actor: ctx.actor },
    });
    return getRecommendation(id);
  });
}

function auditExecutionFailure(id: string, ctx: Ctx, err: unknown): void {
  try {
    const row = one<{ site_id: string | null; trip_id: string | null; revision: number | null }>(
      "SELECT site_id, trip_id, revision FROM copilot_recommendations WHERE id = ?",
      [id],
    );
    const message = err instanceof Error ? err.message : "Copilot execution failed";
    run("UPDATE copilot_recommendations SET execution_error = ? WHERE id = ?", [message, id]);
    emit(ctx, {
      type: "copilot.failed",
      siteId: row?.site_id ?? null,
      tripId: row?.trip_id ?? null,
      entityId: id,
      message: `Copilot execution failed: ${message}`,
      payload: {
        recommendationId: id,
        revision: row?.revision != null ? Number(row.revision) : null,
        actor: ctx.actor,
        error: message,
      },
    });
  } catch {
    // The original failure is what the caller must see.
  }
}

function isStale(err: unknown): boolean {
  return err instanceof StaleRecommendation || (err instanceof HttpError && err.statusCode === 409);
}

function executeActions(rec: CopilotRecommendation, actions: CopilotPrescribedAction[], ctx: Ctx): void {
  const rescheduled = new Set(
    actions.filter((action) => action.type === "reschedule_appointment").map((action) => action.payload.appointmentId),
  );
  for (const action of actions) {
    if (action.type === "reschedule_appointment") {
      const expected = rec.preconditions.appointment;
      if (!expected || expected.id !== action.payload.appointmentId) {
        throw conflict("Appointment preconditions no longer match this recommendation");
      }
      rescheduleAppointment(
        action.payload.appointmentId,
        action.payload.newWindowStart,
        action.payload.newWindowEnd,
        { tripId: expected.tripId, siteId: expected.siteId, locationId: expected.locationId },
        ctx,
      );
    } else if (action.type === "swap_dock") {
      const ignore =
        rec.preconditions.appointment && rescheduled.has(rec.preconditions.appointment.id)
          ? rec.preconditions.appointment.id
          : undefined;
      executeDockSwap(action.payload.visitId, action.payload.locationId, ctx, { ignoreAppointmentId: ignore });
    } else {
      throw badRequest("Unsupported or invalid copilot action");
    }
  }
}

export function applyRecommendation(id: string, revision: number, ctx: Ctx, auto = false): CopilotRecommendation {
  let audit = false;
  try {
    return tx(() => {
      const rec = getRecommendation(id);
      if (rec.status !== "pending") throw badRequest(`Recommendation is already ${rec.status}`);
      if (rec.revision !== revision) {
        throw new StaleRecommendation(`Recommendation changed; review revision ${rec.revision}`);
      }
      audit = true;
      const actions = parseExecutable(readRawActions(id));
      if (!factsHold(rec, actions)) {
        throw new StaleRecommendation("Recommendation preconditions changed");
      }
      if (!actions.length) throw badRequest("Recommendation has no executable action");
      if (auto) assertAutoPolicy(rec, actions);
      executeActions(rec, actions, ctx);
      const when = new Date().toISOString();
      const nextStatus = auto ? "auto_applied" : "applied";
      run(
        `UPDATE copilot_recommendations SET status = ?, lifecycle = ?, applied_at = ?, actor = ?, execution_error = NULL WHERE id = ?`,
        [nextStatus, nextStatus, when, ctx.actor, id],
      );
      emit(ctx, {
        type: "copilot.applied",
        siteId: rec.siteId,
        tripId: rec.tripId,
        entityId: id,
        message: `Copilot resolution ${nextStatus} for ${rec.title}`,
        payload: {
          recommendationId: id,
          revision: rec.revision,
          auto,
          actor: ctx.actor,
          actions: actions.map((action) => ({ type: action.type, targetId: action.targetId })),
        },
      });
      return getRecommendation(id);
    });
  } catch (err) {
    if (isStale(err)) {
      const updated = refreshRecommendation(id, ctx);
      throw conflict(`Recommendation changed; review revision ${updated.revision}`);
    }
    if (audit) auditExecutionFailure(id, ctx, err);
    throw err;
  }
}

export function dismissRecommendation(id: string, revision: number, ctx: Ctx): CopilotRecommendation {
  try {
    return tx(() => {
      const rec = getRecommendation(id);
      if (rec.status !== "pending") throw badRequest(`Recommendation is already ${rec.status}`);
      if (rec.revision !== revision) {
        throw new StaleRecommendation(`Recommendation changed; review revision ${rec.revision}`);
      }
      const actions = parseActions(
        one<{ prescribed_actions: string }>("SELECT prescribed_actions FROM copilot_recommendations WHERE id = ?", [id])
          ?.prescribed_actions ?? "[]",
      );
      if (!factsHold(rec, actions)) throw new StaleRecommendation("Recommendation preconditions changed");
      run(
        "UPDATE copilot_recommendations SET status = 'dismissed', lifecycle = 'dismissed', actor = ? WHERE id = ?",
        [ctx.actor, id],
      );
      emit(ctx, {
        type: "copilot.dismissed",
        siteId: rec.siteId,
        tripId: rec.tripId,
        entityId: id,
        message: `Copilot recommendation dismissed: ${rec.title}`,
        payload: { recommendationId: id, revision: rec.revision, actor: ctx.actor, severity: rec.severity },
      });
      return getRecommendation(id);
    });
  } catch (err) {
    if (isStale(err)) {
      const updated = refreshRecommendation(id, ctx);
      throw conflict(`Recommendation changed; review revision ${updated.revision}`);
    }
    throw err;
  }
}

function findOpen(tripId: string): CopilotRecommendation | null {
  const row = one<{ id: string }>(
    "SELECT id FROM copilot_recommendations WHERE trip_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    [tripId],
  );
  return row ? getRecommendation(row.id) : null;
}

function markResolved(id: string, resolution: string, event: EventRecord | null) {
  run(
    `UPDATE copilot_recommendations
     SET status = 'resolved', lifecycle = 'resolved', resolution = ?,
         disruption_event_id = COALESCE(?, disruption_event_id)
     WHERE id = ? AND status = 'pending'`,
    [resolution, event?.id ?? null, id],
  );
  if (event) linkEvent(id, event.id);
}

function resolveOpen(event: EventRecord): CopilotRecommendation | null {
  if (!event.tripId) return null;
  const open = findOpen(event.tripId);
  if (!open) return null;
  let label = event.tripId;
  let status = event.type === "trip.completed" ? "completed" : "cancelled";
  try {
    const trip = getTrip(event.tripId);
    label = trip.code;
    status = trip.status;
  } catch {
    // The lifecycle event is still enough to close the open recommendation.
  }
  const resolution = `Trip ${label} is ${status}; the recommendation is resolved`;
  return tx(() => {
    const current = getRecommendation(open.id);
    if (current.status !== "pending") return current;
    const linked = recommendationIdForEvent(event.id);
    if (linked) return getRecommendation(linked);
    markResolved(current.id, resolution, event);
    return getRecommendation(current.id);
  });
}

function reviseOpen(
  rec: CopilotRecommendation,
  event: EventRecord,
  trip: Trip,
  opts: { escalate: boolean; updateCause: boolean },
): CopilotRecommendation {
  const plan = planOrReview(trip, rec.siteId ?? trip.destinationSiteId);
  const severity = opts.escalate ? higherSeverity(rec.severity, severityOf(event)) : rec.severity;
  const rootCause = opts.updateCause ? event.message : rec.rootCause;
  return tx(() => {
    const current = getRecommendation(rec.id);
    if (current.status !== "pending") return current;
    const linked = recommendationIdForEvent(event.id);
    if (linked) return getRecommendation(linked);
    archiveRevision(current);
    const next = current.revision + 1;
    const lifecycle = lifecycleFor(plan.actions);
    run(
      `UPDATE copilot_recommendations
       SET disruption_event_id = ?, severity = ?, root_cause = ?, impact_summary = ?,
           prescribed_actions = ?, preconditions = ?, revision = ?, lifecycle = ?, execution_error = NULL
       WHERE id = ? AND status = 'pending'`,
      [
        event.id,
        severity,
        rootCause,
        plan.impactSummary,
        JSON.stringify(plan.actions),
        JSON.stringify(plan.preconditions),
        next,
        lifecycle,
        rec.id,
      ],
    );
    linkEvent(rec.id, event.id);
    emit(systemCtx, {
      type: "copilot.recommendation",
      siteId: current.siteId,
      tripId: current.tripId,
      entityId: rec.id,
      message: `Copilot recommendation refreshed to revision ${next}`,
      payload: { recommendationId: rec.id, revision: next, refreshed: true, severity, actor: null },
    });
    return getRecommendation(rec.id);
  });
}

function maybeAuto(rec: CopilotRecommendation): CopilotRecommendation {
  if (rec.status !== "pending" || !canAutoApply(rec)) return rec;
  try {
    return applyRecommendation(rec.id, rec.revision, systemCtx, true);
  } catch {
    return getRecommendation(rec.id);
  }
}

function upsertFromEvent(
  event: EventRecord,
  trip: Trip,
  opts: { escalate: boolean; updateCause: boolean },
): CopilotRecommendation {
  const open = findOpen(trip.id);
  const rec = open
    ? reviseOpen(open, event, trip, opts)
    : insertRecommendation(event, trip, trip.destinationSiteId, severityOf(event), planOrReview(trip, trip.destinationSiteId));
  return maybeAuto(rec);
}

const REEVALUATE = new Set([
  "trip.dispatched",
  "trip.departed",
  "trip.arrived",
  "trip.stop_arrived",
  "trip.stop_departed",
]);

/** Evaluates one source event. The same event id never creates a second revision. */
export function evaluateDisruption(event: EventRecord): CopilotRecommendation | null {
  const already = recommendationIdForEvent(event.id);
  if (already) return getRecommendation(already);
  if (!event.tripId) return null;

  if (event.type === "trip.cancelled" || event.type === "trip.completed") {
    return resolveOpen(event);
  }
  if (event.type === "trip.issue") {
    return upsertFromEvent(event, getTrip(event.tripId), { escalate: true, updateCause: true });
  }
  if (event.type === "trip.updated") {
    const trip = getTrip(event.tripId);
    if (!findOpen(trip.id) && !trip.delayed) return null;
    return upsertFromEvent(event, trip, { escalate: false, updateCause: false });
  }
  if (REEVALUATE.has(event.type)) {
    if (!findOpen(event.tripId)) return null;
    return upsertFromEvent(event, getTrip(event.tripId), { escalate: false, updateCause: false });
  }
  return null;
}

/** First install closes recommendations whose trip has already ended, and refreshes the rest. */
export function revalidatePendingRecommendations(): void {
  const rows = many<{ id: string }>("SELECT id FROM copilot_recommendations WHERE status = 'pending'");
  for (const row of rows) {
    try {
      const rec = getRecommendation(row.id);
      if (!rec.tripId) continue;
      const trip = getTrip(rec.tripId);
      if (trip.status === "cancelled" || trip.status === "completed") {
        markResolved(rec.id, `Trip ${trip.code} is ${trip.status}; the recommendation is resolved`, null);
        continue;
      }
      const refreshed = refreshRecommendation(rec.id, systemCtx);
      if (refreshed.status === "pending" && refreshed.prescribedActions.length === 0 && refreshed.lifecycle !== "human_review") {
        run("UPDATE copilot_recommendations SET lifecycle = 'human_review' WHERE id = ? AND status = 'pending'", [
          refreshed.id,
        ]);
      }
    } catch {
      // One unreadable recommendation must not stop the worker from starting.
    }
  }
}
