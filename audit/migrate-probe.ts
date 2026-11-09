/**
 * Throwaway audit probe. Applies migrations 001-005, inserts a recommendation,
 * then applies 006-008 and compares the row. Does not touch the demo database.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "audit");
const dbPath = path.join(dir, "migrate-probe.db");
for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

const migrationsDir = path.join(root, "apps", "api", "migrations");
const files = fs.readdirSync(migrationsDir).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");

function apply(name: string) {
  db.exec(fs.readFileSync(path.join(migrationsDir, name), "utf8"));
}

const before006 = files.filter((name) => name < "006");
const from006 = files.filter((name) => name >= "006");
for (const name of before006) apply(name);

const original = {
  id: "cop_audit_preserve",
  disruption_event_id: null,
  severity: "high",
  title: "Keep this recommendation",
  root_cause: "Audit probe",
  impact_summary: "Row must survive the rebuild",
  prescribed_actions: JSON.stringify([{ type: "reschedule_appointment", targetId: "app_x", description: "move", payload: { appointmentId: "app_x", newWindowStart: "2026-12-01T00:00:00.000Z", newWindowEnd: "2026-12-01T01:00:00.000Z" } }]),
  status: "pending",
  site_id: null,
  trip_id: null,
  created_at: "2026-01-01T00:00:00.000Z",
  applied_at: null,
  revision: 4,
  preconditions: JSON.stringify({ evaluatedAt: "2026-01-01T00:00:00.000Z", keep: true }),
};
db.prepare(
  `INSERT INTO copilot_recommendations
     (id, disruption_event_id, severity, title, root_cause, impact_summary, prescribed_actions, status, site_id, trip_id, created_at, applied_at, revision, preconditions)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  original.id,
  original.disruption_event_id,
  original.severity,
  original.title,
  original.root_cause,
  original.impact_summary,
  original.prescribed_actions,
  original.status,
  original.site_id,
  original.trip_id,
  original.created_at,
  original.applied_at,
  original.revision,
  original.preconditions,
);
const beforeCount = Number(db.prepare("SELECT COUNT(*) AS n FROM copilot_recommendations").get().n);
const beforeConfig = db.prepare("SELECT value FROM copilot_config WHERE key = 'auto_pilot'").get();

let migrationError: string | null = null;
try {
  for (const name of from006) apply(name);
} catch (err) {
  migrationError = err instanceof Error ? err.message : String(err);
}

const after = migrationError
  ? null
  : db.prepare("SELECT * FROM copilot_recommendations WHERE id = ?").get(original.id);
const afterCount = migrationError ? null : Number(db.prepare("SELECT COUNT(*) AS n FROM copilot_recommendations").get().n);
const afterConfig = migrationError ? null : db.prepare("SELECT value FROM copilot_config WHERE key = 'auto_pilot'").get();
const columns = migrationError
  ? []
  : db.prepare("PRAGMA table_info(copilot_recommendations)").all().map((row) => row.name);

const same =
  after &&
  after.id === original.id &&
  after.severity === original.severity &&
  after.title === original.title &&
  after.root_cause === original.root_cause &&
  after.impact_summary === original.impact_summary &&
  after.prescribed_actions === original.prescribed_actions &&
  after.status === original.status &&
  after.revision === original.revision &&
  after.preconditions === original.preconditions &&
  after.created_at === original.created_at &&
  after.applied_at === original.applied_at &&
  after.site_id === original.site_id &&
  after.trip_id === original.trip_id;

console.log(
  JSON.stringify(
    {
      migrationError,
      beforeCount,
      afterCount,
      configBefore: beforeConfig?.value ?? null,
      configAfter: afterConfig?.value ?? null,
      actorColumn: columns.includes("actor"),
      actorValue: after ? after.actor : null,
      rowPreserved: Boolean(same),
      lifecycle: after?.lifecycle ?? null,
      appliedFiles: from006,
    },
    null,
    2,
  ),
);
db.close();
