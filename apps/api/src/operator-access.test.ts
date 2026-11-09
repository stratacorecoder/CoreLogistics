import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { one, run } from "./db.js";
import { migrate } from "./migrate.js";
import { upsertUser } from "./modules/auth/service.js";
import { ensureDemoUsers, seedIfEmpty } from "./seed.js";

describe("Operator access", () => {
  let app: FastifyInstance;
  let towerToken: string;
  let driverToken: string;
  let otherToken: string;
  let gateToken: string;
  let ownTripId: string;

  before(async () => {
    migrate();
    seedIfEmpty();
    ensureDemoUsers();
    app = await buildApp({ logger: false });
    await app.ready();
    towerToken = JSON.parse((await app.inject({ method: "POST", url: "/auth/login", payload: { username: "ava", password: "planner" } })).payload).token;
    gateToken = JSON.parse((await app.inject({ method: "POST", url: "/auth/login", payload: { username: "rico", password: "yard" } })).payload).token;

    const origin = one<{ id: string }>("SELECT id FROM sites WHERE code = 'DEP-N'")!;
    const destination = one<{ id: string }>("SELECT id FROM sites WHERE code = 'WH-C'")!;
    const ownDriver = "drv_access_own";
    const otherDriver = "drv_access_other";
    run("DELETE FROM trips WHERE driver_id IN (?, ?) OR vehicle_id = 'veh_access'", [ownDriver, otherDriver]);
    run("DELETE FROM drivers WHERE id IN (?, ?)", [ownDriver, otherDriver]);
    run("DELETE FROM vehicles WHERE id = 'veh_access'");
    run(
      `INSERT INTO drivers (id, code, name, license_class, license_expiry, status, home_site_id) VALUES (?, 'D-OWN', 'Access Own', 'C', '2030-01-01', 'available', ?)`,
      [ownDriver, origin.id],
    );
    run(
      `INSERT INTO drivers (id, code, name, license_class, license_expiry, status, home_site_id) VALUES (?, 'D-OTH', 'Access Other', 'C', '2030-01-01', 'available', ?)`,
      [otherDriver, origin.id],
    );
    run(
      `INSERT INTO vehicles (id, code, plate, kind, model, capacity_kg, capacity_m3, status) VALUES ('veh_access', 'V-ACC', 'ACC-1', 'truck', 'Van', 1000, 8, 'available')`,
    );
    upsertUser({ username: "access-own", password: "drive", name: "Access Own", role: "driver", driverId: ownDriver });
    upsertUser({ username: "access-other", password: "drive", name: "Access Other", role: "driver", driverId: otherDriver });
    driverToken = JSON.parse((await app.inject({ method: "POST", url: "/auth/login", payload: { username: "access-own", password: "drive" } })).payload).token;
    otherToken = JSON.parse((await app.inject({ method: "POST", url: "/auth/login", payload: { username: "access-other", password: "drive" } })).payload).token;

    const created = await app.inject({
      method: "POST",
      url: "/trips",
      headers: { "x-session": towerToken },
      payload: {
        kind: "inbound",
        originSiteId: origin.id,
        destinationSiteId: destination.id,
        vehicleId: "veh_access",
        driverId: ownDriver,
        plannedDeparture: new Date(Date.now() - 60_000).toISOString(),
        plannedArrival: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    assert.equal(created.statusCode, 200, created.payload);
    ownTripId = JSON.parse(created.payload).id;
    const dispatched = await app.inject({ method: "POST", url: `/trips/${ownTripId}/dispatch`, headers: { "x-session": towerToken } });
    assert.equal(dispatched.statusCode, 200, dispatched.payload);
  });

  it("lets only the assigned driver move the trip, and keeps planning with Tower", async () => {
    const origin = one<{ id: string }>("SELECT id FROM sites WHERE code = 'DEP-N'")!;
    const destination = one<{ id: string }>("SELECT id FROM sites WHERE code = 'WH-C'")!;
    const blockedPlan = await app.inject({
      method: "POST",
      url: "/trips",
      headers: { "x-session": driverToken },
      payload: {
        kind: "inbound",
        originSiteId: origin.id,
        destinationSiteId: destination.id,
        plannedDeparture: new Date(Date.now() + 60_000).toISOString(),
        plannedArrival: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    assert.equal(blockedPlan.statusCode, 403, blockedPlan.payload);

    const blockedDepart = await app.inject({ method: "POST", url: `/trips/${ownTripId}/depart`, headers: { "x-session": otherToken } });
    assert.equal(blockedDepart.statusCode, 403, blockedDepart.payload);
    assert.match(JSON.parse(blockedDepart.payload).error, /another driver/);
    assert.equal(one<{ status: string }>("SELECT status FROM trips WHERE id = ?", [ownTripId])?.status, "dispatched");

    const hidden = await app.inject({ method: "GET", url: `/trips?driverId=${encodeURIComponent("drv_access_own")}`, headers: { "x-session": otherToken } });
    assert.equal(hidden.statusCode, 403, hidden.payload);

    const ownList = await app.inject({ method: "GET", url: "/trips?active=true", headers: { "x-session": driverToken } });
    assert.equal(ownList.statusCode, 200, ownList.payload);
    const ownTrips = JSON.parse(ownList.payload) as Array<{ id: string; driverId: string }>;
    assert.equal(ownTrips.every((trip) => trip.driverId === "drv_access_own"), true);
    assert.equal(ownTrips.some((trip) => trip.id === ownTripId), true);

    const departed = await app.inject({ method: "POST", url: `/trips/${ownTripId}/depart`, headers: { "x-session": driverToken } });
    assert.equal(departed.statusCode, 200, departed.payload);
    assert.equal(JSON.parse(departed.payload).status, "in_transit");
  });

  it("keeps an assigned trip planned until Tower dispatches it, so the yard still expects it", async () => {
    const origin = one<{ id: string }>("SELECT id FROM sites WHERE code = 'DEP-N'")!;
    const destination = one<{ id: string }>("SELECT id FROM sites WHERE code = 'WH-C'")!;
    run("DELETE FROM trips WHERE vehicle_id = 'veh_plan_wait' OR driver_id = 'drv_plan_wait'");
    run("DELETE FROM drivers WHERE id = 'drv_plan_wait'");
    run("DELETE FROM vehicles WHERE id = 'veh_plan_wait'");
    run(
      `INSERT INTO drivers (id, code, name, license_class, license_expiry, status, home_site_id) VALUES ('drv_plan_wait', 'D-WAIT', 'Plan Wait', 'C', '2030-01-01', 'available', ?)`,
      [origin.id],
    );
    run(
      `INSERT INTO vehicles (id, code, plate, kind, model, capacity_kg, capacity_m3, status) VALUES ('veh_plan_wait', 'V-WAIT', 'WAIT-1', 'truck', 'Van', 1000, 8, 'available')`,
    );
    upsertUser({ username: "plan-wait", password: "drive", name: "Plan Wait", role: "driver", driverId: "drv_plan_wait" });
    const driver = JSON.parse(
      (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "plan-wait", password: "drive" } })).payload,
    ).token as string;

    const created = await app.inject({
      method: "POST",
      url: "/trips",
      headers: { "x-session": towerToken },
      payload: {
        kind: "outbound",
        originSiteId: origin.id,
        destinationSiteId: destination.id,
        vehicleId: "veh_plan_wait",
        driverId: "drv_plan_wait",
        plannedDeparture: new Date(Date.now() + 30 * 60_000).toISOString(),
        plannedArrival: new Date(Date.now() + 90 * 60_000).toISOString(),
      },
    });
    assert.equal(created.statusCode, 200, created.payload);
    const tripId = JSON.parse(created.payload).id as string;

    const early = await app.inject({ method: "POST", url: `/trips/${tripId}/depart`, headers: { "x-session": driver } });
    assert.equal(early.statusCode, 400, early.payload);
    assert.match(JSON.parse(early.payload).error, /dispatched/);
    assert.equal(one<{ status: string }>("SELECT status FROM trips WHERE id = ?", [tripId])?.status, "planned");

    const beforeDispatch = await app.inject({
      method: "GET",
      url: `/gate/expected?siteId=${origin.id}`,
      headers: { "x-session": gateToken },
    });
    assert.equal(beforeDispatch.statusCode, 200, beforeDispatch.payload);
    const expectedPlanned = (JSON.parse(beforeDispatch.payload) as Array<{ id: string; status: string; direction: string }>).find(
      (trip) => trip.id === tripId,
    );
    assert.equal(expectedPlanned?.status, "planned");
    assert.equal(expectedPlanned?.direction, "collecting");

    const dispatched = await app.inject({ method: "POST", url: `/trips/${tripId}/dispatch`, headers: { "x-session": towerToken } });
    assert.equal(dispatched.statusCode, 200, dispatched.payload);
    assert.equal(JSON.parse(dispatched.payload).status, "dispatched");

    const afterDispatch = await app.inject({
      method: "GET",
      url: `/gate/expected?siteId=${origin.id}`,
      headers: { "x-session": gateToken },
    });
    const expectedDispatched = (JSON.parse(afterDispatch.payload) as Array<{ id: string; status: string; direction: string }>).find(
      (trip) => trip.id === tripId,
    );
    assert.equal(expectedDispatched?.status, "dispatched");
    assert.equal(expectedDispatched?.direction, "collecting");
  });

  it("rejects stock confirmation from a driver or a gate login", async () => {
    const body = { mode: "match", requestId: "access-confirm-01", entryMethod: "manual", huBarcode: "HU-1", binBarcode: "R01-1" };
    const driver = await app.inject({
      method: "POST",
      url: "/warehouse/putaway/put_missing/confirm",
      headers: { "x-session": driverToken },
      payload: body,
    });
    assert.equal(driver.statusCode, 403, driver.payload);
    assert.match(JSON.parse(driver.payload).error, /Warehouse role required/);
    const gate = await app.inject({
      method: "POST",
      url: "/outbound/picks/pck_missing/confirm",
      headers: { "x-session": gateToken },
      payload: { mode: "match", requestId: "access-pick-0001", entryMethod: "keyboard", huBarcode: "HU-1" },
    });
    assert.equal(gate.statusCode, 403, gate.payload);
  });
});
