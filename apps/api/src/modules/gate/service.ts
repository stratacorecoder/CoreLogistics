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
import { badRequest, conflict, must, notFound } from "../../errors.js";
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
    }
    const id = newId("app");
    const code = nextCode("dock_appointment", "APP");
    const when = at(ctx);
    const vehicle = findVehicleByPlate(input.plate);
    const plate = vehicle ? vehicle.plate : input.plate.trim().toUpperCase();
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
        input.windowStart,
        input.windowEnd,
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

    // An inbound trip ends at the gate; a truck leaving with a dispatched outbound trip departs on it.
    if (visit.tripId) {
      const t = getTrip(visit.tripId);
      if (t.destinationSiteId === visit.siteId && t.status === "arrived") completeTrip(t.id, ctx);
      if (t.originSiteId === visit.siteId && ["planned", "dispatched"].includes(t.status) && t.driverId) {
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
      payload: { purpose },
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
