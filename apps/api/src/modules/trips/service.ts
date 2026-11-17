import {
  ON_TIME_TOLERANCE_MINUTES,
  TripInputSchema,
  TripPatchSchema,
  TripQuerySchema,
  type Trip,
  type TripCompleteInput,
  type TripIssueInput,
  type TripStop,
  type Waybill,
} from "@corelogistics/contracts";
import type { z } from "zod";
import { many, newId, nextCode, one, placeholders, run, splitList, tx, type Row } from "../../db.js";
import { badRequest, conflict, must } from "../../errors.js";
import { at, emit, listEvents, type Ctx } from "../../events.js";
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
/** A plan older than this was left over from an earlier day, not a promise for the job being started now. */
const STALE_MS = 12 * 60 * MIN;

function refreshedPlan(plannedDeparture: string, plannedArrival: string, startMs: number, nowMs: number) {
  const duration = Math.max(30 * MIN, Date.parse(plannedArrival) - Date.parse(plannedDeparture));
  const arrivalMs = Math.max(startMs + duration, nowMs + ON_TIME_TOLERANCE_MINUTES * MIN);
  return { departure: new Date(startMs).toISOString(), arrival: new Date(arrivalMs).toISOString() };
}

/** Moves open trips whose plan is from a previous day onto a window that starts when the work actually starts. */
export function rebaseStaleOpenTrips(now = Date.now()): number {
  const rows = many(
    `SELECT id, planned_departure, planned_arrival, actual_departure FROM trips
     WHERE status IN ('planned','dispatched','in_transit','arrived')`,
  );
  let moved = 0;
  for (const r of rows) {
    const pd = Date.parse(r.planned_departure);
    const left = r.actual_departure ? Date.parse(r.actual_departure) : null;
    const stale = now - pd > STALE_MS && (left === null || pd + ON_TIME_TOLERANCE_MINUTES * MIN < left);
    if (!stale) continue;
    const start = left ?? now + 45 * MIN;
    const next = refreshedPlan(r.planned_departure, r.planned_arrival, start, now);
    run("UPDATE trips SET planned_departure = ?, planned_arrival = ? WHERE id = ?", [next.departure, next.arrival, r.id]);
    moved += 1;
  }
  return moved;
}

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
    delayed: timing(r, now).delayed,
    delayMinutes: timing(r, now).delayMinutes,
    etaAt: timing(r, now).etaAt,
    podRecipient: r.pod_recipient ?? null,
    podNotes: r.pod_notes ?? "",
    podSignature: r.pod_signature ?? null,
    podAt: r.pod_at ?? null,
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
    if (t.status === "dispatched") assertAssetsFree(t.id, next.vehicleId, next.trailerId, next.driverId);
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

