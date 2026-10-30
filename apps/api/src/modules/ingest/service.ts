import { createHash, randomBytes } from "node:crypto";
import {
  DeviceInputSchema,
  type Device,
  type IngestInput,
  type IngestResult,
  type Location,
  type Vehicle,
} from "@corelogistics/contracts";
import type { z } from "zod";
import { many, newId, nowIso, one, run, toBool, tx, type Row } from "../../db.js";
import { badRequest, conflict, HttpError, must, unauthorized } from "../../errors.js";
import { emit, type Ctx } from "../../events.js";
import { findVehicleByPlate, findVehicleByTag, getVehicle } from "../fleet/service.js";
import { assignDock, checkIn, checkOut, moveInYard, openVisitForVehicle, releaseDock } from "../gate/service.js";
import { loadShipment, listShipments } from "../outbound/service.js";
import { distanceM, getLocation, getSite } from "../sites/service.js";
import { arriveTrip, departTrip } from "../trips/service.js";
import { confirmPutaway, findHuByCode, openPutawayForHu } from "../warehouse/service.js";

export function hashKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

function toDevice(r: Row): Device {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    siteId: r.site_id ?? null,
    locationId: r.location_id ?? null,
    vehicleId: r.vehicle_id ?? null,
    active: toBool(r.active),
    lastSeenAt: r.last_seen_at ?? null,
    createdAt: r.created_at,
  };
}

export function listDevices(): Device[] {
  return many("SELECT * FROM devices ORDER BY kind, code").map(toDevice);
}

