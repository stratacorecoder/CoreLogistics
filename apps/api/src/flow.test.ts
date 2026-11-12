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

    it("rejects unauthenticated access to /devices with 401 Unauthorized", async () => {
      const res = await app.inject({ method: "GET", url: "/devices" });
      assert.equal(res.statusCode, 401);
    });

    it("rejects unauthenticated access to operational GET endpoints (/trips) with 401 Unauthorized", async () => {
      const res = await app.inject({ method: "GET", url: "/trips" });
      assert.equal(res.statusCode, 401);
    });

    it("rejects non-tower role attempting GET /devices with 403 Forbidden", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/devices",
        headers: { "x-session": warehouseToken },
      });
      assert.equal(res.statusCode, 403);
    });

    it("allows tower role to access GET /devices with 200 OK", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/devices",
        headers: { "x-session": towerToken },
      });
      assert.equal(res.statusCode, 200);
      const list = JSON.parse(res.payload);
      assert.ok(Array.isArray(list));
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

    it("rejects scheduling an overlapping appointment on the same dock door with 409 Conflict", async () => {
      const windowStart = new Date(Date.now() + 4000_000).toISOString();
      const windowEnd = new Date(Date.now() + 8000_000).toISOString();

      const res = await app.inject({
        method: "POST",
        url: "/gate/appointments",
        headers: { "x-session": towerToken },
        payload: {
          siteId,
          plate: "DIFF-PLATE",
          carrier: "Other Carrier",
          purpose: "load",
          locationId: dockDoorId,
          windowStart,
          windowEnd,
        },
      });

      assert.equal(res.statusCode, 409);
      const body = JSON.parse(res.payload);
      assert.match(body.error, /already booked by appointment/i);
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

    it("rejects receiving an item with an invalid expiry date format with 400 Bad Request", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/warehouse/receipts/${receiptId}/receive`,
        headers: { "x-session": warehouseToken },
        payload: {
          skuId,
          qty: 5,
          kind: "pallet",
          lotNumber: "LOT-BAD-DATE",
          expiryDate: "02-01-2027", // Not YYYY-MM-DD
        },
      });
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.payload);
      assert.match(body.error, /YYYY-MM-DD/i);

      const badCalendar = await app.inject({
        method: "POST",
        url: `/warehouse/receipts/${receiptId}/receive`,
        headers: { "x-session": warehouseToken },
        payload: {
          skuId,
          qty: 5,
          kind: "pallet",
          lotNumber: "LOT-FEB-31",
          expiryDate: "2027-02-31",
        },
      });
      assert.equal(badCalendar.statusCode, 400);
    });

    it("accepts an empty string for expiryDate and normalizes it to null", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/warehouse/receipts/${receiptId}/receive`,
        headers: { "x-session": warehouseToken },
        payload: {
          skuId,
          qty: 5,
          kind: "pallet",
          lotNumber: "LOT-NO-EXPIRY",
          expiryDate: "",
        },
      });
      assert.equal(res.statusCode, 200);
      const hu = JSON.parse(res.payload);
      assert.equal(hu.expiryDate, null);
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

    it("rejects completing trip with an invalid non-image signature data URL with 400 Bad Request", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/trips/${tripId}/complete`,
        headers: { "x-session": towerToken },
        payload: {
          recipient: "Tester",
          signature: "https://evil.com/fake-signature.png",
        },
      });
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.payload);
      assert.match(body.error, /Signature must be a valid base64 image data URL/i);
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

    it("rejects unauthenticated Traccar GPS telemetry using only public device code", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/ingest/traccar?id=GPS-T01&lat=14.2120&lon=121.1650&speed=48.5&timestamp=1700000000",
      });
      assert.equal(res.statusCode, 401);
    });

    it("receives GPS telematics via Traccar/OsmAnd HTTP protocol (GET query string)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/ingest/traccar?id=GPS-T01&key=${encodeURIComponent(DEMO_DEVICE_KEYS.gpsT01)}&lat=14.2120&lon=121.1650&speed=48.5&timestamp=1700000000`,
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
        headers: { "x-device-key": DEMO_DEVICE_KEYS.gpsT02 },
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

    it("rejects Traccar request with a malformed timestamp with 400 Bad Request", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/ingest/traccar?id=GPS-T01&key=${encodeURIComponent(DEMO_DEVICE_KEYS.gpsT01)}&lat=14.2120&lon=121.1650&timestamp=not-a-valid-timestamp`,
      });
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.payload);
      assert.match(body.error, /Invalid timestamp/i);
    });

    it("rejects non-GPS device key on /ingest/traccar with 401 Unauthorized", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/ingest/traccar?key=${encodeURIComponent(DEMO_DEVICE_KEYS.whGateCam)}&lat=14.2120&lon=121.1650`,
      });
      assert.equal(res.statusCode, 401);
    });
  });

  describe("6. Agentic Exception Copilot & Disruption Engine", () => {
    let copilotTripId: string;
    let yardVisitId: string;
    let appointmentDockId: string;
    let recommendationId: string;

    before(async () => {
      const wh = one("SELECT id FROM sites WHERE code = 'WH-C'")!;
      const depot = one("SELECT id FROM sites WHERE code = 'DEP-N'")!;

      // Find an active dock door at WH-C
      const dock = one("SELECT id, code FROM locations WHERE site_id = ? AND kind = 'dock_door' AND active = 1 LIMIT 1", [wh.id])!;
      appointmentDockId = dock.id;

      // Create test vehicles
      run("DELETE FROM vehicles WHERE id IN ('veh_cop_trip', 'veh_cop_yard')");
      run(
        `INSERT INTO vehicles (id, code, plate, kind, model, status, home_site_id)
         VALUES ('veh_cop_trip', 'V-COP-01', 'COP-TRIP-1', 'truck', 'Inbound Freight', 'available', ?)`,
        [depot.id],
      );
      run(
        `INSERT INTO vehicles (id, code, plate, kind, model, status, home_site_id)
         VALUES ('veh_cop_yard', 'V-COP-02', 'COP-YARD-2', 'truck', 'Yard Shuttle', 'available', ?)`,
        [wh.id],
      );

      // Create an inbound trip from Depot to WH-C
      const tripRes = await app.inject({
        method: "POST",
        url: "/trips",
        headers: { "x-session": towerToken },
        payload: {
          kind: "inbound",
          originSiteId: depot.id,
          destinationSiteId: wh.id,
          vehicleId: "veh_cop_trip",
          plannedDeparture: new Date(Date.now() - 3600_000).toISOString(),
          plannedArrival: new Date(Date.now() + 1800_000).toISOString(),
          notes: "Scheduled inbound high-priority freight",
        },
      });
      assert.equal(tripRes.statusCode, 200);
      copilotTripId = JSON.parse(tripRes.payload).id;

      // Dispatch trip
      await app.inject({ method: "POST", url: `/trips/${copilotTripId}/dispatch`, headers: { "x-session": towerToken } });

      // Schedule a dock appointment at WH-C for this trip
      const now = Date.now();
      const apptRes = await app.inject({
        method: "POST",
        url: "/gate/appointments",
        headers: { "x-session": towerToken },
        payload: {
          siteId: wh.id,
          tripId: copilotTripId,
          plate: "COP-TRIP-1",
          carrier: "Priority Express",
          purpose: "unload",
          locationId: appointmentDockId,
          windowStart: new Date(now).toISOString(),
          windowEnd: new Date(now + 3600_000).toISOString(),
          notes: "Reserved dock window",
        },
      });
      assert.equal(apptRes.statusCode, 200);

      // Check in the other vehicle into the yard at WH-C so it is in_yard
      const checkInRes = await app.inject({
        method: "POST",
        url: "/gate/check-in",
        headers: { "x-session": towerToken },
        payload: {
          siteId: wh.id,
          vehicleId: "veh_cop_yard",
          sealNo: "SEAL-YARD-01",
          notes: "Waiting in yard for open dock",
        },
      });
      assert.equal(checkInRes.statusCode, 200);
      yardVisitId = JSON.parse(checkInRes.payload).id;
    });

    it("evaluates driver disruption event and generates Copilot recommendation", async () => {
      // Driver reports breakdown issue on copilotTripId
      const issueRes = await app.inject({
        method: "POST",
        url: `/trips/${copilotTripId}/issues`,
        headers: { "x-session": towerToken },
        payload: {
          kind: "breakdown",
          message: "Engine cooling leak; truck immobilized at mile marker 44",
        },
      });
      assert.equal(issueRes.statusCode, 200);

      // Fetch copilot recommendations
      const recsRes = await app.inject({
        method: "GET",
        url: "/copilot/recommendations",
        headers: { "x-session": towerToken },
      });
      assert.equal(recsRes.statusCode, 200);
      const recs = JSON.parse(recsRes.payload);
      assert.ok(recs.length > 0);

      const rec = recs.find((r: { tripId: string }) => r.tripId === copilotTripId);
      assert.ok(rec, "Expected recommendation for broken-down trip");
      assert.equal(rec.status, "pending");
      assert.equal(rec.severity, "critical");
      assert.ok(rec.prescribedActions.length >= 1);

      const swapAction = rec.prescribedActions.find((a: { type: string }) => a.type === "swap_dock");
      assert.ok(swapAction, "Expected swap_dock action");
      assert.ok(swapAction.payload.visitId);

      recommendationId = rec.id;
    });

    it("executes 1-click Copilot recommendation and applies dock assignment atomically", async () => {
      const applyRes = await app.inject({
        method: "POST",
        url: `/copilot/recommendations/${recommendationId}/apply`,
        headers: { "x-session": towerToken },
      });
      assert.equal(applyRes.statusCode, 200);
      const appliedRec = JSON.parse(applyRes.payload);
      assert.equal(appliedRec.status, "applied");
      assert.ok(appliedRec.appliedAt);

      // Verify that the assigned yard truck is now at the dock door
      const targetVisitId = appliedRec.prescribedActions[0].payload.visitId;
      const visitRes = await app.inject({
        method: "GET",
        url: `/gate/visits/${targetVisitId}`,
        headers: { "x-session": towerToken },
      });
      assert.equal(visitRes.statusCode, 200);
      const visit = JSON.parse(visitRes.payload);
      assert.equal(visit.status, "at_dock");
      assert.equal(visit.dock?.locationId, appointmentDockId);
    });

    it("rejects non-tower role attempting mutating copilot operations with 403 Forbidden", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/copilot/config",
        headers: { "x-session": warehouseToken },
        payload: { autoPilot: true },
      });
      assert.equal(res.statusCode, 403);
    });

    it("verifies Auto-Pilot toggle config and auto-resolves subsequent disruptions", async () => {
      // Check config endpoint
      const cfgGet = await app.inject({
        method: "GET",
        url: "/copilot/config",
        headers: { "x-session": towerToken },
      });
      assert.equal(cfgGet.statusCode, 200);
      assert.equal(JSON.parse(cfgGet.payload).autoPilot, false);

      // Turn on Auto-Pilot
      const cfgSet = await app.inject({
        method: "POST",
        url: "/copilot/config",
        headers: { "x-session": towerToken },
        payload: { autoPilot: true },
      });
      assert.equal(cfgSet.statusCode, 200);
      assert.equal(JSON.parse(cfgSet.payload).autoPilot, true);

      // Report another issue on the trip with 'delay'
      const issueRes2 = await app.inject({
        method: "POST",
        url: `/trips/${copilotTripId}/issues`,
        headers: { "x-session": towerToken },
        payload: {
          kind: "delay",
          message: "Heavy detour congestion adds 45 minutes",
        },
      });
      assert.equal(issueRes2.statusCode, 200);

      // Verify Auto-Pilot executed the recommendation automatically
      const recsRes = await app.inject({
        method: "GET",
        url: "/copilot/recommendations",
        headers: { "x-session": towerToken },
      });
      assert.equal(recsRes.statusCode, 200);
      const recs = JSON.parse(recsRes.payload);
      const autoRec = recs.find((r: { tripId: string; status: string }) => r.tripId === copilotTripId && r.status === "auto_applied");
      assert.ok(autoRec, "Expected auto_applied recommendation under Auto-Pilot mode");
    });
  });

  describe("9. Task 1 Security Hardening: Cookie Auth, CORS, CSRF, RBAC, Throttle", () => {
    let gateToken = "";
    let gateCookie = "";
    let joseToken = "";
    let mariaToken = "";
    let joseTripId = "";
    let mariaTripId = "";

    function extractSessionCookie(header: string | string[] | undefined): string {
      const list = Array.isArray(header) ? header : header ? [header] : [];
      const line = list.find((item) => item.startsWith("cl_session="));
      assert.ok(line, `Expected cl_session Set-Cookie header, got: ${JSON.stringify(list)}`);
      return line.split(";")[0]!.slice("cl_session=".length);
    }

    before(async () => {
      const gateLogin = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: "rico", password: "yard" },
      });
      assert.equal(gateLogin.statusCode, 200);
      gateToken = JSON.parse(gateLogin.payload).token;
      gateCookie = extractSessionCookie(gateLogin.headers["set-cookie"]);

      const joseLogin = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: "jose", password: "drive" },
      });
      assert.equal(joseLogin.statusCode, 200);
      const joseBody = JSON.parse(joseLogin.payload);
      joseToken = joseBody.token;

      const mariaLogin = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: "maria", password: "drive" },
      });
      assert.equal(mariaLogin.statusCode, 200);
      const mariaBody = JSON.parse(mariaLogin.payload);
      mariaToken = mariaBody.token;

      const tripsRes = await app.inject({
        method: "GET",
        url: "/trips",
        headers: { "x-session": towerToken },
      });
      assert.equal(tripsRes.statusCode, 200);
      const trips = JSON.parse(tripsRes.payload) as Array<{ id: string; driverId: string | null; status: string }>;
      const joseTrip =
        trips.find((t) => t.driverId === joseBody.user.driverId && (t.status === "dispatched" || t.status === "in_transit")) ??
        trips.find((t) => t.driverId === joseBody.user.driverId && t.status !== "cancelled");
      const mariaTrip = trips.find((t) => t.driverId === mariaBody.user.driverId);
      assert.ok(joseTrip, "Expected seeded trip for jose");
      assert.ok(mariaTrip, "Expected seeded trip for maria");
      joseTripId = joseTrip.id;
      mariaTripId = mariaTrip.id;
    });

    it("issues HttpOnly SameSite=Lax cookie on login, authenticates /auth/me, and clears it on logout", async () => {
      const loginRes = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: "rico", password: "yard" },
      });
      assert.equal(loginRes.statusCode, 200);
      const rawSetCookie = loginRes.headers["set-cookie"];
      const setCookies = Array.isArray(rawSetCookie) ? rawSetCookie : rawSetCookie ? [rawSetCookie] : [];
      const clLine = setCookies.find((c) => c.startsWith("cl_session="));
      assert.ok(clLine, "Missing cl_session cookie");
      assert.match(clLine, /\bHttpOnly\b/i);
      assert.match(clLine, /\bSameSite=Lax\b/i);
      assert.match(clLine, /\bPath=\//i);
      const tempCookie = clLine.split(";")[0]!.slice("cl_session=".length);

      const meRes = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { cookie: `cl_session=${tempCookie}` },
      });
      assert.equal(meRes.statusCode, 200);
      assert.equal(JSON.parse(meRes.payload).role, "gate");

      const logoutRes = await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: {
          cookie: `cl_session=${tempCookie}`,
          origin: "http://localhost:5181",
        },
      });
      assert.equal(logoutRes.statusCode, 200);
      const clearHeader = logoutRes.headers["set-cookie"];
      const clearLine = (Array.isArray(clearHeader) ? clearHeader : clearHeader ? [clearHeader] : []).find((c) =>
        c.startsWith("cl_session="),
      );
      assert.ok(clearLine && /\bMax-Age=0\b/i.test(clearLine), "Expected Max-Age=0 on logout");

      const afterLogout = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { cookie: `cl_session=${tempCookie}` },
      });
      assert.equal(afterLogout.statusCode, 401);
    });

    it("enforces explicit CORS allowlist and requires auth on /sites, /vehicles, /drivers, /skus, and /stream", async () => {
      const preflightOk = await app.inject({
        method: "OPTIONS",
        url: "/sites",
        headers: {
          origin: "http://localhost:5180",
          "access-control-request-method": "GET",
        },
      });
      assert.ok(preflightOk.statusCode < 400);
      assert.equal(preflightOk.headers["access-control-allow-origin"], "http://localhost:5180");
      assert.equal(preflightOk.headers["access-control-allow-credentials"], "true");

      const preflightEvil = await app.inject({
        method: "OPTIONS",
        url: "/sites",
        headers: {
          origin: "https://evil.example",
          "access-control-request-method": "GET",
        },
      });
      assert.notEqual(preflightEvil.headers["access-control-allow-origin"], "https://evil.example");
      assert.notEqual(preflightEvil.headers["access-control-allow-origin"], "*");

      for (const path of ["/sites", "/vehicles", "/drivers", "/skus", "/stream"]) {
        const res = await app.inject({ method: "GET", url: path });
        assert.equal(res.statusCode, 401, `Expected 401 for unauthenticated GET ${path}`);
      }
    });

    it("blocks CSRF on cookie-authenticated mutations without an allowed Origin/Referer", async () => {
      const loginTower = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: "ava", password: "planner" },
      });
      const towerCookie = extractSessionCookie(loginTower.headers["set-cookie"]);

      const noOrigin = await app.inject({
        method: "POST",
        url: "/copilot/config",
        headers: { cookie: `cl_session=${towerCookie}` },
        payload: { autoPilot: false },
      });
      assert.equal(noOrigin.statusCode, 403);

      const evilOrigin = await app.inject({
        method: "POST",
        url: "/copilot/config",
        headers: {
          cookie: `cl_session=${towerCookie}`,
          origin: "https://evil.example",
        },
        payload: { autoPilot: false },
      });
      assert.equal(evilOrigin.statusCode, 403);

      const evilReferer = await app.inject({
        method: "POST",
        url: "/copilot/config",
        headers: {
          cookie: `cl_session=${towerCookie}`,
          referer: "https://evil.example/pwn",
        },
        payload: { autoPilot: false },
      });
      assert.equal(evilReferer.statusCode, 403);

      const goodOrigin = await app.inject({
        method: "POST",
        url: "/copilot/config",
        headers: {
          cookie: `cl_session=${towerCookie}`,
          origin: "http://localhost:5180",
        },
        payload: { autoPilot: false },
      });
      assert.equal(goodOrigin.statusCode, 200);

      const goodReferer = await app.inject({
        method: "POST",
        url: "/copilot/config",
        headers: {
          cookie: `cl_session=${towerCookie}`,
          referer: "http://localhost:5180/dispatch",
        },
        payload: { autoPilot: false },
      });
      assert.equal(goodReferer.statusCode, 200);

      const bearerNoOrigin = await app.inject({
        method: "POST",
        url: "/copilot/config",
        headers: { authorization: `Bearer ${towerToken}` },
        payload: { autoPilot: false },
      });
      assert.equal(bearerNoOrigin.statusCode, 200);

      // Gate cookie can access gate route with matching Origin
      const gateAllowed = await app.inject({
        method: "POST",
        url: "/gate/appointments/apt_missing_sec/cancel",
        headers: {
          cookie: `cl_session=${gateCookie}`,
          origin: "http://localhost:5181",
        },
      });
      assert.equal(gateAllowed.statusCode, 404);
    });

    it("enforces domain RBAC and driver trip ownership across gate, warehouse, driver, and tower", async () => {
      // Gate cannot touch warehouse, outbound, fleet, or trips
      for (const req of [
        { method: "POST" as const, url: "/warehouse/receipts" },
        { method: "POST" as const, url: "/outbound/orders" },
        { method: "POST" as const, url: "/trips" },
        { method: "POST" as const, url: "/drivers" },
        { method: "POST" as const, url: `/trips/${joseTripId}/depart` },
      ]) {
        const res = await app.inject({ ...req, headers: { "x-session": gateToken }, payload: {} });
        assert.equal(res.statusCode, 403, `Expected 403 for gate on ${req.method} ${req.url}`);
      }
      const gateOwn = await app.inject({
        method: "POST",
        url: "/gate/appointments/apt_missing_sec/cancel",
        headers: { "x-session": gateToken },
      });
      assert.equal(gateOwn.statusCode, 404);

      // Warehouse cannot touch gate, fleet, trips, or dispatch
      for (const req of [
        { method: "POST" as const, url: "/gate/appointments" },
        { method: "POST" as const, url: "/trips" },
        { method: "POST" as const, url: "/vehicles" },
        { method: "POST" as const, url: `/trips/${joseTripId}/dispatch` },
        { method: "POST" as const, url: `/trips/${joseTripId}/depart` },
      ]) {
        const res = await app.inject({ ...req, headers: { "x-session": warehouseToken }, payload: {} });
        assert.equal(res.statusCode, 403, `Expected 403 for warehouse on ${req.method} ${req.url}`);
      }
      const whOwn = await app.inject({
        method: "POST",
        url: "/outbound/picks/pck_missing_sec/confirm",
        headers: { "x-session": warehouseToken },
      });
      assert.equal(whOwn.statusCode, 404);

      // Driver cannot plan/dispatch/cancel/edit trips or mutate gate/warehouse
      for (const req of [
        { method: "POST" as const, url: "/trips" },
        { method: "PATCH" as const, url: `/trips/${joseTripId}` },
        { method: "POST" as const, url: `/trips/${joseTripId}/dispatch` },
        { method: "POST" as const, url: `/trips/${joseTripId}/cancel` },
        { method: "POST" as const, url: "/gate/appointments" },
        { method: "POST" as const, url: "/warehouse/receipts" },
        { method: "POST" as const, url: "/outbound/orders" },
      ]) {
        const res = await app.inject({ ...req, headers: { "x-session": joseToken }, payload: {} });
        assert.equal(res.statusCode, 403, `Expected 403 for driver on ${req.method} ${req.url}`);
      }

      // Driver cannot mutate another driver's trip
      for (const suffix of ["depart", "issues", "complete"]) {
        const res = await app.inject({
          method: "POST",
          url: `/trips/${mariaTripId}/${suffix}`,
          headers: { "x-session": joseToken },
          payload: suffix === "issues" ? { kind: "delay", message: "unauthorized" } : undefined,
        });
        assert.equal(res.statusCode, 403, `Expected 403 for jose on maria's trip /${suffix}`);
      }

      // Driver can operate their own assigned trip and sees 404 for nonexistent trip
      const joseOwn = await app.inject({
        method: "POST",
        url: `/trips/${joseTripId}/depart`,
        headers: { "x-session": joseToken },
      });
      assert.equal(joseOwn.statusCode, 200);

      const missingTrip = await app.inject({
        method: "POST",
        url: "/trips/trp_missing_sec/depart",
        headers: { "x-session": joseToken },
      });
      assert.equal(missingTrip.statusCode, 404);
    });

    it("ignores CORELOGISTICS_AUTH_DISABLED in production and guards malformed x-actor decoding", async () => {
      const prevNodeEnv = process.env.NODE_ENV;
      const prevDisabled = process.env.CORELOGISTICS_AUTH_DISABLED;
      try {
        process.env.NODE_ENV = "production";
        process.env.CORELOGISTICS_AUTH_DISABLED = "1";
        const prodRes = await app.inject({ method: "GET", url: "/trips" });
        assert.equal(prodRes.statusCode, 401);

        process.env.NODE_ENV = "test";
        const badActorRes = await app.inject({
          method: "POST",
          url: "/copilot/config",
          headers: { "x-actor": "%E0%A4%A" },
          payload: { autoPilot: false },
        });
        assert.equal(badActorRes.statusCode, 200);
      } finally {
        if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prevNodeEnv;
        if (prevDisabled === undefined) delete process.env.CORELOGISTICS_AUTH_DISABLED;
        else process.env.CORELOGISTICS_AUTH_DISABLED = prevDisabled;
      }
    });

    it("rate-limits repeated failed login attempts with 429 Too Many Requests", async () => {
      let lastStatus = 0;
      for (let i = 0; i < 11; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/auth/login",
          payload: { username: "throttle_probe", password: "wrong" },
        });
        lastStatus = res.statusCode;
        if (lastStatus === 429) break;
        assert.equal(lastStatus, 401);
      }
      assert.equal(lastStatus, 429);
    });

    it("honors forwarded proto, same-origin CSRF, and client IP only when CORELOGISTICS_TRUST_PROXY=1", async () => {
      // Untrusted app ignores spoofed x-forwarded-* headers
      const spoofedLogin = await app.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": "evil.example" },
        payload: { username: "ava", password: "planner" },
      });
      assert.equal(spoofedLogin.statusCode, 200);
      const spoofCookieLine = (Array.isArray(spoofedLogin.headers["set-cookie"])
        ? spoofedLogin.headers["set-cookie"]
        : [spoofedLogin.headers["set-cookie"] ?? ""])
        .find((c) => c.startsWith("cl_session="));
      assert.ok(spoofCookieLine);
      assert.doesNotMatch(spoofCookieLine, /;\s*Secure\b/i, "Must not set Secure from untrusted x-forwarded-proto");
      const untrustedCookie = extractSessionCookie(spoofedLogin.headers["set-cookie"]);

      const spoofedCsrf = await app.inject({
        method: "POST",
        url: "/copilot/config",
        headers: {
          cookie: `cl_session=${untrustedCookie}`,
          "x-forwarded-proto": "https",
          "x-forwarded-host": "evil.example",
          origin: "https://evil.example",
        },
        payload: { autoPilot: false },
      });
      assert.equal(spoofedCsrf.statusCode, 403);

      const prevTrust = process.env.CORELOGISTICS_TRUST_PROXY;
      process.env.CORELOGISTICS_TRUST_PROXY = "1";
      const proxyApp = await buildApp({ logger: false });
      try {
        const httpsLogin = await proxyApp.inject({
          method: "POST",
          url: "/auth/login",
          headers: {
            "x-forwarded-proto": "https",
            "x-forwarded-host": "192.168.1.50:8443",
            "x-forwarded-for": "10.20.30.1",
          },
          payload: { username: "ava", password: "planner" },
        });
        assert.equal(httpsLogin.statusCode, 200);
        const httpsSetCookie = Array.isArray(httpsLogin.headers["set-cookie"])
          ? httpsLogin.headers["set-cookie"]
          : [httpsLogin.headers["set-cookie"] ?? ""];
        const httpsLine = httpsSetCookie.find((c) => c.startsWith("cl_session="));
        assert.ok(httpsLine && /;\s*Secure\b/i.test(httpsLine), `Expected Secure cookie under trusted HTTPS proxy, got: ${httpsLine}`);
        const proxyCookie = extractSessionCookie(httpsLogin.headers["set-cookie"]);

        const sameOriginMutation = await proxyApp.inject({
          method: "POST",
          url: "/copilot/config",
          headers: {
            cookie: `cl_session=${proxyCookie}`,
            host: "api:3100",
            "x-forwarded-proto": "https",
            "x-forwarded-host": "192.168.1.50:8443",
            origin: "https://192.168.1.50:8443",
          },
          payload: { autoPilot: false },
        });
        assert.equal(sameOriginMutation.statusCode, 200);

        const crossOriginEvil = await proxyApp.inject({
          method: "POST",
          url: "/copilot/config",
          headers: {
            cookie: `cl_session=${proxyCookie}`,
            "x-forwarded-proto": "https",
            "x-forwarded-host": "192.168.1.50:8443",
            origin: "https://evil.example",
          },
          payload: { autoPilot: false },
        });
        assert.equal(crossOriginEvil.statusCode, 403);

        // Rate limit uses forwarded client IP independently under trusted proxy
        let statusIp1 = 0;
        for (let i = 0; i < 11; i++) {
          const res = await proxyApp.inject({
            method: "POST",
            url: "/auth/login",
            headers: { "x-forwarded-for": "10.20.30.40" },
            payload: { username: "proxy_throttle_user", password: "wrong" },
          });
          statusIp1 = res.statusCode;
        }
        assert.equal(statusIp1, 429);

        const otherIp = await proxyApp.inject({
          method: "POST",
          url: "/auth/login",
          headers: { "x-forwarded-for": "10.20.30.41" },
          payload: { username: "proxy_throttle_user", password: "wrong" },
        });
        assert.equal(otherIp.statusCode, 401);
      } finally {
        await proxyApp.close();
        if (prevTrust === undefined) delete process.env.CORELOGISTICS_TRUST_PROXY;
        else process.env.CORELOGISTICS_TRUST_PROXY = prevTrust;
      }
    });
  });

  describe("9. Hardening & Validation Regression Tests", () => {
    it("does not reset existing user passwords when ensureDemoUsers runs", async () => {
      const { hashPassword, pruneExpiredSessions } = await import("./modules/auth/service.js");
      const row = one("SELECT id, password_hash FROM users WHERE username = 'nina'")!;
      const customHash = hashPassword("custom-secret-999");
      run("UPDATE users SET password_hash = ? WHERE id = ?", [customHash, row.id]);
      ensureDemoUsers();
      const after = one("SELECT password_hash FROM users WHERE id = ?", [row.id])!;
      assert.equal(after.password_hash, customHash);
      // Restore original hash so remaining tests or callers see consistent user state
      run("UPDATE users SET password_hash = ? WHERE id = ?", [row.password_hash, row.id]);

      // Verify expired session pruning deletes stale rows
      run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", [
        "expired_test_tok",
        row.id,
        new Date(Date.now() - 60_000).toISOString(),
      ]);
      const removed = pruneExpiredSessions();
      assert.ok(removed >= 1);
      assert.equal(one("SELECT 1 FROM sessions WHERE token = 'expired_test_tok'"), undefined);
    });

    it("keeps critical disruptions pending under Auto-Pilot and rejects overlapping dock reschedules", async () => {
      const wh = one("SELECT id FROM sites WHERE code = 'WH-C'")!;
      const depot = one("SELECT id FROM sites WHERE code = 'DEP-N'")!;
      const docks = many("SELECT id, code FROM locations WHERE site_id = ? AND kind = 'dock_door' AND active = 1 ORDER BY code", [wh.id]);
      const dock = docks[1] ?? docks[0]!;

      run(
        `INSERT OR REPLACE INTO vehicles (id, code, plate, kind, model, status, home_site_id)
         VALUES ('veh_crit_1', 'V-CRIT-1', 'CRIT-01', 'truck', 'Freight', 'available', ?)`,
        [depot.id],
      );
      const tRes = await app.inject({
        method: "POST",
        url: "/trips",
        headers: { "x-session": towerToken },
        payload: {
          kind: "inbound",
          originSiteId: depot.id,
          destinationSiteId: wh.id,
          vehicleId: "veh_crit_1",
          plannedDeparture: new Date(Date.now() - 1800_000).toISOString(),
          plannedArrival: new Date(Date.now() + 1800_000).toISOString(),
        },
      });
      assert.equal(tRes.statusCode, 200);
      const critTrip = JSON.parse(tRes.payload);
      await app.inject({ method: "POST", url: `/trips/${critTrip.id}/dispatch`, headers: { "x-session": towerToken } });

      const baseMs = Date.now();
      const appt1 = await app.inject({
        method: "POST",
        url: "/gate/appointments",
        headers: { "x-session": towerToken },
        payload: {
          siteId: wh.id,
          tripId: critTrip.id,
          plate: "CRIT-01",
          purpose: "unload",
          locationId: dock.id,
          windowStart: new Date(baseMs).toISOString(),
          windowEnd: new Date(baseMs + 3600_000).toISOString(),
        },
      });
      assert.equal(appt1.statusCode, 200);

      // Book a non-overlapping future appointment in [+65m, +120m] that collides when Copilot pushes appt1 back (+45m/+60m)
      const appt2 = await app.inject({
        method: "POST",
        url: "/gate/appointments",
        headers: { "x-session": towerToken },
        payload: {
          siteId: wh.id,
          plate: "BLOCK-99",
          purpose: "unload",
          locationId: dock.id,
          windowStart: new Date(baseMs + 65 * 60_000).toISOString(),
          windowEnd: new Date(baseMs + 120 * 60_000).toISOString(),
        },
      });
      assert.equal(appt2.statusCode, 200);

      // Enable Auto-Pilot and trigger a critical breakdown
      await app.inject({
        method: "POST",
        url: "/copilot/config",
        headers: { "x-session": towerToken },
        payload: { autoPilot: true },
      });

      try {
        const issueRes = await app.inject({
          method: "POST",
          url: `/trips/${critTrip.id}/issues`,
          headers: { "x-session": towerToken },
          payload: { kind: "breakdown", message: "Transmission failure" },
        });
        assert.equal(issueRes.statusCode, 200);

        const recsRes = await app.inject({
          method: "GET",
          url: `/copilot/recommendations?siteId=${wh.id}`,
          headers: { "x-session": towerToken },
        });
        const recs = JSON.parse(recsRes.payload);
        const critRec = recs.find((r: { tripId: string }) => r.tripId === critTrip.id);
        assert.ok(critRec, "Expected critical recommendation");
        assert.equal(critRec.severity, "critical");
        assert.equal(critRec.status, "pending", "Critical disruptions must NOT auto-apply under Auto-Pilot");

        // Manual apply should fail with 409 due to overlapping dock appointment at the rescheduled window
        const applyRes = await app.inject({
          method: "POST",
          url: `/copilot/recommendations/${critRec.id}/apply`,
          headers: { "x-session": towerToken },
        });
        assert.equal(applyRes.statusCode, 409);
      } finally {
        await app.inject({
          method: "POST",
          url: "/copilot/config",
          headers: { "x-session": towerToken },
          payload: { autoPilot: false },
        });
      }
    });

    it("rejects off-duty drivers, unavailable trailers, and double-booked trailers on dispatch", async () => {
      const wh = one("SELECT id FROM sites WHERE code = 'WH-C'")!;
      const depot = one("SELECT id FROM sites WHERE code = 'DEP-N'")!;
      const offDuty = one("SELECT id FROM drivers WHERE status = 'off_duty' LIMIT 1")!;
      const availDriver = one("SELECT id FROM drivers WHERE status = 'available' LIMIT 1")!;
      const availDriver2 = one("SELECT id FROM drivers WHERE status = 'available' AND id != ? LIMIT 1", [availDriver.id])!;

      run(
        `INSERT OR REPLACE INTO vehicles (id, code, plate, kind, model, status, home_site_id)
         VALUES
           ('veh_trk_a', 'V-TRK-A', 'TRK-A01', 'truck', 'Tractor', 'available', ?),
           ('veh_trk_b', 'V-TRK-B', 'TRK-B01', 'truck', 'Tractor', 'available', ?),
           ('veh_trl_ok', 'V-TRL-OK', 'TRL-OK1', 'trailer', 'Dry Van', 'available', ?),
           ('veh_trl_mnt', 'V-TRL-MNT', 'TRL-MN1', 'trailer', 'Dry Van', 'maintenance', ?)`,
        [depot.id, depot.id, depot.id, depot.id],
      );

      const makeTrip = async (vehicleId: string, trailerId: string | null, driverId: string) => {
        const res = await app.inject({
          method: "POST",
          url: "/trips",
          headers: { "x-session": towerToken },
          payload: {
            kind: "outbound",
            originSiteId: wh.id,
            destinationSiteId: depot.id,
            vehicleId,
            trailerId,
            driverId,
            plannedDeparture: new Date(Date.now() + 3600_000).toISOString(),
            plannedArrival: new Date(Date.now() + 7200_000).toISOString(),
          },
        });
        assert.equal(res.statusCode, 200);
        return JSON.parse(res.payload).id as string;
      };

      const offDutyTrip = await makeTrip("veh_trk_a", null, offDuty.id);
      const r1 = await app.inject({
        method: "POST",
        url: `/trips/${offDutyTrip}/dispatch`,
        headers: { "x-session": towerToken },
      });
      assert.equal(r1.statusCode, 409);

      const maintTrailerTrip = await makeTrip("veh_trk_a", "veh_trl_mnt", availDriver.id);
      const r2 = await app.inject({
        method: "POST",
        url: `/trips/${maintTrailerTrip}/dispatch`,
        headers: { "x-session": towerToken },
      });
      assert.equal(r2.statusCode, 409);

      const liveTrailerTrip = await makeTrip("veh_trk_a", "veh_trl_ok", availDriver.id);
      const r3 = await app.inject({
        method: "POST",
        url: `/trips/${liveTrailerTrip}/dispatch`,
        headers: { "x-session": towerToken },
      });
      assert.equal(r3.statusCode, 200);

      const dupTrailerTrip = await makeTrip("veh_trk_b", "veh_trl_ok", availDriver2.id);
      const r4 = await app.inject({
        method: "POST",
        url: `/trips/${dupTrailerTrip}/dispatch`,
        headers: { "x-session": towerToken },
      });
      assert.equal(r4.statusCode, 409);
    });

    it("preserves location IDs when swapping dock doors in Site Designer and blocks renaming occupied locations", async () => {
      const siteRes = await app.inject({
        method: "POST",
        url: "/sites",
        headers: { "x-session": towerToken },
        payload: { code: "LAY-TST", name: "Layout Test Hub", kind: "depot", address: "Test", lat: 14.5, lng: 121.0 },
      });
      assert.equal(siteRes.statusCode, 200);
      const site = JSON.parse(siteRes.payload);

      const initialLayout = {
        rows: 6,
        cols: 6,
        cells: [
          { x: 0, y: 2, kind: "gate", label: "G01" },
          { x: 5, y: 1, kind: "dock_door", label: "D01" },
          { x: 5, y: 2, kind: "dock_door", label: "D02" },
        ],
      };
      const save1 = await app.inject({
        method: "PUT",
        url: `/sites/${site.id}/layout`,
        headers: { "x-session": towerToken },
        payload: initialLayout,
      });
      assert.equal(save1.statusCode, 200);

      const locsBefore = many("SELECT * FROM locations WHERE site_id = ? AND active = 1", [site.id]);
      const d01Before = locsBefore.find((l) => l.code === "D01")!;
      const d02Before = locsBefore.find((l) => l.code === "D02")!;

      // Swap D01 and D02 positions
      const swappedLayout = {
        rows: 6,
        cols: 6,
        cells: [
          { x: 0, y: 2, kind: "gate", label: "G01" },
          { x: 5, y: 1, kind: "dock_door", label: "D02" },
          { x: 5, y: 2, kind: "dock_door", label: "D01" },
        ],
      };
      const save2 = await app.inject({
        method: "PUT",
        url: `/sites/${site.id}/layout`,
        headers: { "x-session": towerToken },
        payload: swappedLayout,
      });
      assert.equal(save2.statusCode, 200);

      const locsAfter = many("SELECT * FROM locations WHERE site_id = ? AND active = 1", [site.id]);
      const d01After = locsAfter.find((l) => l.code === "D01")!;
      const d02After = locsAfter.find((l) => l.code === "D02")!;
      assert.equal(d01After.id, d01Before.id);
      assert.equal(d01After.y, 2);
      assert.equal(d02After.id, d02Before.id);
      assert.equal(d02After.y, 1);

      // Dock a vehicle at D01 and verify renaming D01 -> D99 is rejected
      run(
        `INSERT OR REPLACE INTO vehicles (id, code, plate, kind, model, status, home_site_id)
         VALUES ('veh_lay_1', 'V-LAY-1', 'LAY-999', 'truck', 'Shuttle', 'available', ?)`,
        [site.id],
      );
      const gateIn = await app.inject({
        method: "POST",
        url: "/gate/check-in",
        headers: { "x-session": towerToken },
        payload: { siteId: site.id, plate: "LAY-999" },
      });
      assert.equal(gateIn.statusCode, 200);
      const visit = JSON.parse(gateIn.payload);
      const dockAssign = await app.inject({
        method: "POST",
        url: `/gate/visits/${visit.id}/dock`,
        headers: { "x-session": towerToken },
        payload: { locationId: d01After.id },
      });
      assert.equal(dockAssign.statusCode, 200);

      const renameOccupied = await app.inject({
        method: "PUT",
        url: `/sites/${site.id}/layout`,
        headers: { "x-session": towerToken },
        payload: {
          rows: 6,
          cols: 6,
          cells: [
            { x: 0, y: 2, kind: "gate", label: "G01" },
            { x: 5, y: 1, kind: "dock_door", label: "D02" },
            { x: 5, y: 2, kind: "dock_door", label: "D99" },
          ],
        },
      });
      assert.equal(renameOccupied.statusCode, 409);
    });
  });
});
