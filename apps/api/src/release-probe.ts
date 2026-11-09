import { buildApp } from "./app.js";
import { prepareDatabase } from "./boot.js";
import { many, one, run, sqlite } from "./db.js";

const mode = process.argv[2] ?? "status";

function emit(payload: unknown) {
  console.log(`RELEASE_JSON ${JSON.stringify(payload)}`);
}

function counts() {
  const sites = Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM sites")?.n ?? 0);
  const users = Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n ?? 0);
  const migrations = many<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version").map((row) => row.version);
  const actor = many<{ name: string }>("PRAGMA table_info(copilot_recommendations)").some((column) => column.name === "actor");
  const job = one<{ status: string; attempts: number }>(
    "SELECT status, attempts FROM copilot_jobs WHERE id = 'job_release_recover'",
  );
  const stamped = one<{ planned_departure: string }>(
    `SELECT t.planned_departure FROM trips t
     JOIN events e ON e.trip_id = t.id
     JOIN copilot_jobs j ON j.event_id = e.id
     WHERE j.id = 'job_release_recover'`,
  );
  return { sites, users, migrations, actor, job: job ?? null, plannedDeparture: stamped?.planned_departure ?? null };
}

if (mode === "status") {
  const prepared = prepareDatabase();
  emit({ ...prepared, ...counts() });
} else if (mode === "stamp") {
  const prepared = prepareDatabase();
  const trip = one<{ id: string }>(
    "SELECT id FROM trips WHERE status IN ('planned', 'dispatched', 'in_transit', 'arrived') ORDER BY id LIMIT 1",
  );
  if (!trip) throw new Error("seeded database has no open trip to stamp");
  const planned = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  run("UPDATE trips SET planned_departure = ?, planned_arrival = ? WHERE id = ?", [
    planned,
    new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    trip.id,
  ]);
  const now = new Date().toISOString();
  const inserted = run(
    `INSERT INTO events (type, source, message, payload, occurred_at, recorded_at, trip_id)
     VALUES ('trip.updated', 'manual', 'release probe', '{}', ?, ?, ?)`,
    [now, now, trip.id],
  );
  run(
    `INSERT INTO copilot_jobs (id, event_id, status, attempts, processing_error, created_at, updated_at)
     VALUES ('job_release_recover', ?, 'processing', 2, 'crashed while processing', ?, ?)`,
    [Number(inserted.lastInsertRowid), now, now],
  );
  emit({ ...prepared, tripId: trip.id, attempts: 2, ...counts() });
} else if (mode === "recover") {
  const prepared = prepareDatabase();
  const app = await buildApp({ logger: false });
  await app.ready();
  emit({ ...prepared, ...counts() });
  await app.close();
} else {
  throw new Error(`Unknown probe mode ${mode}`);
}

sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
sqlite.close();
