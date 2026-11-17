/** Throwaway follow-up against audit/probe.db. Does not delete that file. */
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
  const { DatabaseSync } = await import("node:sqlite");
  const scrub = new DatabaseSync(process.env.CORELOGISTICS_DB!);
  scrub.exec(
    "UPDATE copilot_jobs SET status = 'done' WHERE event_id IN (SELECT id FROM events WHERE payload = 'NOT JSON')",
  );
  scrub.close();

  const { buildApp } = await import("../apps/api/src/app.ts");
  const { one, run, scalar } = await import("../apps/api/src/db.ts");
  const { rescheduleAppointment } = await import("../apps/api/src/modules/gate/service.ts");
  const { systemCtx } = await import("../apps/api/src/events.ts");

  const app = await buildApp({ logger: false });
  await app.ready();
  const login = async (username: string, password: string) =>
    JSON.parse((await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } })).body).token as string;
  const tower = { "x-session": await login("ava", "planner") };
  const floor = { "x-session": await login("mina", "floor") };
  const out: Record<string, unknown> = {};

  const dock = one<{ id: string; code: string }>(
    `SELECT id, code FROM locations WHERE site_id = (SELECT id FROM sites WHERE code = 'WH-C') AND kind = 'dock_door' AND active = 1 ORDER BY code DESC LIMIT 1`,
  )!;
  const whId = one<{ id: string }>("SELECT id FROM sites WHERE code = 'WH-C'")!.id;
  const book = async (plate: string, start: string, end: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/gate/appointments",
      headers: tower,
      payload: { siteId: whId, plate, carrier: "Audit", purpose: "unload", locationId: dock.id, windowStart: start, windowEnd: end, notes: "" },
    });
    return { status: res.statusCode, body: res.body.slice(0, 280), id: res.statusCode === 200 ? (JSON.parse(res.body).id as string) : null };
  };
  const original = await book("CAN0001", "2028-03-01T08:00:00.000Z", "2028-03-01T09:00:00.000Z");
  const cancel = original.id
    ? await app.inject({ method: "POST", url: `/gate/appointments/${original.id}/cancel`, headers: tower })
    : null;
  const afterCancel = await book("CAN0002", "2028-03-01T08:30:00.000Z", "2028-03-01T09:30:00.000Z");
  out.cancelOverlap = { dock: dock.code, original: original.status, cancel: cancel?.statusCode ?? null, afterCancel: afterCancel.status };

  const open = one<{ id: string; hu_code: string; bin_code: string }>(
    `SELECT p.id, h.code AS hu_code, l.code AS bin_code
     FROM putaway_tasks p
     JOIN handling_units h ON h.id = p.hu_id
     LEFT JOIN locations l ON l.id = p.suggested_location_id
     WHERE p.status = 'open' LIMIT 1`,
  );
  if (open?.bin_code) {
    const leading = await app.inject({
      method: "POST",
      url: `/warehouse/putaway/${open.id}/confirm`,
      headers: floor,
      payload: { mode: "match", requestId: "audit-lead-0099", entryMethod: "keyboard", huBarcode: `00${open.hu_code}`, binBarcode: open.bin_code },
    });
    const gs1 = await app.inject({
      method: "POST",
      url: `/warehouse/putaway/${open.id}/confirm`,
      headers: floor,
      payload: { mode: "match", requestId: "audit-gs1-0099", entryMethod: "camera", huBarcode: `]C1${open.hu_code}`, binBarcode: open.bin_code },
    });
    const forged = await app.inject({
      method: "POST",
      url: `/warehouse/putaway/${open.id}/confirm`,
      headers: floor,
      payload: { mode: "match", requestId: "audit-loc-0099", entryMethod: "manual", huBarcode: "NOT-THE-UNIT", binBarcode: open.bin_code, locationId: "loc_forged" },
    });
    const reused = await app.inject({
      method: "POST",
      url: `/warehouse/putaway/${open.id}/confirm`,
      headers: floor,
      payload: { mode: "match", requestId: "audit-pad-0001", entryMethod: "keyboard", huBarcode: open.hu_code, binBarcode: open.bin_code },
    });
    out.openTask = {
      hu: open.hu_code,
      leading: { status: leading.statusCode, body: leading.body.slice(0, 180) },
      gs1: { status: gs1.statusCode, body: gs1.body.slice(0, 180) },
      forgedLocation: { status: forged.statusCode, body: forged.body.slice(0, 180) },
      reusedRequestId: { status: reused.statusCode, body: reused.body.slice(0, 180) },
      stillOpen: one("SELECT status FROM putaway_tasks WHERE id = ?", [open.id])?.status,
    };
  }

  const appt = one<{ id: string; window_start: string; window_end: string; trip_id: string | null; site_id: string; location_id: string | null }>(
    "SELECT id, window_start, window_end, trip_id, site_id, location_id FROM dock_appointments WHERE plate = 'CAN0002'",
  );
  if (appt) {
    const eventsBefore = Number(scalar("SELECT COUNT(*) FROM events WHERE type = 'appointment.rescheduled'"));
    run(
      `CREATE TEMP TRIGGER audit_fail_reschedule BEFORE UPDATE ON dock_appointments
       BEGIN SELECT RAISE(ABORT, 'forced failure'); END`,
    );
    let thrown: string | null = null;
    try {
      const start = new Date(Date.parse(appt.window_start) + 3600_000).toISOString();
      const end = new Date(Date.parse(appt.window_end) + 3600_000).toISOString();
      rescheduleAppointment(appt.id, start, end, { tripId: appt.trip_id, siteId: appt.site_id, locationId: appt.location_id }, systemCtx);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    run("DROP TRIGGER IF EXISTS audit_fail_reschedule");
    const saved = one<{ window_start: string; window_end: string }>("SELECT window_start, window_end FROM dock_appointments WHERE id = ?", [appt.id]);
    out.rollback = {
      thrown,
      windowUnchanged: saved?.window_start === appt.window_start && saved?.window_end === appt.window_end,
      rescheduledEventsAdded: Number(scalar("SELECT COUNT(*) FROM events WHERE type = 'appointment.rescheduled'")) - eventsBefore,
    };
  }

  const enabled = await app.inject({ method: "POST", url: "/copilot/config", headers: tower, payload: { autoPilot: true } });
  const depotId = one<{ id: string }>("SELECT id FROM sites WHERE code = 'DEP-N'")!.id;
  const n = 7;
  run(
    `INSERT INTO vehicles (id, code, plate, kind, model, status, home_site_id) VALUES ('veh_audit_${n}', 'V-${n}', 'AU0007', 'truck', 'Audit', 'available', ?)`,
    [depotId],
  );
  run(
    `INSERT INTO drivers (id, code, name, license_class, license_expiry, status, home_site_id) VALUES ('drv_audit_${n}', 'D-${n}', 'Audit Driver', 'C', '2030-01-01', 'available', ?)`,
    [depotId],
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
      vehicleId: `veh_audit_${n}`,
      driverId: `drv_audit_${n}`,
      plannedDeparture: new Date(now - 3 * 3600_000).toISOString(),
      plannedArrival: new Date(now - 30 * 60_000).toISOString(),
      notes: "",
    },
  });
  const trip = JSON.parse(created.body);
  await app.inject({ method: "POST", url: `/trips/${trip.id}/dispatch`, headers: tower });
  const freeDock = one<{ id: string }>(
    `SELECT l.id FROM locations l WHERE l.site_id = ? AND l.kind = 'dock_door' AND l.active = 1
       AND NOT EXISTS (SELECT 1 FROM dock_appointments a WHERE a.location_id = l.id AND a.status IN ('scheduled','checked_in') AND a.window_end > ?)
     ORDER BY l.code LIMIT 1`,
    [whId, new Date().toISOString()],
  );
  if (freeDock) {
    await app.inject({
      method: "POST",
      url: "/gate/appointments",
      headers: tower,
      payload: {
        siteId: whId,
        tripId: trip.id,
        plate: "AU0007",
        carrier: "Audit",
        purpose: "unload",
        locationId: freeDock.id,
        windowStart: new Date(now + 10 * 60_000).toISOString(),
        windowEnd: new Date(now + 40 * 60_000).toISOString(),
        notes: "",
      },
    });
  }
  const issue = await app.inject({
    method: "POST",
    url: `/trips/${trip.id}/issues`,
    headers: tower,
    payload: { kind: "accident", message: "Audit critical" },
  });
  const recs = JSON.parse(
    (await app.inject({ method: "GET", url: "/copilot/recommendations?status=pending,auto_applied&limit=50", headers: tower })).body,
  ) as Array<{ tripId: string | null; status: string; severity: string; prescribedActions: Array<{ type: string }> }>;
  const critical = recs.filter((rec) => rec.tripId === trip.id);
  await app.inject({ method: "POST", url: "/copilot/config", headers: tower, payload: { autoPilot: false } });
  out.criticalAuto = {
    configEnable: enabled.statusCode,
    issue: issue.statusCode,
    freeDock: Boolean(freeDock),
    recs: critical.map((rec) => ({ status: rec.status, severity: rec.severity, actions: rec.prescribedActions.map((action) => action.type) })),
  };

  await app.close();
  console.log(JSON.stringify(out, null, 2));
}