export function createDevice(
  input: z.output<typeof DeviceInputSchema>,
  ctx: Ctx,
  fixedKey?: string,
): { device: Device; apiKey: string } {
  return tx(() => {
    if (one("SELECT 1 FROM devices WHERE code = ?", [input.code])) throw conflict(`Device ${input.code} exists`);
    let siteId = input.siteId ?? null;
    if (input.locationId) siteId = getLocation(input.locationId).siteId;
    if (input.vehicleId) getVehicle(input.vehicleId);
    const apiKey = fixedKey ?? `cld_${randomBytes(18).toString("base64url")}`;
    const id = newId("dev");
    run(
      `INSERT INTO devices (id, code, name, kind, site_id, location_id, vehicle_id, api_key_hash, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [id, input.code, input.name, input.kind, siteId, input.locationId ?? null, input.vehicleId ?? null, hashKey(apiKey), nowIso()],
    );
    emit(ctx, { type: "device.created", siteId, entityId: id, message: `${input.kind} ${input.code} registered` });
    return { device: toDevice(one("SELECT * FROM devices WHERE id = ?", [id])!), apiKey };
  });
}

export function setDeviceActive(id: string, active: boolean): Device {
  must(one("SELECT 1 FROM devices WHERE id = ?", [id]), "Device");
  run("UPDATE devices SET active = ? WHERE id = ?", [active, id]);
  return toDevice(one("SELECT * FROM devices WHERE id = ?", [id])!);
}

export function authenticateDevice(key: string | undefined): Device {
  if (!key) throw unauthorized("x-device-key header required");
  const r = one("SELECT * FROM devices WHERE api_key_hash = ?", [hashKey(key)]);
  if (!r || !toBool(r.active)) throw unauthorized("Unknown or disabled device key");
  return toDevice(r);
}

interface Outcome {
  accepted: boolean;
  action: string;
  detail: string;
  vehicleId?: string | null;
  huId?: string | null;
  tripId?: string | null;
}

/** A vehicle seen at a fixed reader (camera or RFID) drives gate, dock and yard moves. */
function vehicleSeen(vehicle: Vehicle, loc: Location, direction: "in" | "out" | undefined, ctx: Ctx): Outcome {
  const open = openVisitForVehicle(vehicle.id);
  const base = { vehicleId: vehicle.id };
  if (loc.kind === "gate") {
    if (open && open.siteId === loc.siteId) {
      if (direction === "in") return { ...base, accepted: false, action: "ignored", detail: `${vehicle.plate} already inside` };
      const v = checkOut({ visitId: open.id, sealNo: "", notes: "" }, ctx);
      return { ...base, accepted: true, action: "gate.check_out", detail: `${vehicle.plate} checked out after ${v.dwellMinutes} min` };
    }
    if (direction === "out") return { ...base, accepted: false, action: "ignored", detail: `${vehicle.plate} is not inside` };
    const v = checkIn({ siteId: loc.siteId, vehicleId: vehicle.id, sealNo: "", notes: "" }, ctx);
    return {
      ...base,
      tripId: v.tripId,
      accepted: true,
      action: "gate.check_in",
      detail: `${vehicle.plate} checked in${v.tripCode ? ` for ${v.tripCode}` : ""}${v.yardCode ? `, yard ${v.yardCode}` : ""}`,
    };
  }
  if (!open || open.siteId !== loc.siteId) {
    return { ...base, accepted: false, action: "ignored", detail: `${vehicle.plate} has no open gate visit at this site` };
  }
  if (loc.kind === "dock_door") {
    if (open.dock?.locationId === loc.id) {
      if (direction === "out") {
        releaseDock(open.id, ctx);
        return { ...base, accepted: true, action: "dock.released", detail: `${vehicle.plate} left ${loc.code}` };
      }
      return { ...base, accepted: false, action: "ignored", detail: `${vehicle.plate} already at ${loc.code}` };
    }
    assignDock(open.id, { locationId: loc.id }, ctx);
    return { ...base, accepted: true, action: "dock.assigned", detail: `${vehicle.plate} docked at ${loc.code}` };
  }
  if (loc.kind === "yard_slot") {
    if (open.status !== "in_yard") return { ...base, accepted: false, action: "ignored", detail: "Vehicle is at a dock" };
    if (open.yardLocationId === loc.id) return { ...base, accepted: false, action: "ignored", detail: "Already there" };
    moveInYard(open.id, loc.id, ctx);
    return { ...base, accepted: true, action: "yard.moved", detail: `${vehicle.plate} parked at ${loc.code}` };
  }
  return { ...base, accepted: false, action: "ignored", detail: `No vehicle rule for a ${loc.kind} reader` };
}

/** An RFID-tagged handling unit read at a bin confirms putaway; at a dock it loads. */
function huSeen(tag: string, loc: Location, ctx: Ctx): Outcome {
  const hu = findHuByCode(tag);
  const base = { huId: hu.id };
  if (loc.kind === "bin") {
    const task = openPutawayForHu(hu.id);
    if (!task) return { ...base, accepted: false, action: "ignored", detail: `${hu.code} has no open putaway` };
    confirmPutaway(task.id, loc.id, ctx);
    return { ...base, accepted: true, action: "putaway.done", detail: `${hu.code} stored in ${loc.code}` };
  }
  if (loc.kind === "dock_door") {
    const shipment = listShipments(loc.siteId, "planning,loading").find((s) => s.dockLocationId === loc.id);
    if (!shipment) return { ...base, accepted: false, action: "ignored", detail: `No shipment loading at ${loc.code}` };
    loadShipment(shipment.id, [hu.id], ctx);
    return { ...base, accepted: true, action: "hu.loaded", detail: `${hu.code} loaded on ${shipment.code}` };
  }
  return { ...base, accepted: false, action: "ignored", detail: `No unit rule for a ${loc.kind} reader` };
}

const lastPositionEvent = new Map<string, number>();
const POSITION_EVENT_EVERY_MS = 5 * 60_000;

function gpsPing(device: Device, input: Extract<IngestInput, { type: "gps_ping" }>, ctx: Ctx): Outcome {
  if (!device.vehicleId) throw badRequest("GPS unit is not bound to a vehicle");
  const vehicle = getVehicle(device.vehicleId);
  const when = ctx.occurredAt ?? nowIso();
  run("UPDATE vehicles SET last_lat = ?, last_lng = ?, last_seen_at = ? WHERE id = ?", [input.lat, input.lng, when, vehicle.id]);
  const base = { vehicleId: vehicle.id };

  const active = one(
    `SELECT * FROM trips WHERE vehicle_id = ? AND status IN ('dispatched','in_transit') ORDER BY planned_departure LIMIT 1`,
    [vehicle.id],
  );
  if (active) {
    const origin = getSite(active.origin_site_id);
    const dest = getSite(active.destination_site_id);
    const toDest = distanceM(input.lat, input.lng, dest.lat, dest.lng);
    if (active.status === "in_transit" && toDest <= dest.geofenceM) {
      arriveTrip(active.id, ctx);
      return { ...base, tripId: active.id, accepted: true, action: "trip.arrived", detail: `Entered ${dest.code} geofence` };
    }
    const fromOrigin = distanceM(input.lat, input.lng, origin.lat, origin.lng);
    if (active.status === "dispatched" && fromOrigin > origin.geofenceM && !openVisitForVehicle(vehicle.id)) {
      departTrip(active.id, ctx);
      return { ...base, tripId: active.id, accepted: true, action: "trip.departed", detail: `Left ${origin.code} geofence` };
    }
  }
  const last = lastPositionEvent.get(vehicle.id) ?? 0;
  if (Date.now() - last >= POSITION_EVENT_EVERY_MS) {
    lastPositionEvent.set(vehicle.id, Date.now());
    return {
      ...base,
      tripId: active?.id ?? null,
      accepted: true,
      action: "vehicle.position",
      detail: `${vehicle.code} at ${input.lat.toFixed(4)}, ${input.lng.toFixed(4)}${input.speedKph != null ? ` ${Math.round(input.speedKph)} km/h` : ""}`,
    };
  }
  return { ...base, accepted: true, action: "position.updated", detail: "Position stored" };
}

export function ingest(device: Device, input: IngestInput): IngestResult {
  const ctx: Ctx = { source: device.kind, actor: device.code, occurredAt: input.occurredAt };
  run("UPDATE devices SET last_seen_at = ? WHERE id = ?", [nowIso(), device.id]);
  let outcome: Outcome;
  try {
    outcome = tx(() => {
      if (input.type === "gps_ping") {
        if (device.kind !== "gps") throw badRequest(`A ${device.kind} cannot send gps_ping`);
        return gpsPing(device, input, ctx);
      }
      if (!device.locationId) throw badRequest("Reader is not bound to a location");
      const loc = getLocation(device.locationId);
      if (input.type === "plate_read") {
        if (device.kind !== "camera") throw badRequest(`A ${device.kind} cannot send plate_read`);
        const vehicle = findVehicleByPlate(input.plate);
        if (!vehicle) return { accepted: false, action: "unknown_plate", detail: `Plate ${input.plate} is not registered` };
        return vehicleSeen(vehicle, loc, input.direction, ctx);
      }
      if (device.kind !== "rfid") throw badRequest(`A ${device.kind} cannot send rfid_read`);
      const vehicle = findVehicleByTag(input.tag);
      if (vehicle) return vehicleSeen(vehicle, loc, undefined, ctx);
      return huSeen(input.tag, loc, ctx);
    });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    outcome = { accepted: false, action: "rejected", detail: err.message };
  }
  if (outcome.action === "position.updated") {
    return { accepted: true, action: outcome.action, detail: outcome.detail, eventId: null };
  }
  const event = emit(ctx, {
    type: outcome.action === "vehicle.position" ? "vehicle.position" : "device.read",
    siteId: device.siteId,
    vehicleId: outcome.vehicleId ?? device.vehicleId,
    tripId: outcome.tripId ?? null,
    huId: outcome.huId ?? null,
    locationId: device.locationId,
    entityId: device.id,
    message: `${device.code}: ${outcome.detail}`,
    payload: { input, accepted: outcome.accepted, action: outcome.action },
  });
  return { accepted: outcome.accepted, action: outcome.action, detail: outcome.detail, eventId: event.id };
}
