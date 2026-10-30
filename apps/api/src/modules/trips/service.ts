import {
  ON_TIME_TOLERANCE_MINUTES,
  TripInputSchema,
  TripPatchSchema,
  TripQuerySchema,
  type Trip,
  type TripIssueInput,
  type TripStop,
} from "@corelogistics/contracts";
import type { z } from "zod";
import { many, newId, nextCode, one, placeholders, run, splitList, tx, type Row } from "../../db.js";
import { badRequest, conflict, must } from "../../errors.js";
import { at, emit, type Ctx } from "../../events.js";
import {
  getDriver,
  getVehicle,
  openMaintenance,
  refreshDriverStatus,
  refreshVehicleStatus,
} from "../fleet/service.js";
import { checkOut, openVisitForVehicle } from "../gate/service.js";
import { getSite, siteDistanceKm } from "../sites/service.js";

const MIN = 60_000;

function toStop(r: Row): TripStop {
  return {
    id: r.id,
    seq: r.seq,
    siteId: r.site_id,
    plannedAt: r.planned_at ?? null,
    arrivedAt: r.arrived_at ?? null,
    departedAt: r.departed_at ?? null,
  };
}

/** Delay and ETA are computed on read so they never go stale. */
function timing(r: Row, now: number): { delayed: boolean; delayMinutes: number; etaAt: string | null } {
  const pd = Date.parse(r.planned_departure);
  const pa = Date.parse(r.planned_arrival);
  let delay = 0;
  let eta: number | null = null;
  switch (r.status) {
    case "planned":
    case "dispatched":
      delay = Math.max(0, now - pd);
      eta = pa + delay;
      break;
    case "in_transit": {
      eta = Date.parse(r.actual_departure) + (pa - pd);
      if (eta < now) eta = now;
      delay = Math.max(0, eta - pa);
      break;
    }
    case "arrived":
    case "completed":
      delay = r.actual_arrival ? Math.max(0, Date.parse(r.actual_arrival) - pa) : 0;
      break;
  }
  const delayMinutes = Math.round(delay / MIN);
  return {
    delayed: delayMinutes > ON_TIME_TOLERANCE_MINUTES,
    delayMinutes,
    etaAt: eta === null ? null : new Date(eta).toISOString(),
  };
}

function toTrip(r: Row, stops: TripStop[], now = Date.now()): Trip {
  return {
    id: r.id,
    code: r.code,
    kind: r.kind,
    status: r.status,
    originSiteId: r.origin_site_id,
    destinationSiteId: r.destination_site_id,
    vehicleId: r.vehicle_id ?? null,
    trailerId: r.trailer_id ?? null,
    driverId: r.driver_id ?? null,
    plannedDeparture: r.planned_departure,
    plannedArrival: r.planned_arrival,
    actualDeparture: r.actual_departure ?? null,
    actualArrival: r.actual_arrival ?? null,
    completedAt: r.completed_at ?? null,
    notes: r.notes,
    createdAt: r.created_at,
    stops,
    ...timing(r, now),
  };
}

export function hydrateTrips(rows: Row[]): Trip[] {
  if (!rows.length) return [];
  const stops = many(
    `SELECT * FROM trip_stops WHERE trip_id IN (${placeholders(rows.length)}) ORDER BY seq`,
    rows.map((r) => r.id),
  );
  const byTrip = new Map<string, TripStop[]>();
  for (const s of stops) {
    const list = byTrip.get(s.trip_id) ?? [];
    list.push(toStop(s));
    byTrip.set(s.trip_id, list);
  }
  const now = Date.now();
  return rows.map((r) => toTrip(r, byTrip.get(r.id) ?? [], now));
}

export function getTrip(id: string): Trip {
  const row = must(one("SELECT * FROM trips WHERE id = ? OR code = ?", [id, id]), "Trip");
  return hydrateTrips([row])[0]!;
}