function assertAssetsFree(
  tripId: string,
  vehicleId: string | null,
  trailerId: string | null,
  driverId: string | null,
) {
  if (vehicleId) {
    const v = getVehicle(vehicleId);
    if (v.status === "maintenance" || v.status === "inactive") throw conflict(`${v.code} is ${v.status}`);
    const other = one(
      `SELECT code FROM trips WHERE vehicle_id = ? AND id != ? AND status IN ('dispatched','in_transit','arrived')`,
      [vehicleId, tripId],
    );
    if (other) throw conflict(`${v.code} is already committed to ${other.code}`);
  }
  if (trailerId) {
    const t = getVehicle(trailerId);
    if (t.status === "maintenance" || t.status === "inactive") throw conflict(`${t.code} is ${t.status}`);
    const other = one(
      `SELECT code FROM trips WHERE (trailer_id = ? OR vehicle_id = ?) AND id != ? AND status IN ('dispatched','in_transit','arrived')`,
      [trailerId, trailerId, tripId],
    );
    if (other) throw conflict(`${t.code} is already committed to ${other.code}`);
  }
  if (driverId) {
    const d = getDriver(driverId);
    if (d.status === "off_duty") throw conflict(`Driver ${d.name} is off_duty`);
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
    assertAssetsFree(t.id, t.vehicleId, t.trailerId, t.driverId);
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
    const t = getTrip(id);
    if (["in_transit", "arrived", "completed"].includes(t.status)) return t;
    if (t.status === "cancelled") throw badRequest("Trip is cancelled");
    if (t.status !== "dispatched") {
      throw badRequest("Trip must be dispatched before departure");
    }
    const when = at(ctx);
    const whenMs = Date.parse(when);
    let plannedDeparture = t.plannedDeparture;
    let plannedArrival = t.plannedArrival;
    if (whenMs - Date.parse(plannedDeparture) > STALE_MS) {
      const next = refreshedPlan(plannedDeparture, plannedArrival, whenMs, whenMs);
      plannedDeparture = next.departure;
      plannedArrival = next.arrival;
    }
    run("UPDATE trips SET status = 'in_transit', actual_departure = ?, planned_departure = ?, planned_arrival = ? WHERE id = ?", [
      when,
      plannedDeparture,
      plannedArrival,
      t.id,
    ]);
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
    const late = Math.round((Date.parse(when) - Date.parse(plannedDeparture)) / MIN);
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
    if (t.status === "cancelled") throw badRequest("Trip is cancelled");
    if (t.status === "planned") throw badRequest("Trip must be dispatched before arrival");
    if (t.status === "dispatched") t = departTrip(t.id, ctx);
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

export function completeTrip(id: string, ctx: Ctx, pod?: TripCompleteInput): Trip {
  return tx(() => {
    let t = getTrip(id);
    if (t.status === "completed") return t;
    if (t.status !== "arrived") t = arriveTrip(t.id, ctx);
    const when = at(ctx);
    const hasPod = Boolean(pod?.recipient || pod?.notes || pod?.signature || pod?.proofPhoto);
    run(
      "UPDATE trips SET status = 'completed', completed_at = ?, pod_recipient = ?, pod_notes = ?, pod_signature = ?, pod_at = ? WHERE id = ?",
      [when, pod?.recipient ?? null, pod?.notes ?? "", pod?.signature ?? null, hasPod ? when : null, t.id],
    );
    const trip = getTrip(t.id);
    refreshAssets(trip);
    const podMsg = pod?.recipient ? ` (signed by ${pod.recipient})` : "";
    emit(ctx, {
      type: "trip.completed",
      tripId: t.id,
      siteId: t.destinationSiteId,
      vehicleId: t.vehicleId,
      driverId: t.driverId,
      message: `Trip ${tripLabel(trip)} completed${podMsg}`,
      payload: hasPod ? { recipient: pod?.recipient, notes: pod?.notes, proofPhoto: pod?.proofPhoto ?? null } : undefined,
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
      payload: {
        kind: input.kind,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        proofPhoto: input.proofPhoto ?? null,
      },
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

export function getTripWaybill(id: string): Waybill {
  const trip = getTrip(id);
  const origin = getSite(trip.originSiteId);
  const destination = getSite(trip.destinationSiteId);
  const vehicle = trip.vehicleId ? getVehicle(trip.vehicleId) : null;
  const trailer = trip.trailerId ? getVehicle(trip.trailerId) : null;
  const driver = trip.driverId ? getDriver(trip.driverId) : null;

  const shipments = many<{ id: string; code: string; status: string; dock_code: string | null }>(
    `SELECT s.id, s.code, s.status, l.code AS dock_code
     FROM shipments s
     LEFT JOIN locations l ON l.id = s.dock_location_id
     WHERE s.trip_id = ?
     ORDER BY s.created_at ASC`,
    [trip.id],
  ).map((s) => ({ id: s.id, code: s.code, status: s.status, dockCode: s.dock_code ?? null }));

  const shipmentIds = shipments.map((s) => s.id);
  const lines = shipmentIds.length
    ? many<{
        order_code: string;
        customer_name: string;
        sku_code: string;
        sku_name: string;
        qty: number;
        picked_qty: number;
        unit_weight_kg: number;
      }>(
        `SELECT o.code AS order_code, cs.name AS customer_name, sk.code AS sku_code, sk.name AS sku_name,
                ol.qty, ol.picked_qty, sk.unit_weight_kg
         FROM orders o
         JOIN sites cs ON cs.id = o.customer_site_id
         JOIN order_lines ol ON ol.order_id = o.id
         JOIN skus sk ON sk.id = ol.sku_id
         WHERE o.shipment_id IN (${placeholders(shipmentIds.length)})
         ORDER BY o.code, sk.code`,
        shipmentIds,
      ).map((r) => ({
        orderCode: r.order_code,
        customerName: r.customer_name,
        skuCode: r.sku_code,
        skuName: r.sku_name,
        qty: Number(r.qty),
        pickedQty: Number(r.picked_qty),
        unitWeightKg: Number(r.unit_weight_kg),
      }))
    : [];

  const handlingUnits = shipmentIds.length
    ? many<{
        code: string;
        kind: string;
        sku_code: string;
        sku_name: string;
        qty: number;
        lot_number: string | null;
        expiry_date: string | null;
        unit_weight_kg: number;
      }>(
        `SELECT h.code, h.kind, sk.code AS sku_code, sk.name AS sku_name, h.qty,
                h.lot_number, h.expiry_date, sk.unit_weight_kg
         FROM handling_units h
         JOIN skus sk ON sk.id = h.sku_id
         WHERE h.shipment_id IN (${placeholders(shipmentIds.length)})
         ORDER BY h.code`,
        shipmentIds,
      ).map((h) => ({
        code: h.code,
        kind: h.kind,
        skuCode: h.sku_code,
        skuName: h.sku_name,
        qty: Number(h.qty),
        lotNumber: h.lot_number ?? null,
        expiryDate: h.expiry_date ?? null,
      }))
    : [];

  const totalUnits = lines.length
    ? lines.reduce((sum, l) => sum + l.qty, 0)
    : handlingUnits.reduce((sum, h) => sum + h.qty, 0);

  const totalWeightKg = Math.round(
    lines.length
      ? lines.reduce((sum, l) => sum + l.qty * l.unitWeightKg, 0)
      : 0,
  );

  const events = listEvents({ tripId: trip.id, limit: 100 });
  const proofPhotos = events
    .map((e) => ({
      label: e.message,
      dataUrl: typeof e.payload?.proofPhoto === "string" ? e.payload.proofPhoto : null,
    }))
    .filter((p): p is { label: string; dataUrl: string } => Boolean(p.dataUrl));

  return {
    trip,
    origin,
    destination,
    vehiclePlate: vehicle?.plate ?? null,
    trailerCode: trailer?.code ?? null,
    driverName: driver?.name ?? null,
    driverPhone: driver?.phone ?? null,
    shipments,
    lines,
    handlingUnits,
    totalUnits,
    totalWeightKg,
    proofPhotos,
    generatedAt: new Date().toISOString(),
  };
}
