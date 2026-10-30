import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { many, run, sqlite } from "./db.js";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Applies every `migrations/NNN_*.sql` file not yet recorded, in name order. */
export function migrate(): string[] {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    many<{ version: string }>("SELECT version FROM schema_migrations").map((r) => r.version),
  );
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(sql);
      run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        file,
        new Date().toISOString(),
      ]);
      sqlite.exec("COMMIT");
      ran.push(file);
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return ran;
}
