import {
  DriverInputSchema,
  DriverPatchSchema,
  MaintenanceInputSchema,
  VehicleInputSchema,
  VehiclePatchSchema,
  type Driver,
  type MaintenanceRecord,
  type Vehicle,
  type VehicleStatus,
} from "@corelogistics/contracts";
import type { z } from "zod";
import { many, newId, one, run, tx, type Row } from "../../db.js";
import { badRequest, conflict, must } from "../../errors.js";
import { at, emit, type Ctx } from "../../events.js";

export function normalizePlate(plate: string): string {
  return plate.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function toVehicle(r: Row): Vehicle {
  return {
    id: r.id,
    code: r.code,
    plate: r.plate,
    kind: r.kind,
    model: r.model,
    capacityKg: r.capacity_kg,
    capacityM3: r.capacity_m3,
    status: r.status,
    homeSiteId: r.home_site_id ?? null,
    currentSiteId: r.current_site_id ?? null,
    odometerKm: Math.round(r.odometer_km),
    rfidTag: r.rfid_tag ?? null,
    lastLat: r.last_lat ?? null,
    lastLng: r.last_lng ?? null,
    lastSeenAt: r.last_seen_at ?? null,
  };
}

export function listVehicles(): Vehicle[] {
  return many("SELECT * FROM vehicles ORDER BY kind, code").map(toVehicle);
}

export function getVehicle(id: string): Vehicle {
  return toVehicle(must(one("SELECT * FROM vehicles WHERE id = ?", [id]), "Vehicle"));
}

export function findVehicleByPlate(plate: string): Vehicle | undefined {
  const wanted = normalizePlate(plate);
  const row = many("SELECT * FROM vehicles").find((r) => normalizePlate(r.plate) === wanted);
  return row ? toVehicle(row) : undefined;
}

export function findVehicleByTag(tag: string): Vehicle | undefined {
  const row = one("SELECT * FROM vehicles WHERE rfid_tag = ?", [tag]);
  return row ? toVehicle(row) : undefined;
}

/**
 * Vehicle status is derived from state rather than set by hand:
 * inactive > maintenance > at a site (dock / yard) > on a trip > available.
 */
export function refreshVehicleStatus(vehicleId: string): VehicleStatus {
  const v = one("SELECT status FROM vehicles WHERE id = ?", [vehicleId]);
  if (!v) return "available";
  let status: VehicleStatus;
  const visit = one(
    "SELECT status FROM gate_visits WHERE vehicle_id = ? AND check_out_at IS NULL ORDER BY check_in_at DESC LIMIT 1",
    [vehicleId],
  );
  if (v.status === "inactive") status = "inactive";
  else if (one("SELECT 1 FROM maintenance_records WHERE vehicle_id = ? AND closed_at IS NULL", [vehicleId])) {
    status = "maintenance";
  } else if (visit) status = visit.status === "at_dock" ? "at_dock" : "in_yard";
  else if (
    one(
      `SELECT 1 FROM trips WHERE (vehicle_id = ? OR trailer_id = ?) AND status IN ('in_transit', 'arrived')`,
      [vehicleId, vehicleId],
    )
  ) {
    status = "on_trip";
  } else status = "available";
  if (status !== v.status) run("UPDATE vehicles SET status = ? WHERE id = ?", [status, vehicleId]);
  return status;
}

export function createVehicle(input: z.output<typeof VehicleInputSchema>, ctx: Ctx): Vehicle {
  return tx(() => {
    if (one("SELECT 1 FROM vehicles WHERE code = ?", [input.code])) throw conflict(`Code ${input.code} exists`);
    if (findVehicleByPlate(input.plate)) throw conflict(`Plate ${input.plate} is already registered`);
    const id = newId("veh");
    run(
      `INSERT INTO vehicles (id, code, plate, kind, model, capacity_kg, capacity_m3, status, home_site_id, odometer_km, rfid_tag)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)`,
      [
        id,
        input.code,
        input.plate.toUpperCase(),
        input.kind,
        input.model,
        input.capacityKg,
        input.capacityM3,
        input.homeSiteId ?? null,
        input.odometerKm,
        input.rfidTag ?? null,
      ],
    );
    emit(ctx, { type: "vehicle.created", vehicleId: id, message: `${input.kind} ${input.code} (${input.plate}) registered` });
    return getVehicle(id);
  });
}

export function updateVehicle(id: string, patch: z.output<typeof VehiclePatchSchema>, ctx: Ctx): Vehicle {
  return tx(() => {
    const cur = getVehicle(id);
    if (patch.plate) {
      const other = findVehicleByPlate(patch.plate);
      if (other && other.id !== id) throw conflict(`Plate ${patch.plate} is already registered`);
    }
    if (patch.status === "inactive" && !["available", "maintenance"].includes(cur.status)) {
      throw badRequest(`Vehicle is ${cur.status}; finish its trip or visit first`);
    }
    run(
      `UPDATE vehicles SET code = ?, plate = ?, kind = ?, model = ?, capacity_kg = ?, capacity_m3 = ?, home_site_id = ?,
       odometer_km = ?, rfid_tag = ?, status = ? WHERE id = ?`,
      [
        patch.code ?? cur.code,
        (patch.plate ?? cur.plate).toUpperCase(),
        patch.kind ?? cur.kind,
        patch.model ?? cur.model,
        patch.capacityKg ?? cur.capacityKg,
        patch.capacityM3 ?? cur.capacityM3,
        patch.homeSiteId === undefined ? cur.homeSiteId : patch.homeSiteId,
        patch.odometerKm ?? cur.odometerKm,
        patch.rfidTag === undefined ? cur.rfidTag : patch.rfidTag,
        patch.status ?? (cur.status === "inactive" ? "available" : cur.status),
        id,
      ],
    );
    if (patch.status !== "inactive") refreshVehicleStatus(id);
    emit(ctx, { type: "vehicle.updated", vehicleId: id, message: `Vehicle ${cur.code} updated`, payload: patch });
    return getVehicle(id);
  });
}

export function toDriver(r: Row): Driver {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    phone: r.phone,
    licenseClass: r.license_class,
    licenseExpiry: r.license_expiry,
    status: r.status,
    homeSiteId: r.home_site_id ?? null,
  };
}

