/** Throwaway: medium dock-swap-only must stay pending while auto-pilot is on. */
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
  await app.inject({ method: "POST", url: "/copilot/config", headers: tower, payload: { autoPilot: true } });
  const whId = one<{ id: string }>("SELECT id FROM sites WHERE code = 'WH-C'")!.id;
  const depotId = one<{ id: string }>("SELECT id FROM sites WHERE code = 'DEP-N'")!.id;
  run(
    `INSERT INTO vehicles (id, code, plate, kind, model, status, home_site_id) VALUES ('veh_swap_1', 'VS-1', 'SW0001', 'truck', 'Audit', 'available', ?)`,
    [whId],
  );
  run(
    `INSERT INTO vehicles (id, code, plate, kind, model, status, home_site_id) VALUES ('veh_swap_2', 'VS-2', 'SW0002', 'truck', 'Audit', 'available', ?)`,
    [depotId],
  );
  run(
    `INSERT INTO drivers (id, code, name, license_class, license_expiry, status, home_site_id) VALUES ('drv_swap_2', 'DS-2', 'Audit', 'C', '2030-01-01', 'available', ?)`,
    [depotId],
  );
  const checked = await app.inject({
    method: "POST",
    url: "/gate/check-in",
    headers: tower,
    payload: { siteId: whId, vehicleId: "veh_swap_1", sealNo: "", notes: "" },
  });
  const now = Date.now();
  const created = await app.inject({
    method: "POST",
    url: "/trips",
    headers: tower,
    payload: {
      kind: "inbound",
      originSiteId: depotId,
      destinationSiteId: whId,
      vehicleId: "veh_swap_2",
      driverId: "drv_swap_2",
      plannedDeparture: new Date(now + 2 * 3600_000).toISOString(),
      plannedArrival: new Date(now + 6 * 3600_000).toISOString(),
      notes: "",
    },
  });
  const trip = JSON.parse(created.body);
  await app.inject({ method: "POST", url: `/trips/${trip.id}/dispatch`, headers: tower });
  const issue = await app.inject({
    method: "POST",
    url: `/trips/${trip.id}/issues`,
    headers: tower,
    payload: { kind: "delay", message: "Audit swap only" },
  });
  const recs = JSON.parse(
    (await app.inject({ method: "GET", url: "/copilot/recommendations?limit=100", headers: tower })).body,
  ) as Array<{ tripId: string | null; status: string; severity: string; prescribedActions: Array<{ type: string }> }>;
  await app.inject({ method: "POST", url: "/copilot/config", headers: tower, payload: { autoPilot: false } });
  await app.close();
  console.log(
    JSON.stringify(
      {
        checkIn: checked.statusCode,
        trip: created.statusCode,
        issue: issue.statusCode,
        recs: recs.filter((rec) => rec.tripId === trip.id),
      },
      null,
      2,
    ),
  );
}
