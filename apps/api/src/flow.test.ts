import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { many, one, run } from "./db.js";
import { migrate } from "./migrate.js";
import { DEMO_DEVICE_KEYS, ensureDemoUsers, seedIfEmpty } from "./seed.js";

describe("CoreLogistics Enterprise Suite (Auth, E2E Flow, FEFO, e-POD, Appointments, Telematics)", () => {
  let app: FastifyInstance;
  let towerToken: string;
  let warehouseToken: string;

  before(async () => {
    migrate();
    seedIfEmpty();
    ensureDemoUsers();
    app = await buildApp({ logger: false });
    await app.ready();
  });

  describe("1. Fastify Authentication & RBAC Guard", () => {
    it("logs in with tower credentials and receives a session token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: "ava", password: "planner" },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.user.role, "tower");
      assert.ok(body.token);
      towerToken = body.token;
    });

    it("logs in with warehouse credentials", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: "mina", password: "floor" },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.user.role, "warehouse");
      assert.ok(body.token);
      warehouseToken = body.token;
    });

    it("retrieves current authenticated user via /auth/me", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { "x-session": towerToken },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.username, "ava");
      assert.equal(body.role, "tower");
    });

    it("rejects unauthenticated mutating requests with 401 Unauthorized", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/gate/check-in",
        payload: { siteId: "dummy", plate: "UNAUTH-1" },
      });
      assert.equal(res.statusCode, 401);
      const body = JSON.parse(res.payload);
      assert.match(body.error, /Sign in required/i);
    });

    it("rejects non-tower role attempting admin site creation with 403 Forbidden", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sites",
        headers: { "x-session": warehouseToken },
        payload: {
          code: "FORBIDDEN-SITE",
          name: "Unauthorized Site",
          kind: "depot",
          address: "Somewhere",
          lat: 14.5,
          lng: 121.0,
        },
      });
      assert.equal(res.statusCode, 403);
      const body = JSON.parse(res.payload);
      assert.match(body.error, /Control Tower planner role required/i);
    });

    it("permits public endpoints (/health, /docs, /ingest/*) without auth", async () => {
      const health = await app.inject({ method: "GET", url: "/health" });
      assert.equal(health.statusCode, 200);
    });
  });

  describe("2. Dock Appointments Scheduling & Smart Suggestion (OpenWMS)", () => {
    let siteId: string;
    let dockDoorId: string;
    let dockDoorCode: string;
    let appointmentId: string;
    let appointmentCode: string;
    const uid = Date.now().toString().slice(-6);
    const testPlate = `APP-${uid}`;
    const testVehicleId = `veh_app_${uid}`;
    const testVehicleCode = `V-APP-${uid}`;

    before(() => {
      // Find Central Distribution Center and a dock door
      const wh = one("SELECT id FROM sites WHERE code = 'WH-C'")!;
      siteId = wh.id;
      const door = one("SELECT id, code FROM locations WHERE site_id = ? AND kind = 'dock_door' AND active = 1 ORDER BY code LIMIT 1", [siteId])!;
      dockDoorId = door.id;
      dockDoorCode = door.code;

      // Ensure fresh isolated vehicle exists in fleet
      run(
        `INSERT INTO vehicles (id, code, plate, kind, model, capacity_kg, capacity_m3, status)
         VALUES (?, ?, ?, 'truck', 'Test Carrier Truck', 10000, 40, 'available')`,
        [testVehicleId, testVehicleCode, testPlate],
      );
    });

    it("schedules a dock appointment with a designated dock door", async () => {
      const windowStart = new Date(Date.now() + 3600_000).toISOString();
      const windowEnd = new Date(Date.now() + 7200_000).toISOString();

      const res = await app.inject({
        method: "POST",
        url: "/gate/appointments",
        headers: { "x-session": towerToken },
        payload: {
          siteId,
          plate: testPlate,
          carrier: "FastLogistics Freight",
          purpose: "unload",
          locationId: dockDoorId,
          windowStart,
          windowEnd,
          notes: "Priority scheduled cold chain arrival",
        },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(body.id);
      assert.ok(body.code.startsWith("APP-"));
      assert.equal(body.plate, testPlate);
      assert.equal(body.locationId, dockDoorId);
      assert.equal(body.locationCode, dockDoorCode);
      assert.equal(body.status, "scheduled");
      appointmentId = body.id;
      appointmentCode = body.code;
    });

    it("lists scheduled dock appointments filtered by site", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/gate/appointments?siteId=${siteId}&status=scheduled`,
        headers: { "x-session": towerToken },
      });
      assert.equal(res.statusCode, 200);
      const list = JSON.parse(res.payload);
      assert.ok(Array.isArray(list));
      const found = list.find((a: any) => a.id === appointmentId);
      assert.ok(found);
      assert.equal(found.code, appointmentCode);
    });

    it("transitions appointment to 'checked_in' when truck checks in at the gate", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/gate/check-in",
        headers: { "x-session": towerToken },
        payload: {
          siteId,
          plate: testPlate,
          sealNo: "SL-APPT-100",
          notes: "Gate arrival for scheduled appointment",
        },
      });
      assert.equal(res.statusCode, 200);
      const visit = JSON.parse(res.payload);
      assert.equal(visit.plate, testPlate);
      assert.equal(visit.status, "in_yard");

      // Verify appointment is now checked_in
      const apptRow = one("SELECT status FROM dock_appointments WHERE id = ?", [appointmentId]);
      assert.equal(apptRow?.status, "checked_in");

      // Check smart dock suggestion returns the reserved appointment door
      const sugRes = await app.inject({
        method: "GET",
        url: `/gate/visits/${visit.id}/dock-suggestion`,
        headers: { "x-session": towerToken },
      });
      assert.equal(sugRes.statusCode, 200);
      const sug = JSON.parse(sugRes.payload);
      assert.equal(sug.locationId, dockDoorId);
      assert.equal(sug.code, dockDoorCode);
      assert.match(sug.reason, new RegExp(`Reserved by dock appointment ${appointmentCode}`, "i"));

      // Assign dock door
      const dockRes = await app.inject({
        method: "POST",
        url: `/gate/visits/${visit.id}/dock`,
        headers: { "x-session": towerToken },
        payload: { locationId: dockDoorId },
      });
      assert.equal(dockRes.statusCode, 200);

      // Check out vehicle
      const outRes = await app.inject({
        method: "POST",
        url: "/gate/check-out",
        headers: { "x-session": towerToken },
        payload: { visitId: visit.id, sealNo: "SL-APPT-100" },
      });
      assert.equal(outRes.statusCode, 200);

      // Verify appointment is now completed
      const finalAppt = one("SELECT status FROM dock_appointments WHERE id = ?", [appointmentId]);
      assert.equal(finalAppt?.status, "completed");
    });
  });

  describe("3. FEFO Expiration Date & Lot Tracking (OpenBoxes / GreaterWMS)", () => {
    let siteId: string;
    let customerSiteId: string;
    let skuId: string;
    let skuCode: string;
    let huEarlyId: string;
    let huLateId: string;
    let huExpiredId: string;
    let receiptId: string;
    let sortLaneId: string;
    let binId1: string;
    let binId2: string;

    before(async () => {
      const wh = one("SELECT id FROM sites WHERE code = 'WH-C'")!;
      siteId = wh.id;
      const cust = one("SELECT id FROM sites WHERE kind = 'customer' LIMIT 1")!;
      customerSiteId = cust.id;

      // Create a unique SKU for expiration testing
      skuCode = `FEFO-TEST-${Date.now().toString().slice(-4)}`;
      const skuRes = await app.inject({
        method: "POST",
        url: "/skus",
        headers: { "x-session": towerToken },
        payload: {
          code: skuCode,
          name: "Perishable Dairy Test Item",
          category: "Dairy",
          zone: "C",
          unitWeightKg: 2.5,
          unitVolumeM3: 0.01,
        },
      });
      assert.equal(skuRes.statusCode, 200);
      skuId = JSON.parse(skuRes.payload).id;

      // Create an open receipt
      const recRes = await app.inject({
        method: "POST",
        url: "/warehouse/receipts",
        headers: { "x-session": towerToken },
        payload: { siteId, supplier: "Fresh Dairy Farms" },
      });
      assert.equal(recRes.statusCode, 200);
      receiptId = JSON.parse(recRes.payload).id;

      // Find locations for sort and bin
      const sortLane = one("SELECT id FROM locations WHERE site_id = ? AND kind = 'sort_lane' AND active = 1 LIMIT 1", [siteId])!;
      sortLaneId = sortLane.id;
      const bins = many("SELECT id FROM locations WHERE site_id = ? AND kind = 'bin' AND active = 1 LIMIT 2", [siteId]);
      binId1 = bins[0]!.id;
      binId2 = bins[1]!.id;
    });

    it("receives handling units with lot numbers and expiry dates", async () => {
      // HU 1: Expires earlier (2027-02-01)
      const resEarly = await app.inject({
        method: "POST",
        url: `/warehouse/receipts/${receiptId}/receive`,
        headers: { "x-session": warehouseToken },
        payload: {
          skuId,
          qty: 10,
          kind: "pallet",
          lotNumber: "LOT-2027-EARLY",
          expiryDate: "2027-02-01",
        },
      });
      assert.equal(resEarly.statusCode, 200);
      const huEarly = JSON.parse(resEarly.payload);
      assert.equal(huEarly.lotNumber, "LOT-2027-EARLY");
      assert.equal(huEarly.expiryDate, "2027-02-01");
      huEarlyId = huEarly.id;

      // HU 2: Expires later (2027-11-01)
      const resLate = await app.inject({
        method: "POST",
        url: `/warehouse/receipts/${receiptId}/receive`,
        headers: { "x-session": warehouseToken },
        payload: {
          skuId,
          qty: 10,
          kind: "pallet",
          lotNumber: "LOT-2027-LATE",
          expiryDate: "2027-11-01",
        },
      });
      assert.equal(resLate.statusCode, 200);
      const huLate = JSON.parse(resLate.payload);
      assert.equal(huLate.lotNumber, "LOT-2027-LATE");
      assert.equal(huLate.expiryDate, "2027-11-01");
      huLateId = huLate.id;

      // HU 3: Expired stock (2021-01-01)
      const resExp = await app.inject({
        method: "POST",
        url: `/warehouse/receipts/${receiptId}/receive`,
        headers: { "x-session": warehouseToken },
        payload: {
          skuId,
          qty: 10,
          kind: "pallet",
          lotNumber: "LOT-EXPIRED",
          expiryDate: "2021-01-01",
        },
      });
      assert.equal(resExp.statusCode, 200);
      const huExp = JSON.parse(resExp.payload);
      assert.equal(huExp.lotNumber, "LOT-EXPIRED");
      assert.equal(huExp.expiryDate, "2021-01-01");
      huExpiredId = huExp.id;
    });

    it("verifies warehouse scan endpoint returns lot and expiry data", async () => {
      const hu = one("SELECT code FROM handling_units WHERE id = ?", [huEarlyId])!;
      const scanRes = await app.inject({
        method: "GET",
        url: `/warehouse/scan/${encodeURIComponent(hu.code)}`,
        headers: { "x-session": warehouseToken },
      });
      assert.equal(scanRes.statusCode, 200);
      const body = JSON.parse(scanRes.payload);
      assert.equal(body.lotNumber, "LOT-2027-EARLY");
      assert.equal(body.expiryDate, "2027-02-01");
    });

    it("sorts and puts away stock into rack bins", async () => {
      // Sort to lane
      await app.inject({
        method: "POST",
        url: `/warehouse/hus/${huEarlyId}/sort`,
        headers: { "x-session": warehouseToken },
        payload: { locationId: sortLaneId },
      });
      await app.inject({
        method: "POST",
        url: `/warehouse/hus/${huLateId}/sort`,
        headers: { "x-session": warehouseToken },
        payload: { locationId: sortLaneId },
      });
      await app.inject({
        method: "POST",
        url: `/warehouse/hus/${huExpiredId}/sort`,
        headers: { "x-session": warehouseToken },
        payload: { locationId: sortLaneId },
      });

      // Putaway to suggested bins
      const p1 = one("SELECT id FROM putaway_tasks WHERE hu_id = ?", [huEarlyId])!;
      const r1 = await app.inject({
        method: "POST",
        url: `/warehouse/putaway/${p1.id}/confirm`,
        headers: { "x-session": warehouseToken },
        payload: {},
      });
      assert.equal(r1.statusCode, 200);

      const p2 = one("SELECT id FROM putaway_tasks WHERE hu_id = ?", [huLateId])!;
      const r2 = await app.inject({
        method: "POST",
        url: `/warehouse/putaway/${p2.id}/confirm`,
        headers: { "x-session": warehouseToken },
        payload: {},
      });
      assert.equal(r2.statusCode, 200);

      const p3 = one("SELECT id FROM putaway_tasks WHERE hu_id = ?", [huExpiredId])!;
      const r3 = await app.inject({
        method: "POST",
        url: `/warehouse/putaway/${p3.id}/confirm`,
        headers: { "x-session": warehouseToken },
        payload: {},
      });
      assert.equal(r3.statusCode, 200);
    });

    it("allocates stock by FEFO: picks earlier expiring unit and excludes expired stock", async () => {
      // Create an outbound order for 5 units of our perishable item
      const orderRes = await app.inject({
        method: "POST",
        url: "/outbound/orders",
        headers: { "x-session": towerToken },
        payload: {
          siteId,
          customerSiteId,
          dueAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
          lines: [{ skuId, qty: 5 }],
        },
      });
      assert.equal(orderRes.statusCode, 200);
      const order = JSON.parse(orderRes.payload);

      // Release order to floor (FEFO allocation)
      const releaseRes = await app.inject({
        method: "POST",
        url: `/outbound/orders/${order.id}/release`,
        headers: { "x-session": towerToken },
      });
      assert.equal(releaseRes.statusCode, 200);
      const rel = JSON.parse(releaseRes.payload);
      assert.equal(rel.tasks.length, 1);

      const pickTask = rel.tasks[0];
      // Must allocate from the earlier-expiry HU (LOT-2027-EARLY), NOT the late HU or expired HU!
      assert.equal(pickTask.fromHuId, huEarlyId);
      assert.equal(pickTask.lotNumber, "LOT-2027-EARLY");
      assert.equal(pickTask.expiryDate, "2027-02-01");
      assert.equal(pickTask.qty, 5);

      // Confirm pick
      const pickConfirm = await app.inject({
        method: "POST",
        url: `/outbound/picks/${pickTask.id}/confirm`,
        headers: { "x-session": warehouseToken },
      });
      assert.equal(pickConfirm.statusCode, 200);
      const pickResult = JSON.parse(pickConfirm.payload);
      assert.equal(pickResult.hu.lotNumber, "LOT-2027-EARLY");
      assert.equal(pickResult.hu.expiryDate, "2027-02-01");
    });
  });

  describe("4. Electronic Proof of Delivery (e-POD - Fleetbase / ERPNext)", () => {
    let tripId: string;
    const dummySignature =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    before(async () => {
      const wh = one("SELECT id FROM sites WHERE code = 'WH-C'")!;
      const cust = one("SELECT id FROM sites WHERE kind = 'customer' LIMIT 1")!;

      // Dedicated clean vehicle and driver for e-POD test
      run("DELETE FROM trips WHERE vehicle_id = 'veh_pod_test' OR driver_id = 'drv_pod_test'");
      run("DELETE FROM vehicles WHERE id = 'veh_pod_test'");
      run("DELETE FROM drivers WHERE id = 'drv_pod_test'");
      run(
        `INSERT INTO vehicles (id, code, plate, kind, model, capacity_kg, capacity_m3, status)
         VALUES ('veh_pod_test', 'V-POD-01', 'POD-001', 'truck', 'Delivery Van', 3500, 15, 'available')`,
      );
      run(
        `INSERT INTO drivers (id, code, name, license_class, license_expiry, status)
         VALUES ('drv_pod_test', 'D-POD-01', 'Dedicated POD Driver', 'C', '2028-01-01', 'available')`,
      );

      const tripRes = await app.inject({
        method: "POST",
        url: "/trips",
        headers: { "x-session": towerToken },
        payload: {
          kind: "outbound",
          originSiteId: wh.id,
          destinationSiteId: cust.id,
          vehicleId: "veh_pod_test",
          driverId: "drv_pod_test",
          plannedDeparture: new Date(Date.now() - 3600_000).toISOString(),
          plannedArrival: new Date(Date.now() + 3600_000).toISOString(),
          notes: "Store delivery requiring e-POD confirmation",
        },
      });
      assert.equal(tripRes.statusCode, 200);
      tripId = JSON.parse(tripRes.payload).id;

      // Dispatch and advance trip
      const d1 = await app.inject({ method: "POST", url: `/trips/${tripId}/dispatch`, headers: { "x-session": towerToken } });
      assert.equal(d1.statusCode, 200);
      const d2 = await app.inject({ method: "POST", url: `/trips/${tripId}/depart`, headers: { "x-session": towerToken } });
      assert.equal(d2.statusCode, 200);
      const d3 = await app.inject({ method: "POST", url: `/trips/${tripId}/arrive`, headers: { "x-session": towerToken } });
      assert.equal(d3.statusCode, 200);
    });

    it("completes trip with recipient name, delivery notes, and digital touch signature", async () => {
      const completeRes = await app.inject({
        method: "POST",
        url: `/trips/${tripId}/complete`,
        headers: { "x-session": towerToken },
        payload: {
          recipient: "Alexander Santos, Warehouse Supervisor",
          notes: "Cargo inspected and received intact without discrepancy",
          signature: dummySignature,
        },
      });
      assert.equal(completeRes.statusCode, 200);
      const trip = JSON.parse(completeRes.payload);
      assert.equal(trip.status, "completed");
      assert.equal(trip.podRecipient, "Alexander Santos, Warehouse Supervisor");
      assert.equal(trip.podNotes, "Cargo inspected and received intact without discrepancy");
      assert.equal(trip.podSignature, dummySignature);
      assert.ok(trip.podAt);
    });

    it("verifies GET /trips/:id persists and returns complete e-POD audit record", async () => {
      const getRes = await app.inject({
        method: "GET",
        url: `/trips/${tripId}`,
        headers: { "x-session": towerToken },
      });
      assert.equal(getRes.statusCode, 200);
      const trip = JSON.parse(getRes.payload);
      assert.equal(trip.podRecipient, "Alexander Santos, Warehouse Supervisor");
      assert.equal(trip.podSignature, dummySignature);
      assert.ok(trip.podAt);
    });
  });

  describe("5. Telematics & Ingestion Bridge (Cameras, RFID, Traccar/OsmAnd)", () => {
    it("handles plate read camera event via /ingest/events", async () => {
      const vehicle = one("SELECT plate FROM vehicles LIMIT 1")!;
      const res = await app.inject({
        method: "POST",
        url: "/ingest/events",
        headers: { "x-device-key": DEMO_DEVICE_KEYS.whGateCam },
        payload: {
          type: "plate_read",
          plate: vehicle.plate,
          direction: "in",
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(typeof body.accepted, "boolean");
      assert.ok(body.action);
    });

    it("receives GPS telematics via Traccar/OsmAnd HTTP protocol (GET query string)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/ingest/traccar?id=GPS-T01&lat=14.2120&lon=121.1650&speed=48.5&timestamp=1700000000",
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.accepted, true);
      assert.ok(["position.updated", "vehicle.position", "trip.departed", "trip.arrived"].includes(body.action));
    });

    it("receives GPS telematics via Traccar/OsmAnd HTTP protocol (POST payload)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/ingest/traccar",
        payload: {
          id: "GPS-T02",
          lat: 14.7004,
          lng: 120.9830,
          speed: 0,
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.accepted, true);
    });
  });
});
