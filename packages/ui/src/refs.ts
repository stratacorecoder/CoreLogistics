import type { Driver, Site, Sku, Vehicle } from "@corelogistics/contracts";
import { useMemo } from "react";
import { useApi } from "./live.js";

const fleetEvents = (e: { type: string }) =>
  e.type.startsWith("vehicle.") ||
  e.type.startsWith("driver.") ||
  e.type.startsWith("maintenance.") ||
  e.type.startsWith("trip.") ||
  e.type.startsWith("gate.") ||
  e.type.startsWith("dock.");

/** Reference data most screens need to turn ids into names. */
export function useRefs() {
  const sites = useApi<Site[]>("/sites", { live: (e) => e.type === "site.created" || e.type === "layout.saved" });
  const vehicles = useApi<Vehicle[]>("/vehicles", { live: fleetEvents });
  const drivers = useApi<Driver[]>("/drivers", { live: fleetEvents });
  const skus = useApi<Sku[]>("/skus", { live: false });
  const reloadVehicles = vehicles.reload;
  const reloadDrivers = drivers.reload;
  return useMemo(() => {
    const siteById = new Map((sites.data ?? []).map((s) => [s.id, s]));
    const vehicleById = new Map((vehicles.data ?? []).map((v) => [v.id, v]));
    const driverById = new Map((drivers.data ?? []).map((d) => [d.id, d]));
    const skuById = new Map((skus.data ?? []).map((s) => [s.id, s]));
    return {
      sites: sites.data,
      vehicles: vehicles.data,
      drivers: drivers.data,
      skus: skus.data,
      siteById,
      vehicleById,
      driverById,
      skuById,
      siteCode: (id: string | null | undefined) => (id ? siteById.get(id)?.code ?? "?" : "—"),
      siteName: (id: string | null | undefined) => (id ? siteById.get(id)?.name ?? "?" : "—"),
      plate: (id: string | null | undefined) => (id ? vehicleById.get(id)?.plate ?? "?" : "—"),
      vehicleLabel: (id: string | null | undefined) => {
        const v = id ? vehicleById.get(id) : undefined;
        return v ? `${v.code} · ${v.plate}` : "—";
      },
      driverName: (id: string | null | undefined) => (id ? driverById.get(id)?.name ?? "?" : "Unassigned"),
      reloadFleet: () => {
        reloadVehicles();
        reloadDrivers();
      },
    };
  }, [sites.data, vehicles.data, drivers.data, skus.data, reloadVehicles, reloadDrivers]);
}

export type Refs = ReturnType<typeof useRefs>;