export function listTrips(q: z.output<typeof TripQuerySchema>): Trip[] {
  const where: string[] = [];
  const params: unknown[] = [];
  const statuses = splitList(q.status);
  if (statuses.length) {
    where.push(`status IN (${placeholders(statuses.length)})`);
    params.push(...statuses);
  }
  if (q.active === "true") where.push("status IN ('planned','dispatched','in_transit','arrived')");
  if (q.active === "false") where.push("status IN ('completed','cancelled')");
  if (q.siteId) {
    where.push(
      "(origin_site_id = ? OR destination_site_id = ? OR id IN (SELECT trip_id FROM trip_stops WHERE site_id = ?))",
    );
    params.push(q.siteId, q.siteId, q.siteId);
  }
  if (q.driverId) {
    where.push("driver_id = ?");
    params.push(q.driverId);
  }
  if (q.vehicleId) {
    where.push("(vehicle_id = ? OR trailer_id = ?)");
    params.push(q.vehicleId, q.vehicleId);
  }
  const closedOnly =
    q.active === "false" || (statuses.length > 0 && statuses.every((s) => s === "completed" || s === "cancelled"));
  const rows = many(
    `SELECT * FROM trips ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY CASE status WHEN 'in_transit' THEN 0 WHEN 'arrived' THEN 1 WHEN 'dispatched' THEN 2 WHEN 'planned' THEN 3 ELSE 4 END,
              planned_departure ${closedOnly ? "DESC" : "ASC"}
     LIMIT ?`,
    [...params, q.limit],
  );
  return hydrateTrips(rows);
}

function checkAssets(vehicleId: string | null, trailerId: string | null, driverId: string | null) {
  if (vehicleId) {
    const v = getVehicle(vehicleId);
    if (v.kind === "trailer") throw badRequest(`${v.code} is a trailer; assign it as trailer`);
  }
  if (trailerId) {
    const t = getVehicle(trailerId);
    if (t.kind !== "trailer") throw badRequest(`${t.code} is not a trailer`);
  }
  if (driverId) getDriver(driverId);
}

function tripLabel(t: Trip) {
  const o = getSite(t.originSiteId);
  const d = getSite(t.destinationSiteId);
  return `${t.code} ${o.code} → ${d.code}`;
}