export function listDrivers(): Driver[] {
  return many("SELECT * FROM drivers ORDER BY name").map(toDriver);
}

export function getDriver(id: string): Driver {
  return toDriver(must(one("SELECT * FROM drivers WHERE id = ?", [id]), "Driver"));
}

export function refreshDriverStatus(driverId: string) {
  const d = one("SELECT status FROM drivers WHERE id = ?", [driverId]);
  if (!d) return;
  const busy = one(
    "SELECT 1 FROM trips WHERE driver_id = ? AND status IN ('dispatched', 'in_transit', 'arrived')",
    [driverId],
  );
  const status = busy ? "on_trip" : d.status === "off_duty" ? "off_duty" : "available";
  if (status !== d.status) run("UPDATE drivers SET status = ? WHERE id = ?", [status, driverId]);
}

export function createDriver(input: z.output<typeof DriverInputSchema>, ctx: Ctx): Driver {
  return tx(() => {
    if (one("SELECT 1 FROM drivers WHERE code = ?", [input.code])) throw conflict(`Code ${input.code} exists`);
    const id = newId("drv");
    run(
      `INSERT INTO drivers (id, code, name, phone, license_class, license_expiry, status, home_site_id)
       VALUES (?, ?, ?, ?, ?, ?, 'available', ?)`,
      [id, input.code, input.name, input.phone, input.licenseClass, input.licenseExpiry, input.homeSiteId ?? null],
    );
    emit(ctx, { type: "driver.created", driverId: id, message: `Driver ${input.name} added` });
    return getDriver(id);
  });
}

export function updateDriver(id: string, patch: z.output<typeof DriverPatchSchema>, ctx: Ctx): Driver {
  return tx(() => {
    const cur = getDriver(id);
    if (patch.status === "off_duty" && cur.status === "on_trip") {
      throw badRequest("Driver is on a trip");
    }
    run(
      `UPDATE drivers SET code = ?, name = ?, phone = ?, license_class = ?, license_expiry = ?, home_site_id = ?, status = ? WHERE id = ?`,
      [
        patch.code ?? cur.code,
        patch.name ?? cur.name,
        patch.phone ?? cur.phone,
        patch.licenseClass ?? cur.licenseClass,
        patch.licenseExpiry ?? cur.licenseExpiry,
        patch.homeSiteId === undefined ? cur.homeSiteId : patch.homeSiteId,
        patch.status ?? cur.status,
        id,
      ],
    );
    refreshDriverStatus(id);
    emit(ctx, { type: "driver.updated", driverId: id, message: `Driver ${cur.name} updated`, payload: patch });
    return getDriver(id);
  });
}

export function toMaintenance(r: Row): MaintenanceRecord {
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    kind: r.kind,
    description: r.description,
    openedAt: r.opened_at,
    closedAt: r.closed_at ?? null,
    costCents: r.cost_cents,
    odometerKm: r.odometer_km ?? null,
  };
}

export function listMaintenance(filter: { vehicleId?: string; open?: boolean }): MaintenanceRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.vehicleId) {
    where.push("vehicle_id = ?");
    params.push(filter.vehicleId);
  }
  if (filter.open !== undefined) where.push(filter.open ? "closed_at IS NULL" : "closed_at IS NOT NULL");
  return many(
    `SELECT * FROM maintenance_records ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY opened_at DESC LIMIT 300`,
    params,
  ).map(toMaintenance);
}

export function openMaintenance(input: z.output<typeof MaintenanceInputSchema>, ctx: Ctx): MaintenanceRecord {
  return tx(() => {
    const v = getVehicle(input.vehicleId);
    const id = newId("mnt");
    const openedAt = input.openedAt ?? at(ctx);
    run(
      `INSERT INTO maintenance_records (id, vehicle_id, kind, description, opened_at, odometer_km) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, v.id, input.kind, input.description, openedAt, input.odometerKm ?? v.odometerKm],
    );
    refreshVehicleStatus(v.id);
    emit(
      { ...ctx, occurredAt: openedAt },
      {
        type: "maintenance.opened",
        vehicleId: v.id,
        entityId: id,
        message: `${v.code} ${input.kind}: ${input.description}`,
      },
    );
    return toMaintenance(one("SELECT * FROM maintenance_records WHERE id = ?", [id])!);
  });
}

export function closeMaintenance(id: string, costCents: number, ctx: Ctx): MaintenanceRecord {
  return tx(() => {
    const r = must(one("SELECT * FROM maintenance_records WHERE id = ?", [id]), "Maintenance record");
    if (r.closed_at) throw badRequest("Already closed");
    run("UPDATE maintenance_records SET closed_at = ?, cost_cents = ? WHERE id = ?", [at(ctx), costCents, id]);
    refreshVehicleStatus(r.vehicle_id);
    const v = getVehicle(r.vehicle_id);
    emit(ctx, {
      type: "maintenance.closed",
      vehicleId: v.id,
      entityId: id,
      message: `${v.code} back in service after ${r.kind}`,
      payload: { costCents },
    });
    return toMaintenance(one("SELECT * FROM maintenance_records WHERE id = ?", [id])!);
  });
}
