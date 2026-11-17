import { migrate } from "./migrate.js";
import { rebaseStaleOpenOrders } from "./modules/outbound/service.js";
import { rebaseStaleOpenTrips } from "./modules/trips/service.js";
import { ensureDemoUsers, seedIfEmpty } from "./seed.js";

/** Demo data, demo logins, and moving old open jobs onto today are off unless asked for. */
export function demoMode(): boolean {
  const flag = process.env.CORELOGISTICS_DEMO;
  if (flag === "1") return true;
  if (flag === "0") return false;
  return process.argv.includes("--demo");
}

export function prepareDatabase() {
  const applied = migrate();
  if (!demoMode()) {
    return { applied, seeded: false, refreshedTrips: 0, refreshedOrders: 0 };
  }
  const seeded = seedIfEmpty();
  ensureDemoUsers();
  const refreshedTrips = rebaseStaleOpenTrips();
  const refreshedOrders = rebaseStaleOpenOrders();
  return { applied, seeded, refreshedTrips, refreshedOrders };
}
