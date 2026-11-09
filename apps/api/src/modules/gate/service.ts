import {
  AssignDockInputSchema,
  CheckInInputSchema,
  CheckOutInputSchema,
  DockAppointmentInputSchema,
  minutesBetween,
  VisitQuerySchema,
  type DockAppointment,
  type DockPurpose,
  type DockSuggestion,
  type ExpectedTrip,
  type GateVisit,
} from "@corelogistics/contracts";
import type { z } from "zod";
import { many, newId, nextCode, one, run, tx, type Row } from "../../db.js";
import { badRequest, conflict, HttpError, must, notFound } from "../../errors.js";
import { at, emit, type Ctx } from "../../events.js";
import { findVehicleByPlate, getVehicle, refreshVehicleStatus } from "../fleet/service.js";
import { getLocation, getSite } from "../sites/service.js";
import { arriveTrip, completeTrip, departTrip, getTrip, hydrateTrips } from "../trips/service.js";
import { ensureReceiptForVisit } from "../warehouse/service.js";

const VISIT_SELECT = `
  SELECT gv.*, v.kind AS vehicle_kind, t.code AS trip_code, y.code AS yard_code,
         d.id AS dock_assignment_id, d.location_id AS dock_location_id, dl.code AS dock_code,
         d.purpose AS dock_purpose, d.assigned_at AS dock_assigned_at
  FROM gate_visits gv
  JOIN vehicles v ON v.id = gv.vehicle_id
  LEFT JOIN trips t ON t.id = gv.trip_id
  LEFT JOIN locations y ON y.id = gv.yard_location_id
  LEFT JOIN dock_assignments d ON d.visit_id = gv.id AND d.released_at IS NULL
  LEFT JOIN locations dl ON dl.id = d.location_id`;

function toVisit(r: Row): GateVisit {
  return {
    id: r.id,
    siteId: r.site_id,
    vehicleId: r.vehicle_id,
    plate: r.plate,
    vehicleKind: r.vehicle_kind,
    tripId: r.trip_id ?? null,
    tripCode: r.trip_code ?? null,
    status: r.status,
    checkInAt: r.check_in_at,
    checkOutAt: r.check_out_at ?? null,
    yardLocationId: r.yard_location_id ?? null,
    yardCode: r.yard_code ?? null,
    sealIn: r.seal_in,
    sealOut: r.seal_out,
    notes: r.notes,
    sourceIn: r.source_in,
    sourceOut: r.source_out ?? null,
    dock: r.dock_assignment_id
      ? {
          assignmentId: r.dock_assignment_id,
          locationId: r.dock_location_id,
          code: r.dock_code,
          purpose: r.dock_purpose,
          assignedAt: r.dock_assigned_at,
        }
      : null,
    dwellMinutes: minutesBetween(r.check_in_at, r.check_out_at ?? Date.now()),
  };
}

const APPOINTMENT_SELECT = `
  SELECT da.*, l.code AS location_code
  FROM dock_appointments da
  LEFT JOIN locations l ON l.id = da.location_id`;

function toAppointment(r: Row): DockAppointment {
  return {
    id: r.id,
    code: r.code,
    siteId: r.site_id,
    tripId: r.trip_id ?? null,
    plate: r.plate,
    carrier: r.carrier ?? "",
    purpose: r.purpose,
    locationId: r.location_id ?? null,
    locationCode: r.location_code ?? null,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    status: r.status,
    notes: r.notes ?? "",
    createdAt: r.created_at,
  };
}

export function getAppointment(id: string): DockAppointment {
  return toAppointment(must(one(`${APPOINTMENT_SELECT} WHERE da.id = ?`, [id]), "Dock appointment"));
}

export function listAppointments(siteId?: string, status?: string): DockAppointment[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (siteId) {
    where.push("da.site_id = ?");
    params.push(siteId);
  }
  if (status) {
    where.push("da.status = ?");
    params.push(status);
  }
  return many(
    `${APPOINTMENT_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY da.window_start ASC`,
    params,
  ).map(toAppointment);
}

export interface AppointmentOverlap {
  id: string;
  code: string;
  plate: string;
  windowStart: string;
  windowEnd: string;
}

