/**
 * Throwaway audit probe. Uses audit/probe.db only.
 * Prints one JSON object. Do not treat a missing key as a pass.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = path.join(root, "audit", "probe.db");
for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
process.env.CORELOGISTICS_DB = dbPath;
process.env.CORELOGISTICS_DEMO = "0";

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
const { buildApp } = await import("../apps/api/src/app.ts");
const { one, run, scalar } = await import("../apps/api/src/db.ts");
const { migrate } = await import("../apps/api/src/migrate.ts");
const { ensureDemoUsers, seedIfEmpty } = await import("../apps/api/src/seed.ts");
const { catchUp, copilotRuntime, wake } = await import("../apps/api/src/modules/copilot/worker.ts");
const { demoMode } = await import("../apps/api/src/boot.ts");

const out: Record<string, unknown> = { demoModeInThisProcess: demoMode() };

function demoFlag(env: Record<string, string>, args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "audit", "demo-flag.ts"), ...args], {
    cwd: root,
    env: { ...process.env, CORELOGISTICS_DB: dbPath, CORELOGISTICS_DEMO: "", ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}
out.demoOff = demoFlag({ CORELOGISTICS_DEMO: "0" }, []);
out.demoOn = demoFlag({ CORELOGISTICS_DEMO: "1" }, []);
out.demoArg = demoFlag({ CORELOGISTICS_DEMO: "" }, ["--demo"]);

migrate();
seedIfEmpty();
ensureDemoUsers();
const maxEventBeforeWorker = Number(scalar("SELECT COALESCE(MAX(id), 0) FROM events"));
const app = await buildApp({ logger: false });
await app.ready();
out.runtimeAfterFirstApp = copilotRuntime();
const second = await buildApp({ logger: false });
await second.ready();
out.runtimeAfterSecondApp = copilotRuntime();
const cursorAfterStart = one<{ event_id: number }>("SELECT event_id FROM copilot_cursor WHERE id = 1");
const jobsForHistory = Number(
  scalar("SELECT COUNT(*) FROM copilot_jobs WHERE event_id <= ?", [maxEventBeforeWorker]),
);
out.firstInstall = { maxEventBeforeWorker, cursor: cursorAfterStart?.event_id ?? null, jobsAtOrBeforeThatBoundary: jobsForHistory };

async function login(username: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
  return { status: res.statusCode, token: res.statusCode === 200 ? (JSON.parse(res.body).token as string) : null, body: res.body };
}

const ava = await login("ava", "planner");
const mina = await login("mina", "floor");
const rico = await login("rico", "yard");
const jose = await login("jose", "drive");
const maria = await login("maria", "drive");
out.logins = {
  ava: ava.status,
  mina: mina.status,
  rico: rico.status,
  jose: jose.status,
  maria: maria.status,
};

const tower = { "x-session": ava.token! };
const floor = { "x-session": mina.token! };
const gate = { "x-session": rico.token! };
const driver = { "x-session": jose.token! };

async function statusOf(method: string, url: string, headers: Record<string, string>, payload?: unknown) {
  const res = await app.inject({ method: method as "GET", url, headers, payload });
  return { status: res.statusCode, body: res.body.slice(0, 300) };
}

const health = await app.inject({ method: "GET", url: "/health" });
out.health = { status: health.statusCode, body: JSON.parse(health.body) };
out.auth = {
  warehouseApply: await statusOf("POST", "/copilot/recommendations/cop_missing/apply", floor, { revision: 1 }),
  gateApply: await statusOf("POST", "/copilot/recommendations/cop_missing/apply", gate, { revision: 1 }),
  driverApply: await statusOf("POST", "/copilot/recommendations/cop_missing/apply", driver, { revision: 1 }),
  anonApply: await statusOf("POST", "/copilot/recommendations/cop_missing/apply", {}, { revision: 1 }),
  warehouseConfig: await statusOf("POST", "/copilot/config", floor, { autoPilot: true }),
  warehouseRetry: await statusOf("POST", "/copilot/jobs/job_missing/retry", floor),
  gateRetry: await statusOf("POST", "/copilot/jobs/job_missing/retry", gate),
  configNow: await statusOf("GET", "/copilot/config", tower),
};

const whId = one<{ id: string }>("SELECT id FROM sites WHERE code = 'WH-C'")!.id;
const depotId = one<{ id: string }>("SELECT id FROM sites WHERE code = 'DEP-N'")!.id;
const dock = one<{ id: string; code: string }>(
  `SELECT id, code FROM locations WHERE site_id = ? AND kind = 'dock_door' AND active = 1 ORDER BY code LIMIT 1`,
  [whId],
)!;

const day = "2027-06-15";
async function book(plate: string, start: string, end: string, locationId = dock.id) {
  const res = await app.inject({
    method: "POST",
    url: "/gate/appointments",
    headers: tower,
    payload: {
      siteId: whId,
      plate,
      carrier: "Audit",
      purpose: "unload",
      locationId,
      windowStart: start,
      windowEnd: end,
      notes: "",
    },
  });
  return { status: res.statusCode, body: res.body.slice(0, 400), id: res.statusCode === 200 ? JSON.parse(res.body).id as string : null };
}

const baseStart = `${day}T09:00:00.000Z`;
const baseEnd = `${day}T12:00:00.000Z`;
const first = await book("AUD1001", baseStart, baseEnd);
const touching = await book("AUD1002", `${day}T12:00:00.000Z`, `${day}T13:00:00.000Z`);
const overlapMs = await book("AUD1003", `${day}T11:59:59.999Z`, `${day}T13:00:00.000Z`);
const sameInstantOffset = await book("AUD1004", `${day}T17:00:00+08:00`, `${day}T20:00:00+08:00`);
out.overlap = { dock: dock.code, first, touching, overlapMs, sameInstantOffset };

const checked = await book("AUD1005", `${day}T14:00:00.000Z`, `${day}T15:00:00.000Z`);
if (checked.id) run("UPDATE dock_appointments SET status = 'checked_in' WHERE id = ?", [checked.id]);
const overCheckedIn = await book("AUD1006", `${day}T14:30:00.000Z`, `${day}T15:30:00.000Z`);
out.checkedInBlocks = { checked: checked.status, overCheckedIn };

const cancelled = await book("AUD1007", `${day}T16:00:00.000Z`, `${day}T17:00:00.000Z`);
let cancelStatus: number | null = null;
if (cancelled.id) {
  const res = await app.inject({ method: "POST", url: `/gate/appointments/${cancelled.id}/cancel`, headers: tower });
  cancelStatus = res.statusCode;
}
const overCancelled = await book("AUD1008", `${day}T16:30:00.000Z`, `${day}T17:30:00.000Z`);
out.cancelledDoesNotBlock = { cancelStatus, overCancelled: overCancelled.status };

function addVehicle(siteId: string, n: number) {
  const id = `veh_audit_${n}`;
  const plate = `AU${String(n).padStart(4, "0")}`;
  run(
    `INSERT INTO vehicles (id, code, plate, kind, model, status, home_site_id) VALUES (?, ?, ?, 'truck', 'Audit', 'available', ?)`,
    [id, `V-${id}`, plate, siteId],
  );
  return { id, plate };
}
function addDriver(siteId: string, n: number) {
  const id = `drv_audit_${n}`;
  run(
    `INSERT INTO drivers (id, code, name, license_class, license_expiry, status, home_site_id) VALUES (?, ?, 'Audit Driver', 'C', '2030-01-01', 'available', ?)`,
    [id, `D-${id}`, siteId],
  );
  return id;
}

const now = Date.now();
const vehicle = addVehicle(depotId, 1);
const driverId = addDriver(depotId, 1);
const tripRes = await app.inject({
  method: "POST",
  url: "/trips",
  headers: tower,
  payload: {
    kind: "inbound",
    originSiteId: depotId,
    destinationSiteId: whId,
    vehicleId: vehicle.id,
    driverId,
    plannedDeparture: new Date(now - 3 * 3600_000).toISOString(),
    plannedArrival: new Date(now - 30 * 60_000).toISOString(),
    notes: "",
  },
});
const trip = tripRes.statusCode === 200 ? JSON.parse(tripRes.body) : null;
if (trip) {
  await app.inject({ method: "POST", url: `/trips/${trip.id}/dispatch`, headers: tower });
}
const lateDock = one<{ id: string }>(
  `SELECT id FROM locations WHERE site_id = ? AND kind = 'dock_door' AND active = 1 AND id != ? ORDER BY code LIMIT 1`,
  [whId, dock.id],
);
let appointmentId: string | null = null;
if (trip && lateDock) {
  const booked = await app.inject({
    method: "POST",
    url: "/gate/appointments",
    headers: tower,
    payload: {
      siteId: whId,
      tripId: trip.id,
      plate: vehicle.plate,
      carrier: "Audit",
      purpose: "unload",
      locationId: lateDock.id,
      windowStart: new Date(now + 10 * 60_000).toISOString(),
      windowEnd: new Date(now + 40 * 60_000).toISOString(),
      notes: "",
    },
  });
  appointmentId = booked.statusCode === 200 ? JSON.parse(booked.body).id : null;
  out.lateBooking = { status: booked.statusCode, body: booked.body.slice(0, 300) };
}
if (trip) {
  const issue = await app.inject({
    method: "POST",
    url: `/trips/${trip.id}/issues`,
    headers: tower,
    payload: { kind: "delay", message: "Audit delay" },
  });
  out.issue = { status: issue.statusCode, body: issue.body.slice(0, 200) };
  const recs = await app.inject({
    method: "GET",
    url: `/copilot/recommendations?status=pending&limit=20`,
    headers: tower,
  });
  const pending = (JSON.parse(recs.body) as Array<{ id: string; tripId: string | null; revision: number; severity: string; prescribedActions: Array<{ type: string }>; preconditions: { trip: { etaAt: string | null } | null; proposedWindow: { windowStart: string } | null } }>).filter((rec) => rec.tripId === trip.id);
  const rec = pending[0];
  if (rec) {
    const beforeEta = rec.preconditions.trip?.etaAt ?? null;
    const beforeWindow = rec.preconditions.proposedWindow?.windowStart ?? null;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const live = await app.inject({ method: "GET", url: `/trips/${trip.id}`, headers: tower });
    const liveEta = JSON.parse(live.body).etaAt as string;
    const applied = await app.inject({
      method: "POST",
      url: `/copilot/recommendations/${rec.id}/apply`,
      headers: tower,
      payload: { revision: rec.revision, auto: true },
    });
    const appliedBody = applied.statusCode === 200 ? JSON.parse(applied.body) : null;
    out.etaDrift = {
      severity: rec.severity,
      actions: rec.prescribedActions.map((action) => action.type),
      beforeEta,
      liveEta,
      etaChanged: beforeEta !== liveEta,
      beforeWindow,
      applyStatus: applied.statusCode,
      applyError: applied.statusCode === 200 ? null : applied.body.slice(0, 300),
      resultStatus: appliedBody?.status ?? null,
      autoFlagIgnored: appliedBody?.status !== "auto_applied",
    };
  } else {
    out.etaDrift = { missingRecommendation: true, listStatus: recs.statusCode, body: recs.body.slice(0, 300) };
  }
}

const sku = one<{ id: string }>("SELECT id FROM skus WHERE zone != 'H' LIMIT 1")!;
const receipt = await app.inject({
  method: "POST",
  url: "/warehouse/receipts",
  headers: floor,
  payload: { siteId: whId, supplier: "Audit", lines: [{ skuId: sku.id, expectedQty: 4 }] },
});
const receiptId = JSON.parse(receipt.body).id as string;
const received = await app.inject({
  method: "POST",
  url: `/warehouse/receipts/${receiptId}/receive`,
  headers: floor,
  payload: { skuId: sku.id, qty: 4, kind: "pallet" },
});
const hu = JSON.parse(received.body) as { id: string; code: string };
const sorted = await app.inject({ method: "POST", url: `/warehouse/hus/${hu.id}/sort`, headers: floor });
const putaway = JSON.parse(sorted.body).putaway as { id: string; huCode: string; suggestedCode: string };
const confirmationsBefore = Number(scalar("SELECT COUNT(*) FROM stock_confirmations"));
const padded = await app.inject({
  method: "POST",
  url: `/warehouse/putaway/${putaway.id}/confirm`,
  headers: floor,
  payload: {
    mode: "match",
    requestId: "audit-pad-0001",
    entryMethod: "keyboard",
    huBarcode: `  ${putaway.huCode.toLowerCase()}\t`,
    binBarcode: `\n${putaway.suggestedCode.toLowerCase()} `,
  },
});
const paddedBody = padded.statusCode === 200 ? JSON.parse(padded.body) : null;
const replay = await app.inject({
  method: "POST",
  url: `/warehouse/putaway/${putaway.id}/confirm`,
  headers: tower,
  payload: {
    mode: "match",
    requestId: "audit-pad-0001",
    entryMethod: "keyboard",
    huBarcode: putaway.huCode,
    binBarcode: putaway.suggestedCode,
  },
});
const changed = await app.inject({
  method: "POST",
  url: `/warehouse/putaway/${putaway.id}/confirm`,
  headers: floor,
  payload: {
    mode: "match",
    requestId: "audit-pad-0001",
    entryMethod: "manual",
    huBarcode: putaway.huCode,
    binBarcode: "OTHER-BIN",
  },
});
const leading = await app.inject({
  method: "POST",
  url: `/warehouse/putaway/${putaway.id}/confirm`,
  headers: floor,
  payload: {
    mode: "match",
    requestId: "audit-lead-0002",
    entryMethod: "keyboard",
    huBarcode: `00${putaway.huCode}`,
    binBarcode: putaway.suggestedCode,
  },
});
const withLocation = await app.inject({
  method: "POST",
  url: `/warehouse/putaway/${putaway.id}/confirm`,
  headers: floor,
  payload: {
    mode: "match",
    requestId: "audit-loc-0003",
    entryMethod: "manual",
    huBarcode: "NOT-THE-UNIT",
    binBarcode: putaway.suggestedCode,
    locationId: "loc_forged",
  },
});
out.stock = {
  paddedStatus: padded.statusCode,
  paddedError: padded.statusCode === 200 ? null : padded.body.slice(0, 250),
  storedCode: paddedBody?.huCode ?? null,
  crossUserReplay: replay.statusCode,
  changedAfterSuccess: { status: changed.statusCode, body: changed.body.slice(0, 200) },
  leadingZeros: { status: leading.statusCode, body: leading.body.slice(0, 200) },
  forgedLocationId: { status: withLocation.statusCode, body: withLocation.body.slice(0, 200) },
  confirmationRows: Number(scalar("SELECT COUNT(*) FROM stock_confirmations")) - confirmationsBefore,
  putawayEvents: Number(scalar("SELECT COUNT(*) FROM events WHERE type = 'putaway.done' AND entity_id = ?", [putaway.id])),
};

const receipt2 = await app.inject({
  method: "POST",
  url: "/warehouse/receipts",
  headers: floor,
  payload: { siteId: whId, supplier: "Audit 2", lines: [{ skuId: sku.id, expectedQty: 1 }] },
});
const received2 = await app.inject({
  method: "POST",
  url: `/warehouse/receipts/${JSON.parse(receipt2.body).id}/receive`,
  headers: floor,
  payload: { skuId: sku.id, qty: 1, kind: "pallet" },
});
const hu2 = JSON.parse(received2.body) as { code: string };
const sorted2 = await app.inject({ method: "POST", url: `/warehouse/hus/${JSON.parse(received2.body).id}/sort`, headers: floor });
const putaway2 = JSON.parse(sorted2.body).putaway as { id: string; huCode: string; suggestedCode: string };
const rowsBeforeReject = Number(scalar("SELECT COUNT(*) FROM stock_confirmations"));
const driverConfirm = await app.inject({
  method: "POST",
  url: `/warehouse/putaway/${putaway2.id}/confirm`,
  headers: driver,
  payload: {
    mode: "match",
    requestId: "audit-driver-01",
    entryMethod: "keyboard",
    huBarcode: putaway2.huCode,
    binBarcode: putaway2.suggestedCode,
  },
});
const gateConfirm = await app.inject({
  method: "POST",
  url: `/warehouse/putaway/${putaway2.id}/confirm`,
  headers: gate,
  payload: {
    mode: "match",
    requestId: "audit-gate-0001",
    entryMethod: "keyboard",
    huBarcode: putaway2.huCode,
    binBarcode: putaway2.suggestedCode,
  },
});
const shortOverride = await app.inject({
  method: "POST",
  url: `/warehouse/putaway/${putaway2.id}/confirm`,
  headers: tower,
  payload: { mode: "override", requestId: "audit-short-01", entryMethod: "manual", reason: "no" },
});
out.rejectedConfirms = {
  driver: { status: driverConfirm.statusCode, body: driverConfirm.body.slice(0, 180) },
  gate: { status: gateConfirm.statusCode, body: gateConfirm.body.slice(0, 180) },
  shortReason: { status: shortOverride.statusCode, body: shortOverride.body.slice(0, 180) },
  rowsAdded: Number(scalar("SELECT COUNT(*) FROM stock_confirmations")) - rowsBeforeReject,
  taskStatus: one("SELECT status FROM putaway_tasks WHERE id = ?", [putaway2.id])?.status,
  hu2: hu2.code,
};

const joseTrip = one<{ id: string; driver_id: string | null }>(
  `SELECT t.id, t.driver_id FROM trips t JOIN users u ON u.driver_id = t.driver_id WHERE u.username = 'jose' AND t.status NOT IN ('completed', 'cancelled') LIMIT 1`,
);
const otherTrip = one<{ id: string }>(
  `SELECT t.id FROM trips t WHERE t.driver_id IS NOT NULL AND t.driver_id != (SELECT driver_id FROM users WHERE username = 'jose') AND t.status NOT IN ('completed', 'cancelled') LIMIT 1`,
);
if (otherTrip) {
  const depart = await app.inject({ method: "POST", url: `/trips/${otherTrip.id}/depart`, headers: driver });
  const read = await app.inject({ method: "GET", url: `/trips/${otherTrip.id}`, headers: driver });
  out.driverIdor = { depart: depart.statusCode, read: read.statusCode, body: depart.body.slice(0, 180) };
} else {
  out.driverIdor = { missingTrip: true, joseTrip };
}
const list = await app.inject({ method: "GET", url: "/trips?limit=50", headers: driver });
const listed = list.statusCode === 200 ? (JSON.parse(list.body) as Array<{ driverId: string | null }>) : [];
out.driverList = {
  status: list.statusCode,
  count: listed.length,
  foreign: listed.filter((tripRow) => joseTrip && tripRow.driverId !== joseTrip.driver_id).length,
};

const poisonAt = new Date().toISOString();
run(
  `INSERT INTO events (type, source, actor, message, payload, occurred_at, recorded_at) VALUES ('trip.issue', 'manual', 'audit', 'poison', 'NOT JSON', ?, ?)`,
  [poisonAt, poisonAt],
);
const poisonId = Number(scalar("SELECT MAX(id) FROM events"));
let poisonThrow: string | null = null;
try {
  catchUp();
  wake();
} catch (err) {
  poisonThrow = err instanceof Error ? err.message : String(err);
}
const poisonJob = one<{ status: string; attempts: number; processing_error: string | null }>(
  "SELECT status, attempts, processing_error FROM copilot_jobs WHERE event_id = ?",
  [poisonId],
);
let secondThrow: string | null = null;
try {
  wake();
} catch (err) {
  secondThrow = err instanceof Error ? err.message : String(err);
}
const poisonAfter = one<{ status: string; attempts: number }>(
  "SELECT status, attempts FROM copilot_jobs WHERE event_id = ?",
  [poisonId],
);
out.poisonJob = { poisonThrow, secondThrow, first: poisonJob, afterSecondWake: poisonAfter };

const scannerLine = fs.readFileSync(path.join(root, "packages", "ui", "src", "CameraScanner.tsx"), "utf8").split(/\r?\n/)[95];
out.cameraVisibilityCondition = scannerLine?.trim() ?? null;

await second.close();
await app.close();
console.log(JSON.stringify(out, null, 2));
}
