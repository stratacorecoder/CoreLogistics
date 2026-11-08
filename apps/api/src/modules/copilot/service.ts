import {
  type CopilotConfig,
  type CopilotPrescribedAction,
  type CopilotRecommendation,
  type CopilotSeverity,
  type EventRecord,
} from "@corelogistics/contracts";
import { many, newId, nowIso, one, run, toBool, tx, type Row } from "../../db.js";
import { badRequest, must, notFound } from "../../errors.js";
import { at, emit, subscribe, systemCtx, type Ctx } from "../../events.js";
import { assignDock, getVisit } from "../gate/service.js";
import { getLocation, getSite } from "../sites/service.js";
import { getTrip } from "../trips/service.js";

function toRecommendation(r: Row): CopilotRecommendation {
  return {
    id: r.id,
    disruptionEventId: r.disruption_event_id != null ? Number(r.disruption_event_id) : null,
    severity: r.severity as CopilotSeverity,
    title: r.title,
    rootCause: r.root_cause,
    impactSummary: r.impact_summary,
    prescribedActions: JSON.parse(r.prescribed_actions || "[]") as CopilotPrescribedAction[],
    status: r.status as CopilotRecommendation["status"],
    siteId: r.site_id ?? null,
    tripId: r.trip_id ?? null,
    createdAt: r.created_at,
    appliedAt: r.applied_at ?? null,
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
  const r = one("SELECT value FROM copilot_config WHERE key = 'auto_pilot'");
  return r ? r.value === "1" : false;
}

export function setAutoPilotConfig(enabled: boolean): boolean {
  run("INSERT OR REPLACE INTO copilot_config (key, value) VALUES ('auto_pilot', ?)", [enabled ? "1" : "0"]);
  return enabled;
}

/** Evaluates an incoming disruption event and generates actionable recommendations. */
export function evaluateDisruption(e: EventRecord): CopilotRecommendation | null {
  // Only evaluate relevant disruption types
  if (e.type !== "trip.issue" && e.type !== "trip.updated") {
    return null;
  }
  if (!e.tripId) return null;

  const trip = getTrip(e.tripId);
  if (e.type === "trip.updated" && !trip.delayed) {
    return null;
  }

  const destSite = getSite(trip.destinationSiteId);
  const siteId = destSite.id;

  // Deduplicate: avoid creating stacked duplicate pending recommendations for the same trip & site
  const existingPending = one(
    "SELECT id FROM copilot_recommendations WHERE trip_id = ? AND site_id = ? AND status = 'pending' LIMIT 1",
    [trip.id, siteId],
  );
  if (existingPending) return null;

  // Check if an open scheduled dock appointment exists for this trip at the destination site
  const appt = one(
    `SELECT da.*, l.code AS location_code FROM dock_appointments da
     LEFT JOIN locations l ON l.id = da.location_id
     WHERE da.site_id = ? AND da.trip_id = ? AND da.status = 'scheduled'
     LIMIT 1`,
    [siteId, trip.id],
  );

  // Check if there is an idle/available truck in the yard that can be swapped in
  const waitingYardVisit = one(
    `SELECT gv.*, v.plate, v.code AS vehicle_code FROM gate_visits gv
     JOIN vehicles v ON v.id = gv.vehicle_id
     WHERE gv.site_id = ? AND gv.status = 'in_yard'
     ORDER BY gv.check_in_at ASC LIMIT 1`,
    [siteId],
  );

  const actions: CopilotPrescribedAction[] = [];
  let title = `Disruption detected for ${trip.code}`;
  let rootCause = e.message;
  let impactSummary = `Trip ${trip.code} is delayed.`;
  let severity: CopilotSeverity = "medium";

  if (e.type === "trip.issue") {
    const kind = String(e.payload?.kind ?? "delay");
    if (kind === "breakdown" || kind === "accident") {
      severity = "critical";
    } else if (kind === "seal_breach" || kind === "traffic") {
      severity = "high";
    }
  }

  // 1. If truck had a dock appointment and a truck is waiting in yard, prescribe dock swap & reschedule if dock is free
  const isDockOccupied = appt?.location_id
    ? Boolean(one("SELECT 1 FROM dock_assignments WHERE location_id = ? AND released_at IS NULL", [appt.location_id]))
    : false;

  if (appt && appt.location_id && !isDockOccupied && waitingYardVisit) {
    const dockCode = appt.location_code ?? "dock";
    impactSummary = `Trip ${trip.code} will miss ${dockCode} appointment. Yard truck ${waitingYardVisit.plate} is waiting.`;
    actions.push({
      type: "swap_dock",
      targetId: String(waitingYardVisit.id),
      description: `Assign ${dockCode} immediately to waiting truck ${waitingYardVisit.plate}`,
      payload: {
        visitId: waitingYardVisit.id,
        locationId: appt.location_id,
        plate: waitingYardVisit.plate,
        dockCode,
      },
    });

    const origStart = Date.parse(String(appt.window_start));
    const origEnd = Date.parse(String(appt.window_end));
    const duration = isNaN(origEnd - origStart) ? 60 * 60_000 : origEnd - origStart;
    const newStartIso = new Date(Date.now() + 60 * 60_000).toISOString();
    const newEndIso = new Date(Date.now() + 60 * 60_000 + duration).toISOString();

    actions.push({
      type: "reschedule_appointment",
      targetId: String(appt.id),
      description: `Push ${trip.code} dock window back by 60 minutes to ${newStartIso.slice(11, 16)}`,
      payload: {
        appointmentId: appt.id,
        newWindowStart: newStartIso,
        newWindowEnd: newEndIso,
      },
    });
  } else if (appt) {
    // Just reschedule appointment window
    const origStart = Date.parse(String(appt.window_start));
    const origEnd = Date.parse(String(appt.window_end));
    const duration = isNaN(origEnd - origStart) ? 60 * 60_000 : origEnd - origStart;
    const newStartIso = new Date(Date.now() + 45 * 60_000).toISOString();
    const newEndIso = new Date(Date.now() + 45 * 60_000 + duration).toISOString();

    impactSummary = `Trip ${trip.code} delay causes dock appointment overlap at ${destSite.name}.`;
    actions.push({
      type: "reschedule_appointment",
      targetId: String(appt.id),
      description: `Postpone appointment window to ${newStartIso.slice(11, 16)} - ${newEndIso.slice(11, 16)}`,
      payload: {
        appointmentId: appt.id,
        newWindowStart: newStartIso,
        newWindowEnd: newEndIso,
      },
    });
  } else if (waitingYardVisit) {
    // Free dock suggestion for yard truck
    const freeDock = one(
      `SELECT id, code FROM locations
       WHERE site_id = ? AND kind = 'dock_door' AND active = 1
         AND id NOT IN (SELECT location_id FROM dock_assignments WHERE released_at IS NULL)
       LIMIT 1`,
      [siteId],
    );
    if (freeDock) {
      impactSummary = `Transit disruption frees capacity. Waiting truck ${waitingYardVisit.plate} can dock at ${freeDock.code}.`;
      actions.push({
        type: "swap_dock",
        targetId: String(waitingYardVisit.id),
        description: `Direct waiting truck ${waitingYardVisit.plate} to ${freeDock.code}`,
        payload: {
          visitId: waitingYardVisit.id,
          locationId: freeDock.id,
          plate: waitingYardVisit.plate,
          dockCode: freeDock.code,
        },
      });
    }
  }

  if (actions.length === 0) return null;

  const id = newId("cop");
  const now = nowIso();
  run(
    `INSERT INTO copilot_recommendations (id, disruption_event_id, severity, title, root_cause, impact_summary, prescribed_actions, status, site_id, trip_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [
      id,
      e.id,
      severity,
      title,
      rootCause,
      impactSummary,
      JSON.stringify(actions),
      siteId,
      trip.id,
      now,
    ],
  );

  const rec = getRecommendation(id);

  emit(systemCtx, {
    type: "copilot.recommendation",
    siteId,
    tripId: trip.id,
    entityId: id,
    message: `Copilot: ${title}`,
    payload: { recommendationId: id, severity },
  });

  // If Auto-Pilot is enabled and not critical, auto-apply immediately
  if (getAutoPilotConfig()) {
    try {
      return applyRecommendation(id, systemCtx, true);
    } catch {
      // Fallback: remains pending for manual review
    }
  }

  return rec;
}

export function applyRecommendation(id: string, ctx: Ctx, auto = false): CopilotRecommendation {
  return tx(() => {
    const rec = getRecommendation(id);
    if (rec.status !== "pending") throw badRequest(`Recommendation is already ${rec.status}`);

    const when = at(ctx);
    for (const action of rec.prescribedActions) {
      if (action.type === "swap_dock") {
        const visitId = String(action.payload.visitId);
        const locationId = String(action.payload.locationId);
        assignDock(visitId, { locationId }, ctx);
      } else if (action.type === "reschedule_appointment") {
        const apptId = String(action.payload.appointmentId);
        const newStart = String(action.payload.newWindowStart);
        const newEnd = String(action.payload.newWindowEnd);
        run(
          `UPDATE dock_appointments SET window_start = ?, window_end = ? WHERE id = ?`,
          [newStart, newEnd, apptId],
        );
      }
    }

    const nextStatus = auto ? "auto_applied" : "applied";
    run(
      `UPDATE copilot_recommendations SET status = ?, applied_at = ? WHERE id = ?`,
      [nextStatus, when, id],
    );

    emit(ctx, {
      type: "copilot.applied",
      siteId: rec.siteId,
      tripId: rec.tripId,
      entityId: id,
      message: `Copilot resolution ${nextStatus} for ${rec.title}`,
      payload: { recommendationId: id, auto },
    });

    return getRecommendation(id);
  });
}

export function dismissRecommendation(id: string, ctx: Ctx): CopilotRecommendation {
  const rec = getRecommendation(id);
  if (rec.status !== "pending") throw badRequest(`Recommendation is already ${rec.status}`);
  run("UPDATE copilot_recommendations SET status = 'dismissed' WHERE id = ?", [id]);
  return getRecommendation(id);
}

let unsubscribeFn: (() => void) | null = null;

export function initCopilot(): () => void {
  if (unsubscribeFn) return unsubscribeFn;
  unsubscribeFn = subscribe((event) => {
    try {
      evaluateDisruption(event);
    } catch (err) {
      // Background evaluation failure must not crash SSE or DB writes
    }
  });
  return unsubscribeFn;
}
