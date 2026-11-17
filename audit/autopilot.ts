/** Throwaway: auto-pilot on, no yard visits, medium vs critical reschedule-only. */
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.CORELOGISTICS_DB = path.join(root, "audit", "probe.db");
process.env.CORELOGISTICS_DEMO = "0";

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
  const { buildApp } = await import("../apps/api/src/app.ts");
  const { one, run } = await import("../apps/api/src/db.ts");
  const app = await buildApp({ logger: false });
  await app.ready();
  const token = JSON.parse(
    (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "ava", password: "planner" } })).body,
  ).token as string;
  const tower = { "x-session": token };
  run("UPDATE gate_visits SET status = 'departed', check_out_at = COALESCE(check_out_at, ?) WHERE check_out_at IS NULL", [
    new Date().toISOString(),
  ]);
  await app.inject({ method: "POST", url: "/copilot/config", headers: tower, payload: { autoPilot: true } });
  const whId = one<{ id: string }>("SELECT id FROM sites WHERE code = 'WH-C'")!.id;
  const depotId = one<{ id: string }>("SELECT id FROM sites WHERE code = 'DEP-N'")!.id;

  async function disrupt(n: number, kind: string) {
    run(
      `INSERT INTO vehicles (id, code, plate, kind, model, status, home_site_id) VALUES (?, ?, ?, 'truck', 'Audit', 'available', ?)`,
      [`veh_auto_${n}`, `VA-${n}`, `AP${String(n).padStart(4, "0")}`, depotId],
    );
    run(
      `INSERT INTO drivers (id, code, name, license_class, license_expiry, status, home_site_id) VALUES (?, ?, 'Audit', 'C', '2030-01-01', 'available', ?)`,
      [`drv_auto_${n}`, `DA-${n}`, depotId],
    );
    const now = Date.now();
    const created = await app.inject({
      method: "POST",
      url: "/trips",
      headers: tower,
      payload: {
        kind: "inbound",
        originSiteId: depotId,
        destinationSiteId: whId,
        vehicleId: `veh_auto_${n}`,
        driverId: `drv_auto_${n}`,
        plannedDeparture: new Date(now - 3 * 3600_000).toISOString(),
        plannedArrival: new Date(now - 30 * 60_000).toISOString(),
        notes: "",
      },
    });
    const trip = JSON.parse(created.body);
    await app.inject({ method: "POST", url: `/trips/${trip.id}/dispatch`, headers: tower });
    const dock = one<{ id: string }>(
      `SELECT l.id FROM locations l WHERE l.site_id = ? AND l.kind = 'dock_door' AND l.active = 1
         AND NOT EXISTS (
           SELECT 1 FROM dock_appointments a WHERE a.location_id = l.id AND a.status IN ('scheduled','checked_in') AND a.window_end > ?
         ) ORDER BY l.code LIMIT 1`,
      [whId, new Date().toISOString()],
    );
    if (!dock) return { tripId: trip.id, error: "no dock" };
    const booked = await app.inject({
      method: "POST",
      url: "/gate/appointments",
      headers: tower,
      payload: {
        siteId: whId,
        tripId: trip.id,
        plate: `AP${String(n).padStart(4, "0")}`,
        carrier: "Audit",
        purpose: "unload",
        locationId: dock.id,
        windowStart: new Date(now + 15 * 60_000).toISOString(),
        windowEnd: new Date(now + 45 * 60_000).toISOString(),
        notes: "",
      },
    });
    const issue = await app.inject({
      method: "POST",
      url: `/trips/${trip.id}/issues`,
      headers: tower,
      payload: { kind, message: `Audit ${kind}` },
    });
    const recs = JSON.parse(
      (await app.inject({ method: "GET", url: "/copilot/recommendations?limit=100", headers: tower })).body,
    ) as Array<{ tripId: string | null; status: string; severity: string; prescribedActions: Array<{ type: string }> }>;
    return {
      tripId: trip.id,
      book: booked.statusCode,
      issue: issue.statusCode,
      recs: recs.filter((rec) => rec.tripId === trip.id).map((rec) => ({
        status: rec.status,
        severity: rec.severity,
        actions: rec.prescribedActions.map((action) => action.type),
      })),
    };
  }

  const medium = await disrupt(1, "delay");
  const critical = await disrupt(2, "accident");
  await app.inject({ method: "POST", url: "/copilot/config", headers: tower, payload: { autoPilot: false } });
  await app.close();
  console.log(JSON.stringify({ medium, critical }, null, 2));
}