function parsedInstant(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** UTC form with milliseconds, so stored windows sort and display as the same instant. */
function canonicalTimestamp(value: string): string {
  const ms = parsedInstant(value);
  if (ms === null) throw badRequest("Appointment window timestamps are invalid");
  return new Date(ms).toISOString();
}

/**
 * Half-open overlap on instants, not ISO text. Touching at an endpoint is free.
 * A timestamp that cannot be parsed still counts as overlap so a bad row cannot hide a booking.
 */
function intervalsOverlap(startA: string, endA: string, startB: string, endB: string): boolean {
  const a0 = parsedInstant(startA);
  const a1 = parsedInstant(endA);
  const b0 = parsedInstant(startB);
  const b1 = parsedInstant(endB);
  if (a0 === null || a1 === null || b0 === null || b1 === null) return true;
  return a0 < b1 && a1 > b0;
}

/** Scheduled or checked-in booking whose window overlaps the candidate interval. */
export function findAppointmentOverlap(
  siteId: string,
  locationId: string,
  windowStart: string,
  windowEnd: string,
  excludeId?: string,
): AppointmentOverlap | undefined {
  const rows = many<Row>(
    `SELECT id, code, plate, window_start, window_end FROM dock_appointments
     WHERE site_id = ? AND location_id = ? AND status IN ('scheduled', 'checked_in')
       AND (? IS NULL OR id != ?)`,
    [siteId, locationId, excludeId ?? null, excludeId ?? null],
  );
  const row = rows.find((candidate) =>
    intervalsOverlap(candidate.window_start, candidate.window_end, windowStart, windowEnd),
  );
  if (!row) return undefined;
  return {
    id: row.id,
    code: row.code,
    plate: row.plate,
    windowStart: row.window_start,
    windowEnd: row.window_end,
  };
}

export function createAppointment(input: z.output<typeof DockAppointmentInputSchema>, ctx: Ctx): DockAppointment {
  return tx(() => {
    const site = getSite(input.siteId);
    let locationCode: string | null = null;
    if (input.locationId) {
      const loc = getLocation(input.locationId);
      if (loc.siteId !== site.id || loc.kind !== "dock_door") {
        throw badRequest("Location is not a dock door at this site");
      }
      locationCode = loc.code;
      const conflicting = findAppointmentOverlap(site.id, input.locationId, input.windowStart, input.windowEnd);
      if (conflicting) {
        throw conflict(
          `Dock door ${locationCode} is already booked by appointment ${conflicting.code} (${conflicting.plate}) for window ${conflicting.windowStart} - ${conflicting.windowEnd}`,
        );
      }
    }
    const id = newId("app");
    const code = nextCode("dock_appointment", "APP");
    const when = at(ctx);
    const vehicle = findVehicleByPlate(input.plate);
    const plate = vehicle ? vehicle.plate : input.plate.trim().toUpperCase();
    const windowStart = canonicalTimestamp(input.windowStart);
    const windowEnd = canonicalTimestamp(input.windowEnd);
    run(
      `INSERT INTO dock_appointments (id, code, site_id, trip_id, plate, carrier, purpose, location_id, window_start, window_end, status, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
      [
        id,
        code,
        site.id,
        input.tripId ?? null,
        plate,
        input.carrier ?? "",
        input.purpose,
        input.locationId ?? null,
        windowStart,
        windowEnd,
        input.notes ?? "",
        when,
      ],
    );
    const appointment = getAppointment(id);
    emit(ctx, {
      type: "appointment.created",
      siteId: site.id,
      tripId: input.tripId ?? null,
      locationId: input.locationId ?? null,
      entityId: id,
      message: `Appointment ${code} scheduled for ${appointment.plate} at ${site.code} (${appointment.windowStart} - ${appointment.windowEnd})`,
      payload: { code, plate: appointment.plate, purpose: appointment.purpose, locationCode },
    });
    return appointment;
  });
}

export function cancelAppointment(id: string, ctx: Ctx): DockAppointment {
  return tx(() => {
    const appt = getAppointment(id);
    if (appt.status === "completed") throw badRequest("Completed appointment cannot be cancelled");
    if (appt.status === "cancelled") return appt;
    run(`UPDATE dock_appointments SET status = 'cancelled' WHERE id = ?`, [id]);
    const updated = getAppointment(id);
    emit(ctx, {
      type: "appointment.cancelled",
      siteId: appt.siteId,
      tripId: appt.tripId,
      entityId: id,
      message: `Appointment ${appt.code} for ${appt.plate} was cancelled`,
    });
    return updated;
  });
}

/** The trip's live booking at a site, preferring a still-scheduled window over one already checked in. */
export function findTripAppointment(siteId: string, tripId: string): DockAppointment | null {
  const row = one(
    `${APPOINTMENT_SELECT}
     WHERE da.site_id = ? AND da.trip_id = ? AND da.status IN ('scheduled', 'checked_in')
     ORDER BY CASE da.status WHEN 'scheduled' THEN 0 ELSE 1 END, da.window_start ASC
     LIMIT 1`,
    [siteId, tripId],
  );
  return row ? toAppointment(row) : null;
}

export interface AppointmentExpectation {
  tripId: string | null;
  siteId: string;
  locationId: string | null;
}

/**
 * Moves a scheduled appointment. The caller supplies the trip, site, and dock the
 * recommendation was built from; any mismatch, overlap, or unsafe window aborts the transaction.
 */
export function rescheduleAppointment(
  id: string,
  windowStart: string,
  windowEnd: string,
  expected: AppointmentExpectation,
  ctx: Ctx,
): DockAppointment {
  return tx(() => {
    const appt = getAppointment(id);
    if (appt.status !== "scheduled") {
      throw conflict(`Appointment ${appt.code} is ${appt.status}; only scheduled appointments can be rescheduled`);
    }
    if ((appt.tripId ?? null) !== (expected.tripId ?? null)) {
      throw conflict("Appointment is no longer for the expected trip");
    }
    if (appt.siteId !== expected.siteId) {
      throw conflict("Appointment is no longer at the expected site");
    }
    if ((appt.locationId ?? null) !== (expected.locationId ?? null)) {
      throw conflict("Appointment is no longer at the expected dock");
    }
    const canonicalStart = canonicalTimestamp(windowStart);
    const canonicalEnd = canonicalTimestamp(windowEnd);
    const startMs = Date.parse(canonicalStart);
    const endMs = Date.parse(canonicalEnd);
    const origStart = Date.parse(appt.windowStart);
    const origEnd = Date.parse(appt.windowEnd);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(origStart) || !Number.isFinite(origEnd)) {
      throw badRequest("Appointment window timestamps are invalid");
    }
    if (endMs <= startMs) throw badRequest("Window end must be after window start");
    if (endMs - startMs !== origEnd - origStart) {
      throw badRequest("Reschedule must keep the original appointment duration");
    }
    if (startMs < origStart) throw conflict("Reschedule cannot move the window earlier");
    if (startMs <= Date.now()) throw conflict("Reschedule requires a future window");
    if (appt.locationId) {
      const conflicting = findAppointmentOverlap(appt.siteId, appt.locationId, canonicalStart, canonicalEnd, appt.id);
      if (conflicting) {
        throw conflict(
          `Dock door ${appt.locationCode ?? appt.locationId} is already booked by appointment ${conflicting.code} (${conflicting.plate}) for window ${conflicting.windowStart} - ${conflicting.windowEnd}`,
        );
      }
    }
    const before = {
      windowStart: appt.windowStart,
      windowEnd: appt.windowEnd,
      status: appt.status,
      locationId: appt.locationId,
      tripId: appt.tripId,
      siteId: appt.siteId,
    };
    run(`UPDATE dock_appointments SET window_start = ?, window_end = ? WHERE id = ?`, [canonicalStart, canonicalEnd, id]);
    const updated = getAppointment(id);
    emit(ctx, {
      type: "appointment.rescheduled",
      siteId: appt.siteId,
      tripId: appt.tripId,
      locationId: appt.locationId,
      entityId: id,
      message: `Appointment ${appt.code} for ${appt.plate} moved from ${before.windowStart} – ${before.windowEnd} to ${updated.windowStart} – ${updated.windowEnd}`,
      payload: {
        code: appt.code,
        actor: ctx.actor,
        before,
        after: {
          windowStart: updated.windowStart,
          windowEnd: updated.windowEnd,
          status: updated.status,
          locationId: updated.locationId,
          tripId: updated.tripId,
          siteId: updated.siteId,
        },
      },
    });
    return updated;
  });
}

export interface DockSwapAssessment {
  eligible: boolean;
  reason: string;
  visitId: string;
  siteId: string | null;
  status: string | null;
  plate: string | null;
  locationId: string;
  dockCode: string | null;
  locationActive: boolean;
  dockFree: boolean;
  reservationClear: boolean;
}

function ineligibleSwap(
  visitId: string,
  locationId: string,
  reason: string,
  extra: Partial<DockSwapAssessment> = {},
): DockSwapAssessment {
  return {
    eligible: false,
    reason,
    visitId,
    siteId: null,
    status: null,
    plate: null,
    locationId,
    dockCode: null,
    locationActive: false,
    dockFree: false,
    reservationClear: false,
    ...extra,
  };
}

/** A yard visit can take this dock only when the visit, the door, and its reservations all check out. */
export function assessDockSwap(
  visitId: string,
  locationId: string,
  opts?: { ignoreAppointmentId?: string; now?: string },
): DockSwapAssessment {
  const now = opts?.now ?? new Date().toISOString();
  let visit: GateVisit;
  try {
    visit = getVisit(visitId);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404) {
      return ineligibleSwap(visitId, locationId, "Yard visit cannot be established");
    }
    throw err;
  }
  if (visit.checkOutAt || visit.status !== "in_yard") {
    return ineligibleSwap(visitId, locationId, "Yard visit is not eligible for a dock swap", {
      siteId: visit.siteId,
      status: visit.status,
      plate: visit.plate,
    });
  }
  let loc;
  try {
    loc = getLocation(locationId);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404) {
      return ineligibleSwap(visitId, locationId, "Dock cannot be established", {
        siteId: visit.siteId,
        status: visit.status,
        plate: visit.plate,
      });
    }
    throw err;
  }
  const base = {
    siteId: visit.siteId,
    status: visit.status,
    plate: visit.plate,
    dockCode: loc.code,
    locationActive: loc.active,
  };
  if (loc.siteId !== visit.siteId || loc.kind !== "dock_door" || !loc.active) {
    return ineligibleSwap(visitId, locationId, "Dock is not an active door at the visit site", base);
  }
  const occupied = Boolean(
    one("SELECT 1 FROM dock_assignments WHERE location_id = ? AND released_at IS NULL", [loc.id]),
  );
  if (occupied) {
    return ineligibleSwap(visitId, locationId, `${loc.code} is occupied`, { ...base, locationActive: true });
  }
  const ignore = opts?.ignoreAppointmentId ?? null;
  const nowMs = parsedInstant(now) ?? Date.now();
  const reservations = many<{ id: string; code: string; window_end: string }>(
    `SELECT id, code, window_end FROM dock_appointments
     WHERE location_id = ? AND status IN ('scheduled', 'checked_in')
       AND (? IS NULL OR id != ?)`,
    [loc.id, ignore, ignore],
  );
  const reservation = reservations.find((row) => {
    const end = parsedInstant(row.window_end);
    return end === null || end > nowMs;
  });
  if (reservation) {
    return ineligibleSwap(visitId, locationId, `Dock is reserved by appointment ${reservation.code}`, {
      ...base,
      locationActive: true,
      dockFree: true,
    });
  }
  return {
    ...base,
    eligible: true,
    reason: "Yard visit is eligible and the dock is active, free, and unreserved",
    visitId,
    locationId: loc.id,
    locationActive: true,
    dockFree: true,
    reservationClear: true,
  };
}

/** First waiting visit that can take the preferred dock, or any free dock when no dock is specified. */
export function findEligibleDockSwap(
  siteId: string,
  opts?: { locationId?: string; ignoreAppointmentId?: string; now?: string },
): DockSwapAssessment | null {
  const visits = many<{ id: string }>(
    `SELECT id FROM gate_visits
     WHERE site_id = ? AND status = 'in_yard' AND check_out_at IS NULL
     ORDER BY check_in_at ASC`,
    [siteId],
  );
  const locationIds = opts?.locationId
    ? [opts.locationId]
    : freeLocations(siteId, "dock_door").map((row) => String(row.id));
  for (const visit of visits) {
    for (const locationId of locationIds) {
      const assessment = assessDockSwap(visit.id, locationId, opts);
      if (assessment.eligible) return assessment;
    }
  }
  return null;
}

export function executeDockSwap(
  visitId: string,
  locationId: string,
  ctx: Ctx,
  opts?: { ignoreAppointmentId?: string },
): GateVisit {
  return tx(() => {
    const assessment = assessDockSwap(visitId, locationId, opts);
    if (!assessment.eligible) throw conflict(assessment.reason);
    return assignDock(visitId, { locationId }, ctx);
  });
}

export function getVisit(id: string): GateVisit {
  return toVisit(must(one(`${VISIT_SELECT} WHERE gv.id = ?`, [id]), "Gate visit"));
}

export function listVisits(q: z.output<typeof VisitQuerySchema>): GateVisit[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.siteId) {
    where.push("gv.site_id = ?");
    params.push(q.siteId);
  }
  if (q.open === "true") where.push("gv.check_out_at IS NULL");
  if (q.open === "false") where.push("gv.check_out_at IS NOT NULL");
  return many(
    `${VISIT_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY gv.check_out_at IS NULL DESC, COALESCE(gv.check_out_at, gv.check_in_at) DESC LIMIT ?`,
    [...params, q.limit],
  ).map(toVisit);
}

export function openVisitForVehicle(vehicleId: string): GateVisit | undefined {
  const r = one(`${VISIT_SELECT} WHERE gv.vehicle_id = ? AND gv.check_out_at IS NULL`, [vehicleId]);
  return r ? toVisit(r) : undefined;
}

/** Trips expected at the gate: inbound arrivals and trucks coming to collect. */
export function expectedAtSite(siteId: string): ExpectedTrip[] {
  getSite(siteId);
  const arriving = many(
    `SELECT * FROM trips WHERE destination_site_id = ? AND status IN ('dispatched','in_transit') ORDER BY planned_arrival`,
    [siteId],
  );
  const collecting = many(
    `SELECT * FROM trips t WHERE origin_site_id = ? AND status IN ('planned','dispatched') AND vehicle_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM gate_visits gv WHERE gv.vehicle_id = t.vehicle_id AND gv.site_id = t.origin_site_id AND gv.check_out_at IS NULL)
     ORDER BY planned_departure`,
    [siteId],
  );
  const plates = new Map(many("SELECT id, plate FROM vehicles").map((v) => [v.id, v.plate as string]));
  const tag = (rows: Row[], direction: ExpectedTrip["direction"]) =>
    hydrateTrips(rows).map((t) => ({ ...t, direction, plate: t.vehicleId ? plates.get(t.vehicleId) ?? null : null }));
  return [...tag(arriving, "arriving"), ...tag(collecting, "collecting")];
}

function freeLocations(siteId: string, kind: "yard_slot" | "dock_door"): Row[] {
  const busy =
    kind === "yard_slot"
      ? `SELECT yard_location_id FROM gate_visits WHERE check_out_at IS NULL AND status = 'in_yard' AND yard_location_id IS NOT NULL`
      : `SELECT location_id FROM dock_assignments WHERE released_at IS NULL`;
  return many(
    `SELECT * FROM locations WHERE site_id = ? AND kind = ? AND active = 1 AND id NOT IN (${busy}) ORDER BY code`,
    [siteId, kind],
  );
}

function matchTrip(siteId: string, vehicleId: string): { id: string; arriving: boolean } | undefined {
  const arriving = one(
    `SELECT id FROM trips WHERE destination_site_id = ? AND (vehicle_id = ? OR trailer_id = ?) AND status IN ('dispatched','in_transit')
     ORDER BY planned_arrival LIMIT 1`,
    [siteId, vehicleId, vehicleId],
  );
  if (arriving) return { id: arriving.id, arriving: true };
  const collecting = one(
    `SELECT id FROM trips WHERE origin_site_id = ? AND vehicle_id = ? AND status IN ('planned','dispatched')
     ORDER BY planned_departure LIMIT 1`,
    [siteId, vehicleId],
  );
  return collecting ? { id: collecting.id, arriving: false } : undefined;
}

export function checkIn(input: z.output<typeof CheckInInputSchema>, ctx: Ctx): GateVisit {
  return tx(() => {
    const site = getSite(input.siteId);
    const vehicle = input.vehicleId
      ? getVehicle(input.vehicleId)
      : findVehicleByPlate(input.plate!) ?? (() => {
          throw notFound(`Vehicle with plate ${input.plate}`);
        })();
    const open = openVisitForVehicle(vehicle.id);
    if (open) {
      throw conflict(`${vehicle.plate} is already checked in at ${getSite(open.siteId).code}`);
    }

    let trip: { id: string; arriving: boolean } | undefined;
    if (input.tripId) {
      const t = getTrip(input.tripId);
      trip = { id: t.id, arriving: t.destinationSiteId === site.id };
    } else {
      trip = matchTrip(site.id, vehicle.id);
    }
    if (trip?.arriving) arriveTrip(trip.id, ctx);

    let yardId: string | null = null;
    if (input.yardLocationId) {
      const loc = getLocation(input.yardLocationId);
      if (loc.siteId !== site.id || loc.kind !== "yard_slot") throw badRequest("Not a yard slot at this site");
      if (!freeLocations(site.id, "yard_slot").some((r) => r.id === loc.id)) throw conflict(`${loc.code} is taken`);
      yardId = loc.id;
    } else {
      yardId = freeLocations(site.id, "yard_slot")[0]?.id ?? null;
    }

    const id = newId("vis");
    const when = at(ctx);
    run(
      `INSERT INTO gate_visits (id, site_id, vehicle_id, trip_id, plate, status, check_in_at, yard_location_id, seal_in, notes, source_in)
       VALUES (?, ?, ?, ?, ?, 'in_yard', ?, ?, ?, ?, ?)`,
      [id, site.id, vehicle.id, trip?.id ?? null, vehicle.plate, when, yardId, input.sealNo, input.notes, ctx.source],
    );
    const scheduledAppt = one<Row>(
      `SELECT id FROM dock_appointments WHERE site_id = ? AND status = 'scheduled' AND (plate = ? OR (trip_id IS NOT NULL AND trip_id = ?))
       ORDER BY window_start ASC LIMIT 1`,
      [site.id, vehicle.plate, trip?.id ?? null],
    );
    if (scheduledAppt) {
      run("UPDATE dock_appointments SET status = 'checked_in' WHERE id = ?", [scheduledAppt.id]);
    }
    run("UPDATE vehicles SET current_site_id = ? WHERE id = ?", [site.id, vehicle.id]);
    refreshVehicleStatus(vehicle.id);
    const visit = getVisit(id);
    emit(ctx, {
      type: "gate.check_in",
      siteId: site.id,
      vehicleId: vehicle.id,
      tripId: visit.tripId,
      locationId: yardId,
      entityId: id,
      message: `${vehicle.plate} checked in at ${site.code}${visit.tripCode ? ` for ${visit.tripCode}` : ""}${
        visit.yardCode ? `, parked at ${visit.yardCode}` : ""
      }`,
      payload: { seal: input.sealNo },
    });
    return visit;
  });
}

export function checkOut(input: z.output<typeof CheckOutInputSchema>, ctx: Ctx): GateVisit {
  return tx(() => {
    let visit: GateVisit;
    if (input.visitId) visit = getVisit(input.visitId);
    else {
      const vehicle = findVehicleByPlate(input.plate!);
      const open = vehicle ? openVisitForVehicle(vehicle.id) : undefined;
      if (!open || open.siteId !== input.siteId) throw notFound(`Open visit for ${input.plate}`);
      visit = open;
    }
    if (visit.checkOutAt) throw badRequest("Vehicle already checked out");
    const when = at(ctx);
    if (visit.dock) run("UPDATE dock_assignments SET released_at = ? WHERE id = ?", [when, visit.dock.assignmentId]);
    run(
      `UPDATE gate_visits SET status = 'departed', check_out_at = ?, seal_out = ?, notes = CASE WHEN ? = '' THEN notes ELSE TRIM(notes || ' ' || ?) END,
       source_out = ? WHERE id = ?`,
      [when, input.sealNo, input.notes, input.notes, ctx.source, visit.id],
    );
    run(
      `UPDATE dock_appointments SET status = 'completed'
       WHERE site_id = ? AND status = 'checked_in' AND (plate = ? OR (trip_id IS NOT NULL AND trip_id = ?))`,
      [visit.siteId, visit.plate, visit.tripId ?? null],
    );
    run("UPDATE vehicles SET current_site_id = NULL WHERE id = ?", [visit.vehicleId]);

    // An inbound trip ends at the gate. A dispatched outbound trip leaves with the truck.
    // A planned trip stays planned so the yard can still expect it until Control Tower dispatches it.
    if (visit.tripId) {
      const t = getTrip(visit.tripId);
      if (t.destinationSiteId === visit.siteId && t.status === "arrived") completeTrip(t.id, ctx);
      if (t.originSiteId === visit.siteId && t.status === "dispatched" && t.driverId) {
        departTrip(t.id, ctx);
      }
    }
    for (const t of many(
      `SELECT id FROM trips WHERE origin_site_id = ? AND vehicle_id = ? AND status = 'dispatched'`,
      [visit.siteId, visit.vehicleId],
    )) {
      departTrip(t.id, ctx);
    }

    refreshVehicleStatus(visit.vehicleId);
    const out = getVisit(visit.id);
    emit(ctx, {
      type: "gate.check_out",
      siteId: visit.siteId,
      vehicleId: visit.vehicleId,
      tripId: visit.tripId,
      entityId: visit.id,
      message: `${visit.plate} checked out of ${getSite(visit.siteId).code} after ${out.dwellMinutes} min`,
      payload: { seal: input.sealNo, dwellMinutes: out.dwellMinutes },
    });
    return out;
  });
}

function defaultPurpose(visit: GateVisit): DockPurpose {
  if (!visit.tripId) return "unload";
  const t = getTrip(visit.tripId);
  return t.destinationSiteId === visit.siteId ? "unload" : "load";
}

export function suggestDock(visitId: string, asOf: string = new Date().toISOString()): DockSuggestion {
  const visit = getVisit(visitId);
  const free = freeLocations(visit.siteId, "dock_door");
  if (!free.length) return { locationId: null, code: null, reason: "All dock doors are occupied" };

  const appt = one<Row>(
    `SELECT da.*, l.code AS location_code FROM dock_appointments da
     JOIN locations l ON l.id = da.location_id
     WHERE da.site_id = ? AND da.status IN ('scheduled', 'checked_in')
       AND da.location_id IS NOT NULL
       AND (da.plate = ? OR (da.trip_id IS NOT NULL AND da.trip_id = ?))
     ORDER BY da.window_start ASC LIMIT 1`,
    [visit.siteId, visit.plate, visit.tripId ?? null],
  );
  if (appt && free.some((l) => l.id === appt.location_id)) {
    return {
      locationId: appt.location_id,
      code: appt.location_code,
      reason: `Reserved by dock appointment ${appt.code} (${appt.purpose})`,
    };
  }

  const since = new Date(Date.parse(asOf) - 24 * 3600_000).toISOString();
  const load = new Map(
    many(
      `SELECT location_id, COUNT(*) AS n FROM dock_assignments WHERE assigned_at >= ? AND assigned_at <= ? GROUP BY location_id`,
      [since, asOf],
    ).map((r) => [r.location_id, Number(r.n)]),
  );
  const best = [...free].sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || a.code.localeCompare(b.code))[0]!;
  return {
    locationId: best.id,
    code: best.code,
    reason: `${free.length} door(s) free; ${best.code} has the fewest turns in the last 24h`,
  };
}

export function assignDock(visitId: string, input: z.output<typeof AssignDockInputSchema>, ctx: Ctx): GateVisit {
  return tx(() => {
    const visit = getVisit(visitId);
    if (visit.checkOutAt) throw badRequest("Vehicle already checked out");
    let locationId = input.locationId;
    if (!locationId) {
      locationId = suggestDock(visitId, at(ctx)).locationId ?? undefined;
      if (!locationId) throw conflict("No free dock door");
    }
    const loc = getLocation(locationId);
    if (loc.siteId !== visit.siteId || loc.kind !== "dock_door" || !loc.active) {
      throw badRequest("Not a dock door at this site");
    }
    if (visit.dock?.locationId === loc.id) return visit;
    if (!freeLocations(visit.siteId, "dock_door").some((r) => r.id === loc.id)) throw conflict(`${loc.code} is occupied`);

    const when = at(ctx);
    const before = {
      status: visit.status,
      yardLocationId: visit.yardLocationId,
      dock: visit.dock
        ? { assignmentId: visit.dock.assignmentId, locationId: visit.dock.locationId, code: visit.dock.code }
        : null,
    };
    if (visit.dock) run("UPDATE dock_assignments SET released_at = ? WHERE id = ?", [when, visit.dock.assignmentId]);
    const purpose = input.purpose ?? defaultPurpose(visit);
    run(
      `INSERT INTO dock_assignments (id, visit_id, location_id, purpose, assigned_at) VALUES (?, ?, ?, ?, ?)`,
      [newId("dck"), visit.id, loc.id, purpose, when],
    );
    run("UPDATE gate_visits SET status = 'at_dock', yard_location_id = NULL WHERE id = ?", [visit.id]);
    refreshVehicleStatus(visit.vehicleId);
    emit(ctx, {
      type: "dock.assigned",
      siteId: visit.siteId,
      vehicleId: visit.vehicleId,
      tripId: visit.tripId,
      locationId: loc.id,
      entityId: visit.id,
      message: `${visit.plate} to ${loc.code} to ${purpose}`,
      payload: {
        purpose,
        actor: ctx.actor,
        before,
        after: {
          status: "at_dock",
          yardLocationId: null,
          dock: { locationId: loc.id, code: loc.code },
        },
      },
    });
    if (purpose === "unload" && getSite(visit.siteId).kind === "warehouse") ensureReceiptForVisit(visit.id, ctx);
    return getVisit(visit.id);
  });
}

export function releaseDock(visitId: string, ctx: Ctx): GateVisit {
  return tx(() => {
    const visit = getVisit(visitId);
    if (!visit.dock) throw badRequest("Vehicle is not at a dock");
    run("UPDATE dock_assignments SET released_at = ? WHERE id = ?", [at(ctx), visit.dock.assignmentId]);
    const yard = freeLocations(visit.siteId, "yard_slot")[0]?.id ?? null;
    run("UPDATE gate_visits SET status = 'in_yard', yard_location_id = ? WHERE id = ?", [yard, visit.id]);
    refreshVehicleStatus(visit.vehicleId);
    const out = getVisit(visit.id);
    emit(ctx, {
      type: "dock.released",
      siteId: visit.siteId,
      vehicleId: visit.vehicleId,
      tripId: visit.tripId,
      locationId: visit.dock.locationId,
      entityId: visit.id,
      message: `${visit.plate} left ${visit.dock.code}${out.yardCode ? `, back to ${out.yardCode}` : ""}`,
    });
    return out;
  });
}

export function moveInYard(visitId: string, locationId: string, ctx: Ctx): GateVisit {
  return tx(() => {
    const visit = getVisit(visitId);
    if (visit.status !== "in_yard") throw badRequest("Only trucks waiting in the yard can be moved");
    const loc = getLocation(locationId);
    if (loc.siteId !== visit.siteId || loc.kind !== "yard_slot") throw badRequest("Not a yard slot at this site");
    if (!freeLocations(visit.siteId, "yard_slot").some((r) => r.id === loc.id)) throw conflict(`${loc.code} is taken`);
    run("UPDATE gate_visits SET yard_location_id = ? WHERE id = ?", [loc.id, visit.id]);
    emit(ctx, {
      type: "yard.moved",
      siteId: visit.siteId,
      vehicleId: visit.vehicleId,
      locationId: loc.id,
      entityId: visit.id,
      message: `${visit.plate} moved to ${loc.code}`,
    });
    return getVisit(visit.id);
  });
}
