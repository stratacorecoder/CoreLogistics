import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { one, run } from "./db.js";
import { migrate } from "./migrate.js";
import { evaluateDisruption } from "./modules/copilot/service.js";
import { ensureDemoUsers, seedIfEmpty } from "./seed.js";

describe("Copilot scheduling safety", () => {
  let app: FastifyInstance;
  let towerToken: string;
  let whId: string;
  let depotId: string;
  let n = 0;

  const tower = () => ({ "x-session": towerToken });
  const iso = (ms: number) => new Date(ms).toISOString();

  before(async () => {
    migrate();
    seedIfEmpty();
    ensureDemoUsers();
    app = await buildApp({ logger: false });
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "ava", password: "planner" },
    });
    assert.equal(login.statusCode, 200);
    towerToken = JSON.parse(login.payload).token;
    whId = one<{ id: string }>("SELECT id FROM sites WHERE code = 'WH-C'")!.id;
    depotId = one<{ id: string }>("SELECT id FROM sites WHERE code = 'DEP-N'")!.id;
    run("UPDATE copilot_config SET value = '0' WHERE key = 'auto_pilot'");
  });

  afterEach(() => {
    run("UPDATE copilot_config SET value = '0' WHERE key = 'auto_pilot'");
    run("DROP TRIGGER IF EXISTS copilot_fail_reschedule");
  });

  function label() {
    n += 1;
    return String(n).padStart(2, "0");
  }

  function addVehicle(siteId: string) {
    const id = `veh_sched_${label()}`;
    const plate = `SCH${id.slice(-4).toUpperCase()}`;
    run(
      `INSERT INTO vehicles (id, code, plate, kind, model, status, home_site_id)
       VALUES (?, ?, ?, 'truck', 'Schedule test', 'available', ?)`,
      [id, `V-${id}`, plate, siteId],
    );
    return { id, plate };
  }

  function addDriver(siteId: string) {
    const id = `drv_sched_${label()}`;
    run(
      `INSERT INTO drivers (id, code, name, license_class, license_expiry, status, home_site_id)
       VALUES (?, ?, 'Schedule Driver', 'C', '2030-01-01', 'available', ?)`,
      [id, `D-${id}`, siteId],
    );
    return id;
  }

  async function freeDock(): Promise<string> {
    const now = new Date().toISOString();
    const dock = one<{ id: string }>(
      `SELECT l.id FROM locations l
       WHERE l.site_id = ? AND l.kind = 'dock_door' AND l.active = 1
         AND NOT EXISTS (SELECT 1 FROM dock_assignments d WHERE d.location_id = l.id AND d.released_at IS NULL)
         AND NOT EXISTS (
           SELECT 1 FROM dock_appointments a
           WHERE a.location_id = l.id AND a.status IN ('scheduled', 'checked_in') AND a.window_end > ?
         )
       ORDER BY l.code LIMIT 1`,
      [whId, now],
    );
    assert.ok(dock, "expected a free dock door");
    return dock.id;
  }

  async function dispatchTrip(plannedDeparture: string, plannedArrival: string) {
    const vehicle = addVehicle(depotId);
    const driverId = addDriver(depotId);
    const created = await app.inject({
      method: "POST",
      url: "/trips",
      headers: tower(),
      payload: {
        kind: "inbound",
        originSiteId: depotId,
        destinationSiteId: whId,
        vehicleId: vehicle.id,
        driverId,
        plannedDeparture,
        plannedArrival,
        notes: "",
      },
    });
    assert.equal(created.statusCode, 200, created.payload);
    const trip = JSON.parse(created.payload);
    const dispatched = await app.inject({
      method: "POST",
      url: `/trips/${trip.id}/dispatch`,
      headers: tower(),
    });
    assert.equal(dispatched.statusCode, 200, dispatched.payload);
    return { ...JSON.parse(dispatched.payload), plate: vehicle.plate, vehicleId: vehicle.id };
  }

  async function book(input: {
    tripId?: string | null;
    plate: string;
    locationId: string;
    windowStart: string;
    windowEnd: string;
  }) {
    const res = await app.inject({
      method: "POST",
      url: "/gate/appointments",
      headers: tower(),
      payload: {
        siteId: whId,
        tripId: input.tripId ?? null,
        plate: input.plate,
        carrier: "Schedule Test",
        purpose: "unload",
        locationId: input.locationId,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        notes: "",
      },
    });
    assert.equal(res.statusCode, 200, res.payload);
    return JSON.parse(res.payload);
  }

  async function occupy(locationId: string) {
    const vehicle = addVehicle(whId);
    const checked = await app.inject({
      method: "POST",
      url: "/gate/check-in",
      headers: tower(),
      payload: { siteId: whId, vehicleId: vehicle.id, sealNo: "", notes: "" },
    });
    assert.equal(checked.statusCode, 200, checked.payload);
    const visit = JSON.parse(checked.payload);
    const assigned = await app.inject({
      method: "POST",
      url: `/gate/visits/${visit.id}/dock`,
      headers: tower(),
      payload: { locationId },
    });
    assert.equal(assigned.statusCode, 200, assigned.payload);
    const audit = one<{ payload: string }>(
      "SELECT payload FROM events WHERE type = 'dock.assigned' AND entity_id = ? ORDER BY id DESC LIMIT 1",
      [visit.id],
    );
    const payload = JSON.parse(audit!.payload) as {
      before: { dock: { locationId: string } | null };
      after: { status: string; dock: { locationId: string; code: string } };
    };
    assert.equal(payload.before.dock, null);
    assert.equal(payload.after.status, "at_dock");
    assert.equal(payload.after.dock.locationId, locationId);
    return visit.id as string;
  }

  async function release(visitId: string) {
    await app.inject({ method: "POST", url: `/gate/visits/${visitId}/dock/release`, headers: tower() });
    await app.inject({
      method: "POST",
      url: "/gate/check-out",
      headers: tower(),
      payload: { visitId, sealNo: "", notes: "" },
    });
  }

  async function cancel(id: string) {
    await app.inject({ method: "POST", url: `/gate/appointments/${id}/cancel`, headers: tower() });
  }

  async function issue(tripId: string, kind: string, message: string) {
    const res = await app.inject({
      method: "POST",
      url: `/trips/${tripId}/issues`,
      headers: tower(),
      payload: { kind, message },
    });
    assert.equal(res.statusCode, 200, res.payload);
  }

  async function recommendations(tripId: string) {
    const res = await app.inject({ method: "GET", url: "/copilot/recommendations?limit=200", headers: tower() });
    assert.equal(res.statusCode, 200, res.payload);
    const rows = JSON.parse(res.payload) as Array<Record<string, any>>;
    return rows.filter((rec) => rec.tripId === tripId);
  }

  async function appointmentRow(id: string) {
    return one<{ window_start: string; window_end: string; status: string }>(
      "SELECT window_start, window_end, status FROM dock_appointments WHERE id = ?",
      [id],
    )!;
  }

  it("rejects the same instant when one window uses a timezone offset, and still allows a touching window", async () => {
    const dockId = await freeDock();
    const first = await book({
      plate: `OFF${label()}`,
      locationId: dockId,
      windowStart: "2028-04-02T09:00:00.000Z",
      windowEnd: "2028-04-02T12:00:00.000Z",
    });
    const offset = await app.inject({
      method: "POST",
      url: "/gate/appointments",
      headers: tower(),
      payload: {
        siteId: whId,
        plate: `OFF${label()}`,
        carrier: "Schedule Test",
        purpose: "unload",
        locationId: dockId,
        windowStart: "2028-04-02T17:00:00+08:00",
        windowEnd: "2028-04-02T20:00:00+08:00",
        notes: "",
      },
    });
    assert.equal(offset.statusCode, 409, offset.payload);
    const touching = await book({
      plate: `OFF${label()}`,
      locationId: dockId,
      windowStart: "2028-04-02T12:00:00.000Z",
      windowEnd: "2028-04-02T13:00:00.000Z",
    });
    run(
      `INSERT INTO dock_appointments (id, code, site_id, plate, carrier, purpose, location_id, window_start, window_end, status, notes, created_at)
       VALUES ('app_offset_legacy', 'APP-OFF', ?, 'LEGACY', '', 'unload', ?, '2028-05-01T18:00:00+08:00', '2028-05-01T19:00:00+08:00', 'scheduled', '', ?)`,
      [whId, dockId, iso(Date.now())],
    );
    const legacy = await app.inject({
      method: "POST",
      url: "/gate/appointments",
      headers: tower(),
      payload: {
        siteId: whId,
        plate: `OFF${label()}`,
        carrier: "Schedule Test",
        purpose: "unload",
        locationId: dockId,
        windowStart: "2028-05-01T10:00:00.000Z",
        windowEnd: "2028-05-01T11:00:00.000Z",
        notes: "",
      },
    });
    assert.equal(legacy.statusCode, 409, legacy.payload);
    run("DELETE FROM dock_appointments WHERE id = 'app_offset_legacy'");
    await cancel(first.id);
    await cancel(touching.id);
  });

  it("refuses a reschedule once the live ETA has moved past the proposed window", async () => {
    const now = Date.now();
    const dockId = await freeDock();
    const trip = await dispatchTrip(iso(now - 3 * 60 * 60_000), iso(now - 30 * 60_000));
    const appt = await book({
      tripId: trip.id,
      plate: trip.plate,
      locationId: dockId,
      windowStart: iso(now + 60 * 60_000),
      windowEnd: iso(now + 60 * 60_000 + 40),
    });
    try {
      await issue(trip.id, "delay", "Short window will miss a moving ETA");
      const [rec] = (await recommendations(trip.id)) as Array<{ id: string; revision: number; prescribedActions: Array<{ type: string }> }>;
      assert.ok(rec?.prescribedActions.some((action) => action.type === "reschedule_appointment"));
      await new Promise((resolve) => setTimeout(resolve, 120));
      const applied = await app.inject({
        method: "POST",
        url: `/copilot/recommendations/${rec.id}/apply`,
        headers: tower(),
        payload: { revision: rec.revision },
      });
      assert.equal(applied.statusCode, 409, applied.payload);
      const saved = await appointmentRow(appt.id);
      assert.equal(saved.window_start, appt.windowStart);
      assert.equal(saved.window_end, appt.windowEnd);
    } finally {
      await cancel(appt.id);
    }
  });

  it("keeps duration, refuses an earlier slot, and audits the reschedule", async () => {
    const now = Date.now();
    const dockId = await freeDock();
    const trip = await dispatchTrip(iso(now - 60 * 60_000), iso(now + 30 * 60_000));
    const originalStart = iso(now + 5 * 60_000);
    const originalEnd = iso(now + 35 * 60_000);
    const appt = await book({
      tripId: trip.id,
      plate: trip.plate,
      locationId: dockId,
      windowStart: originalStart,
      windowEnd: originalEnd,
    });
    const visitId = await occupy(dockId);
    try {
      await issue(trip.id, "delay", "Departure slip misses the dock window");
      const [rec] = await recommendations(trip.id);
      assert.ok(rec);
      const body = rec as {
        id: string;
        revision: number;
        status: string;
        prescribedActions: Array<{ type: string; payload: { newWindowStart: string; newWindowEnd: string; appointmentId: string } }>;
        preconditions: { proposedWindow: { durationMs: number; windowStart: string } | null };
      };
      assert.equal(body.status, "pending");
      assert.equal(body.revision, 1);
      const move = body.prescribedActions.find((action) => action.type === "reschedule_appointment");
      assert.ok(move);
      assert.equal(body.prescribedActions.some((action) => action.type === "swap_dock"), false);
      const start = Date.parse(move.payload.newWindowStart);
      const end = Date.parse(move.payload.newWindowEnd);
      assert.equal(end - start, 30 * 60_000);
      assert.ok(start > Date.parse(originalStart));
      assert.ok(start > Date.now());
      assert.equal(body.preconditions.proposedWindow?.durationMs, 30 * 60_000);
      assert.equal(body.preconditions.proposedWindow?.windowStart, move.payload.newWindowStart);

      const applied = await app.inject({
        method: "POST",
        url: `/copilot/recommendations/${body.id}/apply`,
        headers: tower(),
        payload: { revision: body.revision },
      });
      assert.equal(applied.statusCode, 200, applied.payload);
      const saved = await appointmentRow(appt.id);
      assert.equal(saved.window_start, move.payload.newWindowStart);
      assert.equal(saved.window_end, move.payload.newWindowEnd);
      assert.equal(saved.status, "scheduled");

      const audit = one<{ actor: string; payload: string }>(
        "SELECT actor, payload FROM events WHERE type = 'appointment.rescheduled' AND entity_id = ? ORDER BY id DESC LIMIT 1",
        [appt.id],
      );
      assert.ok(audit);
      assert.equal(audit.actor, "Ava Chen");
      const payload = JSON.parse(audit.payload);
      assert.equal(payload.before.windowStart, originalStart);
      assert.equal(payload.after.windowStart, move.payload.newWindowStart);
      assert.equal(payload.actor, "Ava Chen");
    } finally {
      await release(visitId);
      await cancel(appt.id);
    }
  });

  it("does not move a window that still covers the trip ETA", async () => {
    const now = Date.now();
    const dockId = await freeDock();
    const trip = await dispatchTrip(iso(now + 30 * 60_000), iso(now + 90 * 60_000));
    const appt = await book({
      tripId: trip.id,
      plate: trip.plate,
      locationId: dockId,
      windowStart: iso(now + 60 * 60_000),
      windowEnd: iso(now + 3 * 60 * 60_000),
    });
    const visitId = await occupy(dockId);
    try {
      await issue(trip.id, "delay", "Reported delay still fits the booked window");
      const found = await recommendations(trip.id);
      assert.equal(found.length, 1);
      assert.equal(found[0]?.status, "pending");
      assert.equal(found[0]?.lifecycle, "human_review");
      assert.equal(
        (found[0]?.prescribedActions as Array<{ type: string }>).some((action) => action.type === "reschedule_appointment"),
        false,
      );
      assert.match(String(found[0]?.impactSummary), /manual review/i);
      const saved = await appointmentRow(appt.id);
      assert.equal(saved.window_start, appt.windowStart);
    } finally {
      await release(visitId);
      await cancel(appt.id);
    }
  });

  it("asks for manual review when the proposed window overlaps another booking", async () => {
    const now = Date.now();
    const dockId = await freeDock();
    const blocker = await book({
      plate: `BLK${label()}`,
      locationId: dockId,
      windowStart: iso(now + 3 * 60 * 60_000),
      windowEnd: iso(now + 5 * 60 * 60_000),
    });
    const trip = await dispatchTrip(iso(now - 30 * 60_000), iso(now + 3 * 60 * 60_000));
    const appt = await book({
      tripId: trip.id,
      plate: trip.plate,
      locationId: dockId,
      windowStart: iso(now + 10 * 60_000),
      windowEnd: iso(now + 40 * 60_000),
    });
    try {
      await issue(trip.id, "delay", "ETA lands on another booking");
      const [rec] = (await recommendations(trip.id)) as Array<{
        id: string;
        revision: number;
        prescribedActions: Array<{ type: string }>;
        preconditions: { manualReviewReason: string | null };
      }>;
      assert.ok(rec);
      assert.equal(rec.prescribedActions.some((action) => action.type === "reschedule_appointment"), false);
      assert.match(rec.preconditions.manualReviewReason ?? "", /overlaps appointment/i);
      const apply = await app.inject({
        method: "POST",
        url: `/copilot/recommendations/${rec.id}/apply`,
        headers: tower(),
        payload: { revision: rec.revision },
      });
      assert.equal(apply.statusCode, 400);
      const saved = await appointmentRow(appt.id);
      assert.equal(saved.window_start, appt.windowStart);
      assert.equal(saved.window_end, appt.windowEnd);
    } finally {
      await cancel(appt.id);
      await cancel(blocker.id);
    }
  });

  it("does not reschedule a checked-in or cancelled appointment", async () => {
    const now = Date.now();
    const dockId = await freeDock();
    const trip = await dispatchTrip(iso(now - 60 * 60_000), iso(now + 20 * 60_000));
    const appt = await book({
      tripId: trip.id,
      plate: trip.plate,
      locationId: dockId,
      windowStart: iso(now + 5 * 60_000),
      windowEnd: iso(now + 35 * 60_000),
    });
    const checked = await app.inject({
      method: "POST",
      url: "/gate/check-in",
      headers: tower(),
      payload: { siteId: whId, vehicleId: trip.vehicleId, tripId: trip.id, sealNo: "", notes: "" },
    });
    assert.equal(checked.statusCode, 200, checked.payload);
    try {
      await issue(trip.id, "delay", "Truck is already at the gate");
      const [rec] = (await recommendations(trip.id)) as Array<{
        prescribedActions: Array<{ type: string }>;
        preconditions: { manualReviewReason: string | null };
      }>;
      assert.ok(rec);
      assert.equal(rec.prescribedActions.length, 0);
      assert.match(rec.preconditions.manualReviewReason ?? "", /checked_in/i);
      const saved = await appointmentRow(appt.id);
      assert.equal(saved.status, "checked_in");
      assert.equal(saved.window_start, appt.windowStart);
    } finally {
      await cancel(appt.id);
    }

    const dock2 = await freeDock();
    const trip2 = await dispatchTrip(iso(now - 45 * 60_000), iso(now + 25 * 60_000));
    const cancelled = await book({
      tripId: trip2.id,
      plate: trip2.plate,
      locationId: dock2,
      windowStart: iso(now + 15 * 60_000),
      windowEnd: iso(now + 45 * 60_000),
    });
    await cancel(cancelled.id);
    await issue(trip2.id, "delay", "Appointment was cancelled");
    const rows = (await recommendations(trip2.id)) as Array<{
      prescribedActions: Array<{ type: string; payload: { appointmentId?: string } }>;
    }>;
    for (const rec of rows) {
      assert.equal(
        rec.prescribedActions.some((action) => action.payload.appointmentId === cancelled.id),
        false,
      );
    }
    const saved = await appointmentRow(cancelled.id);
    assert.equal(saved.status, "cancelled");
    assert.equal(saved.window_start, cancelled.windowStart);
  });

  it("asks for manual review when trip timing cannot support a future window", async () => {
    const now = Date.now();
    const dockId = await freeDock();
    const trip = await dispatchTrip(iso(now - 30 * 60_000), iso(now + 30 * 60_000));
    const appt = await book({
      tripId: trip.id,
      plate: trip.plate,
      locationId: dockId,
      windowStart: iso(now + 2 * 60 * 60_000),
      windowEnd: iso(now + 3 * 60 * 60_000),
    });
    const arrived = await app.inject({ method: "POST", url: `/trips/${trip.id}/arrive`, headers: tower() });
    assert.equal(arrived.statusCode, 200, arrived.payload);
    try {
      await issue(trip.id, "delay", "Truck has arrived and ETA is no longer projected");
      const [rec] = (await recommendations(trip.id)) as Array<{
        prescribedActions: Array<{ type: string }>;
        preconditions: { manualReviewReason: string | null };
      }>;
      assert.ok(rec);
      assert.equal(rec.prescribedActions.some((action) => action.type === "reschedule_appointment"), false);
      assert.match(rec.preconditions.manualReviewReason ?? "", /timing is missing or insufficient/i);
      const saved = await appointmentRow(appt.id);
      assert.equal(saved.window_start, appt.windowStart);
    } finally {
      await cancel(appt.id);
    }
  });

  it("returns a conflict and refreshes when the reviewed appointment changed", async () => {
    const now = Date.now();
    const dockId = await freeDock();
    const trip = await dispatchTrip(iso(now - 90 * 60_000), iso(now + 20 * 60_000));
    const appt = await book({
      tripId: trip.id,
      plate: trip.plate,
      locationId: dockId,
      windowStart: iso(now + 5 * 60_000),
      windowEnd: iso(now + 25 * 60_000),
    });
    const visitId = await occupy(dockId);
    try {
      await issue(trip.id, "delay", "Window will be edited before apply");
      const [rec] = (await recommendations(trip.id)) as Array<{ id: string; revision: number }>;
      assert.ok(rec);
      const editedStart = iso(now + 8 * 60_000);
      const editedEnd = iso(now + 28 * 60_000);
      run("UPDATE dock_appointments SET window_start = ?, window_end = ? WHERE id = ?", [editedStart, editedEnd, appt.id]);
      const apply = await app.inject({
        method: "POST",
        url: `/copilot/recommendations/${rec.id}/apply`,
        headers: tower(),
        payload: { revision: rec.revision },
      });
      assert.equal(apply.statusCode, 409, apply.payload);
      assert.match(JSON.parse(apply.payload).error, /review revision/i);
      const saved = await appointmentRow(appt.id);
      assert.equal(saved.window_start, editedStart);
      assert.equal(saved.window_end, editedEnd);
      const [refreshed] = (await recommendations(trip.id)) as Array<{ revision: number; status: string }>;
      assert.ok(refreshed.revision > rec.revision);
      assert.equal(refreshed.status, "pending");
    } finally {
      await release(visitId);
      await cancel(appt.id);
    }
  });

  it("rolls back a reschedule when a later action fails and rejects unknown actions", async () => {
    const now = Date.now();
    const dockId = await freeDock();
    const trip = await dispatchTrip(iso(now - 80 * 60_000), iso(now + 15 * 60_000));
    const appt = await book({
      tripId: trip.id,
      plate: trip.plate,
      locationId: dockId,
      windowStart: iso(now + 5 * 60_000),
      windowEnd: iso(now + 35 * 60_000),
    });
    const visitId = await occupy(dockId);
    try {
      await issue(trip.id, "delay", "Tamper the action list");
      const [rec] = (await recommendations(trip.id)) as Array<{
        id: string;
        revision: number;
        prescribedActions: unknown[];
      }>;
      assert.ok(rec);
      run("UPDATE copilot_recommendations SET prescribed_actions = ? WHERE id = ?", [
        JSON.stringify([
          ...rec.prescribedActions,
          { type: "resequence_pick", targetId: "nope", description: "not executable", payload: {} },
        ]),
        rec.id,
      ]);
      const rejected = await app.inject({
        method: "POST",
        url: `/copilot/recommendations/${rec.id}/apply`,
        headers: tower(),
        payload: { revision: rec.revision },
      });
      assert.equal(rejected.statusCode, 400, rejected.payload);
      assert.match(JSON.parse(rejected.payload).error, /unsupported or invalid copilot action/i);
      let saved = await appointmentRow(appt.id);
      assert.equal(saved.window_start, appt.windowStart);
      const failed = one(
        "SELECT id FROM events WHERE type = 'copilot.failed' AND entity_id = ? ORDER BY id DESC LIMIT 1",
        [rec.id],
      );
      assert.ok(failed);
      assert.equal(
        one("SELECT id FROM events WHERE type = 'copilot.applied' AND entity_id = ?", [rec.id]),
        undefined,
      );
      const execution = one<{ execution_error: string | null }>(
        "SELECT execution_error FROM copilot_recommendations WHERE id = ?",
        [rec.id],
      );
      assert.match(execution?.execution_error ?? "", /unsupported or invalid copilot action/i);
      const job = one<{ status: string; processing_error: string | null }>(
        `SELECT j.status, j.processing_error
         FROM copilot_jobs j
         JOIN copilot_recommendation_events e ON e.event_id = j.event_id
         WHERE e.recommendation_id = ?`,
        [rec.id],
      );
      assert.equal(job?.status, "done");
      assert.equal(job?.processing_error, null);

      run("UPDATE copilot_recommendations SET prescribed_actions = ? WHERE id = ?", [
        JSON.stringify(rec.prescribedActions),
        rec.id,
      ]);
      run(
        `CREATE TEMP TRIGGER copilot_fail_reschedule BEFORE UPDATE ON dock_appointments
         BEGIN SELECT RAISE(ABORT, 'forced failure'); END`,
      );
      const blown = await app.inject({
        method: "POST",
        url: `/copilot/recommendations/${rec.id}/apply`,
        headers: tower(),
        payload: { revision: rec.revision },
      });
      assert.equal(blown.statusCode, 500, blown.payload);
      saved = await appointmentRow(appt.id);
      assert.equal(saved.window_start, appt.windowStart);
      assert.equal(saved.window_end, appt.windowEnd);
      const pending = one<{ status: string }>("SELECT status FROM copilot_recommendations WHERE id = ?", [rec.id]);
      assert.equal(pending?.status, "pending");
    } finally {
      run("DROP TRIGGER IF EXISTS copilot_fail_reschedule");
      await release(visitId);
      await cancel(appt.id);
    }
  });

  it("auto-applies only a low or medium reschedule and leaves swaps and critical disruptions pending", async () => {
    const now = Date.now();
    const enabled = await app.inject({
      method: "POST",
      url: "/copilot/config",
      headers: tower(),
      payload: { autoPilot: true },
    });
    assert.equal(enabled.statusCode, 200);
    const configAudit = one<{ actor: string; payload: string }>(
      "SELECT actor, payload FROM events WHERE type = 'copilot.config' ORDER BY id DESC LIMIT 1",
    );
    assert.equal(configAudit?.actor, "Ava Chen");
    assert.equal(JSON.parse(configAudit!.payload).autoPilot, true);

    const rescheduleDock = await freeDock();
    const rescheduleTrip = await dispatchTrip(iso(now - 70 * 60_000), iso(now + 20 * 60_000));
    const rescheduleAppt = await book({
      tripId: rescheduleTrip.id,
      plate: rescheduleTrip.plate,
      locationId: rescheduleDock,
      windowStart: iso(now + 5 * 60_000),
      windowEnd: iso(now + 35 * 60_000),
    });
    const rescheduleVisit = await occupy(rescheduleDock);

    const criticalDock = await freeDock();
    const criticalTrip = await dispatchTrip(iso(now - 70 * 60_000), iso(now + 25 * 60_000));
    const criticalAppt = await book({
      tripId: criticalTrip.id,
      plate: criticalTrip.plate,
      locationId: criticalDock,
      windowStart: iso(now + 5 * 60_000),
      windowEnd: iso(now + 35 * 60_000),
    });
    const criticalVisit = await occupy(criticalDock);

    const swapDock = await freeDock();
    const swapTrip = await dispatchTrip(iso(now - 70 * 60_000), iso(now + 20 * 60_000));
    const swapAppt = await book({
      tripId: swapTrip.id,
      plate: swapTrip.plate,
      locationId: swapDock,
      windowStart: iso(now + 5 * 60_000),
      windowEnd: iso(now + 35 * 60_000),
    });

    try {
      await issue(rescheduleTrip.id, "delay", "Medium delay with a validated reschedule");
      const [autoRec] = (await recommendations(rescheduleTrip.id)) as Array<{ status: string }>;
      assert.equal(autoRec?.status, "auto_applied");
      const moved = await appointmentRow(rescheduleAppt.id);
      assert.equal(Date.parse(moved.window_end) - Date.parse(moved.window_start), 30 * 60_000);
      assert.ok(Date.parse(moved.window_start) > Date.parse(rescheduleAppt.windowStart));

      await issue(criticalTrip.id, "breakdown", "Engine failure needs Tower approval");
      const [criticalRec] = (await recommendations(criticalTrip.id)) as Array<{ status: string; severity: string }>;
      assert.equal(criticalRec?.status, "pending");
      assert.equal(criticalRec?.severity, "critical");
      const criticalSaved = await appointmentRow(criticalAppt.id);
      assert.equal(criticalSaved.window_start, criticalAppt.windowStart);

      await issue(swapTrip.id, "delay", "Delay with an eligible dock swap");
      const [swapRec] = (await recommendations(swapTrip.id)) as Array<{
        status: string;
        prescribedActions: Array<{ type: string }>;
      }>;
      assert.equal(swapRec?.status, "pending");
      assert.equal(swapRec.prescribedActions.some((action) => action.type === "swap_dock"), true);
      const swapSaved = await appointmentRow(swapAppt.id);
      assert.equal(swapSaved.window_start, swapAppt.windowStart);

      const occurred = new Date().toISOString();
      const highTrip = await dispatchTrip(iso(now - 50 * 60_000), iso(now + 20 * 60_000));
      const highDock = await freeDock();
      const highAppt = await book({
        tripId: highTrip.id,
        plate: highTrip.plate,
        locationId: highDock,
        windowStart: iso(now + 5 * 60_000),
        windowEnd: iso(now + 35 * 60_000),
      });
      const highVisit = await occupy(highDock);
      const inserted = run(
        `INSERT INTO events (type, source, actor, trip_id, message, payload, occurred_at, recorded_at)
         VALUES ('trip.issue', 'manual', 'Ava Chen', ?, ?, ?, ?, ?)`,
        [highTrip.id, `${highTrip.code} traffic: lane closed`, JSON.stringify({ kind: "traffic" }), occurred, occurred],
      );
      const highRec = evaluateDisruption({
        id: Number(inserted.lastInsertRowid),
        type: "trip.issue",
        source: "manual",
        actor: "Ava Chen",
        siteId: whId,
        vehicleId: highTrip.vehicleId,
        tripId: highTrip.id,
        driverId: null,
        locationId: highDock,
        huId: null,
        entityId: null,
        message: `${highTrip.code} traffic: lane closed`,
        payload: { kind: "traffic" },
        occurredAt: occurred,
        recordedAt: occurred,
      });
      assert.equal(highRec?.severity, "high");
      assert.equal(highRec?.status, "pending");
      const highSaved = await appointmentRow(highAppt.id);
      assert.equal(highSaved.window_start, highAppt.windowStart);
      await release(highVisit);
      await cancel(highAppt.id);
    } finally {
      await release(rescheduleVisit);
      await release(criticalVisit);
      await cancel(rescheduleAppt.id);
      await cancel(criticalAppt.id);
      await cancel(swapAppt.id);
    }
  });

  it("dismisses only the reviewed revision and records the actor", async () => {
    const now = Date.now();
    const dockId = await freeDock();
    const trip = await dispatchTrip(iso(now - 40 * 60_000), iso(now + 20 * 60_000));
    const appt = await book({
      tripId: trip.id,
      plate: trip.plate,
      locationId: dockId,
      windowStart: iso(now + 2 * 60 * 60_000),
      windowEnd: iso(now + 3 * 60 * 60_000),
    });
    const arrived = await app.inject({ method: "POST", url: `/trips/${trip.id}/arrive`, headers: tower() });
    assert.equal(arrived.statusCode, 200, arrived.payload);
    try {
      await issue(trip.id, "cargo", "Timing is insufficient, dismiss the review");
      const [rec] = (await recommendations(trip.id)) as Array<{ id: string; revision: number }>;
      assert.ok(rec);
      const wrong = await app.inject({
        method: "POST",
        url: `/copilot/recommendations/${rec.id}/dismiss`,
        headers: tower(),
        payload: { revision: rec.revision + 5 },
      });
      assert.equal(wrong.statusCode, 409, wrong.payload);
      assert.equal(one<{ status: string }>("SELECT status FROM copilot_recommendations WHERE id = ?", [rec.id])?.status, "pending");

      const dismissed = await app.inject({
        method: "POST",
        url: `/copilot/recommendations/${rec.id}/dismiss`,
        headers: tower(),
        payload: { revision: rec.revision },
      });
      assert.equal(dismissed.statusCode, 200, dismissed.payload);
      assert.equal(JSON.parse(dismissed.payload).status, "dismissed");
      assert.equal(JSON.parse(dismissed.payload).actor, "Ava Chen");
      const audit = one<{ actor: string; payload: string }>(
        "SELECT actor, payload FROM events WHERE type = 'copilot.dismissed' AND entity_id = ? ORDER BY id DESC LIMIT 1",
        [rec.id],
      );
      assert.equal(audit?.actor, "Ava Chen");
      assert.equal(JSON.parse(audit!.payload).revision, rec.revision);
    } finally {
      await cancel(appt.id);
    }
  });

  it("applies one recommendation once when the response is lost or two applies race", async () => {
    const now = Date.now();
    const dockId = await freeDock();
    const trip = await dispatchTrip(iso(now - 50 * 60_000), iso(now + 40 * 60_000));
    const appt = await book({
      tripId: trip.id,
      plate: trip.plate,
      locationId: dockId,
      windowStart: iso(now + 5 * 60_000),
      windowEnd: iso(now + 35 * 60_000),
    });
    const visitId = await occupy(dockId);
    try {
      await issue(trip.id, "delay", "Race and lost response stay a single reschedule");
      const [rec] = (await recommendations(trip.id)) as Array<{
        id: string;
        revision: number;
        prescribedActions: Array<{ type: string; payload: { newWindowStart: string } }>;
      }>;
      const move = rec?.prescribedActions.find((action) => action.type === "reschedule_appointment");
      assert.ok(rec && move);
      const [first, second] = await Promise.all([
        app.inject({ method: "POST", url: `/copilot/recommendations/${rec.id}/apply`, headers: tower(), payload: { revision: rec.revision } }),
        app.inject({ method: "POST", url: `/copilot/recommendations/${rec.id}/apply`, headers: tower(), payload: { revision: rec.revision } }),
      ]);
      const codes = [first.statusCode, second.statusCode].sort();
      assert.deepEqual(codes, [200, 400]);
      const saved = await appointmentRow(appt.id);
      assert.equal(saved.window_start, move.payload.newWindowStart);
      const again = await app.inject({
        method: "POST",
        url: `/copilot/recommendations/${rec.id}/apply`,
        headers: tower(),
        payload: { revision: rec.revision },
      });
      assert.equal(again.statusCode, 400, again.payload);
      assert.match(JSON.parse(again.payload).error, /already applied/);
      assert.equal(saved.window_start, (await appointmentRow(appt.id)).window_start);
      assert.equal(
        Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'appointment.rescheduled' AND entity_id = ?", [appt.id])?.n),
        1,
      );
    } finally {
      await release(visitId);
      await cancel(appt.id);
    }
  });
});