export function createTrip(input: z.output<typeof TripInputSchema>, ctx: Ctx): Trip {
  return tx(() => {
    getSite(input.originSiteId);
    getSite(input.destinationSiteId);
    checkAssets(input.vehicleId ?? null, input.trailerId ?? null, input.driverId ?? null);
    const id = newId("trp");
    const code = nextCode("trip", "TRP");
    run(
      `INSERT INTO trips (id, code, kind, status, origin_site_id, destination_site_id, vehicle_id, trailer_id, driver_id,
         planned_departure, planned_arrival, notes, created_at)
       VALUES (?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        code,
        input.kind,
        input.originSiteId,
        input.destinationSiteId,
        input.vehicleId ?? null,
        input.trailerId ?? null,
        input.driverId ?? null,
        input.plannedDeparture,
        input.plannedArrival,
        input.notes,
        at(ctx),
      ],
    );
    input.stops.forEach((s, i) => {
      getSite(s.siteId);
      run(`INSERT INTO trip_stops (id, trip_id, seq, site_id, planned_at) VALUES (?, ?, ?, ?, ?)`, [
        newId("stp"),
        id,
        i + 1,
        s.siteId,
        s.plannedAt ?? null,
      ]);
    });
    const trip = getTrip(id);
    emit(ctx, {
      type: "trip.created",
      tripId: id,
      siteId: input.originSiteId,
      vehicleId: trip.vehicleId,
      driverId: trip.driverId,
      message: `Trip ${tripLabel(trip)} planned`,
    });
    return trip;
  });
}

export function updateTrip(id: string, patch: z.output<typeof TripPatchSchema>, ctx: Ctx): Trip {
  return tx(() => {
    const t = getTrip(id);
    if (!["planned", "dispatched"].includes(t.status)) {
      throw badRequest(`Trip is ${t.status}; only planned or dispatched trips can be edited`);
    }
    const next = {
      vehicleId: patch.vehicleId === undefined ? t.vehicleId : patch.vehicleId,
      trailerId: patch.trailerId === undefined ? t.trailerId : patch.trailerId,
      driverId: patch.driverId === undefined ? t.driverId : patch.driverId,
      plannedDeparture: patch.plannedDeparture ?? t.plannedDeparture,
      plannedArrival: patch.plannedArrival ?? t.plannedArrival,
      notes: patch.notes ?? t.notes,
    };
    if (Date.parse(next.plannedArrival) <= Date.parse(next.plannedDeparture)) {
      throw badRequest("Planned arrival must be after planned departure");
    }
    checkAssets(next.vehicleId, next.trailerId, next.driverId);
    if (t.status === "dispatched" && (!next.vehicleId || !next.driverId)) {
      throw badRequest("A dispatched trip needs a vehicle and a driver");
    }
    if (t.status === "dispatched") assertAssetsFree(t.id, next.vehicleId, next.driverId);
    run(
      `UPDATE trips SET vehicle_id = ?, trailer_id = ?, driver_id = ?, planned_departure = ?, planned_arrival = ?, notes = ? WHERE id = ?`,
      [next.vehicleId, next.trailerId, next.driverId, next.plannedDeparture, next.plannedArrival, next.notes, t.id],
    );
    for (const d of new Set([t.driverId, next.driverId])) if (d) refreshDriverStatus(d);
    const trip = getTrip(t.id);
    emit(ctx, {
      type: "trip.updated",
      tripId: t.id,
      vehicleId: trip.vehicleId,
      driverId: trip.driverId,
      message: `Trip ${t.code} updated`,
      payload: patch,
    });
    return trip;
  });
}

function assertAssetsFree(tripId: string, vehicleId: string | null, driverId: string | null) {
  if (vehicleId) {
    const v = getVehicle(vehicleId);
    if (v.status === "maintenance" || v.status === "inactive") throw conflict(`${v.code} is ${v.status}`);
    const other = one(
      `SELECT code FROM trips WHERE vehicle_id = ? AND id != ? AND status IN ('dispatched','in_transit','arrived')`,
      [vehicleId, tripId],
    );
    if (other) throw conflict(`${v.code} is already committed to ${other.code}`);
  }
  if (driverId) {
    const other = one(
      `SELECT code FROM trips WHERE driver_id = ? AND id != ? AND status IN ('dispatched','in_transit','arrived')`,
      [driverId, tripId],
    );
    if (other) throw conflict(`Driver is already committed to ${other.code}`);
  }
}

function refreshAssets(t: Trip) {
  for (const v of [t.vehicleId, t.trailerId]) if (v) refreshVehicleStatus(v);
  if (t.driverId) refreshDriverStatus(t.driverId);
}

export function dispatchTrip(id: string, ctx: Ctx): Trip {
  return tx(() => {
    const t = getTrip(id);
    if (t.status === "dispatched") return t;
    if (t.status !== "planned") throw badRequest(`Trip is ${t.status}`);
    if (!t.vehicleId || !t.driverId) throw badRequest("Assign a vehicle and a driver before dispatching");
    assertAssetsFree(t.id, t.vehicleId, t.driverId);
    run("UPDATE trips SET status = 'dispatched' WHERE id = ?", [t.id]);
    const trip = getTrip(t.id);
    refreshAssets(trip);
    emit(ctx, {
      type: "trip.dispatched",
      tripId: t.id,
      siteId: t.originSiteId,
      vehicleId: t.vehicleId,
      driverId: t.driverId,
      message: `Trip ${tripLabel(trip)} dispatched`,
    });
    return trip;
  });
}

export function departTrip(id: string, ctx: Ctx): Trip {
  return tx(() => {
    let t = getTrip(id);
    if (["in_transit", "arrived", "completed"].includes(t.status)) return t;
    if (t.status === "cancelled") throw badRequest("Trip is cancelled");
    if (t.status === "planned") t = dispatchTrip(t.id, ctx);
    const when = at(ctx);
    run("UPDATE trips SET status = 'in_transit', actual_departure = ? WHERE id = ?", [when, t.id]);
    // A truck still checked in at the origin leaves through the gate with its trailer.
    for (const vid of [t.vehicleId, t.trailerId]) {
      if (!vid) continue;
      const visit = openVisitForVehicle(vid);
      if (visit && visit.siteId === t.originSiteId) {
        checkOut({ visitId: visit.id, sealNo: "", notes: `Departed on ${t.code}` }, ctx);
      }
    }
    const trip = getTrip(t.id);
    refreshAssets(trip);
    const late = Math.round((Date.parse(when) - Date.parse(t.plannedDeparture)) / MIN);
    emit(ctx, {
      type: "trip.departed",
      tripId: t.id,
      siteId: t.originSiteId,
      vehicleId: t.vehicleId,
      driverId: t.driverId,
      message: `Trip ${tripLabel(trip)} departed${late > ON_TIME_TOLERANCE_MINUTES ? ` (${late} min late)` : ""}`,
      payload: { lateMinutes: late },
    });
    return trip;
  });
}

export function arriveTrip(id: string, ctx: Ctx): Trip {
  return tx(() => {
    let t = getTrip(id);
    if (t.status === "arrived" || t.status === "completed") return t;
    if (t.status === "planned" || t.status === "dispatched") t = departTrip(t.id, ctx);
    if (t.status !== "in_transit") throw badRequest(`Trip is ${t.status}`);
    const when = at(ctx);
    run("UPDATE trips SET status = 'arrived', actual_arrival = ? WHERE id = ?", [when, t.id]);
    run(
      "UPDATE trip_stops SET arrived_at = COALESCE(arrived_at, ?), departed_at = COALESCE(departed_at, ?) WHERE trip_id = ?",
      [when, when, t.id],
    );
    if (t.vehicleId) {
      const km = siteDistanceKm(getSite(t.originSiteId), getSite(t.destinationSiteId)) * 1.25;
      run("UPDATE vehicles SET odometer_km = odometer_km + ? WHERE id IN (?, ?)", [km, t.vehicleId, t.trailerId]);
    }
    const trip = getTrip(t.id);
    refreshAssets(trip);
    const late = Math.round((Date.parse(when) - Date.parse(t.plannedArrival)) / MIN);
    emit(ctx, {
      type: "trip.arrived",
      tripId: t.id,
      siteId: t.destinationSiteId,
      vehicleId: t.vehicleId,
      driverId: t.driverId,
      message: `Trip ${tripLabel(trip)} arrived${late > ON_TIME_TOLERANCE_MINUTES ? ` (${late} min late)` : " on time"}`,
      payload: { lateMinutes: late },
    });
    return trip;
  });
}

export function completeTrip(id: string, ctx: Ctx): Trip {
  return tx(() => {
    let t = getTrip(id);
    if (t.status === "completed") return t;
    if (t.status !== "arrived") t = arriveTrip(t.id, ctx);
    run("UPDATE trips SET status = 'completed', completed_at = ? WHERE id = ?", [at(ctx), t.id]);
    const trip = getTrip(t.id);
    refreshAssets(trip);
    emit(ctx, {
      type: "trip.completed",
      tripId: t.id,
      siteId: t.destinationSiteId,
      vehicleId: t.vehicleId,
      driverId: t.driverId,
      message: `Trip ${tripLabel(trip)} completed`,
    });
    return trip;
  });
}

export function cancelTrip(id: string, ctx: Ctx): Trip {
  return tx(() => {
    const t = getTrip(id);
    if (t.status === "cancelled") return t;
    if (!["planned", "dispatched"].includes(t.status)) throw badRequest(`Trip is ${t.status}; cannot cancel`);
    run("UPDATE trips SET status = 'cancelled' WHERE id = ?", [t.id]);
    const trip = getTrip(t.id);
    refreshAssets(trip);
    emit(ctx, {
      type: "trip.cancelled",
      tripId: t.id,
      vehicleId: t.vehicleId,
      driverId: t.driverId,
      message: `Trip ${t.code} cancelled`,
    });
    return trip;
  });
}

export function stopEvent(id: string, stopId: string, kind: "arrive" | "depart", ctx: Ctx): Trip {
  return tx(() => {
    const t = getTrip(id);
    if (t.status !== "in_transit") throw badRequest("Trip is not in transit");
    const stop = must(t.stops.find((s) => s.id === stopId), "Stop");
    const col = kind === "arrive" ? "arrived_at" : "departed_at";
    run(`UPDATE trip_stops SET ${col} = COALESCE(${col}, ?) WHERE id = ?`, [at(ctx), stop.id]);
    if (kind === "depart") {
      run("UPDATE trip_stops SET arrived_at = COALESCE(arrived_at, ?) WHERE id = ?", [at(ctx), stop.id]);
    }
    const site = getSite(stop.siteId);
    emit(ctx, {
      type: kind === "arrive" ? "trip.stop_arrived" : "trip.stop_departed",
      tripId: t.id,
      siteId: stop.siteId,
      vehicleId: t.vehicleId,
      driverId: t.driverId,
      message: `Trip ${t.code} ${kind === "arrive" ? "reached" : "left"} stop ${stop.seq} (${site.code})`,
    });
    return getTrip(t.id);
  });
}

export function reportIssue(id: string, input: TripIssueInput, ctx: Ctx) {
  return tx(() => {
    const t = getTrip(id);
    const event = emit(ctx, {
      type: "trip.issue",
      tripId: t.id,
      vehicleId: t.vehicleId,
      driverId: t.driverId,
      message: `${t.code} ${input.kind}: ${input.message}`,
      payload: { kind: input.kind, lat: input.lat ?? null, lng: input.lng ?? null },
    });
    if (input.kind === "breakdown" && t.vehicleId) {
      openMaintenance(
        { vehicleId: t.vehicleId, kind: "breakdown", description: `Reported on ${t.code}: ${input.message}` },
        ctx,
      );
    }
    return event;
  });
}
