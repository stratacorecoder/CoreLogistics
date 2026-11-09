import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const apiRoot = path.resolve(import.meta.dirname, "..");

function probe(dir: string, demo: boolean, mode: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/release-probe.ts", mode], {
    cwd: apiRoot,
    env: {
      ...process.env,
      CORELOGISTICS_DATA_DIR: dir,
      CORELOGISTICS_DB: "corelogistics.db",
      CORELOGISTICS_DEMO: demo ? "1" : "0",
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `${mode}\n${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split(/\r?\n/).find((row) => row.startsWith("RELEASE_JSON "));
  assert.ok(line, result.stdout);
  return JSON.parse(line.slice("RELEASE_JSON ".length)) as {
    seeded: boolean;
    refreshedTrips: number;
    refreshedOrders: number;
    sites: number;
    users: number;
    migrations: string[];
    actor: boolean;
    job: { status: string; attempts: number } | null;
    plannedDeparture: string | null;
  };
}

describe("Release validation", () => {
  it("migrates a disposable database, restores a backup, and recovers a crashed job without demo rebase", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "corelog-release-"));
    const db = path.join(dir, "corelogistics.db");
    const backup = path.join(dir, "backup.db");
    try {
      const empty = probe(dir, false, "status");
      assert.equal(empty.seeded, false);
      assert.equal(empty.refreshedTrips, 0);
      assert.equal(empty.refreshedOrders, 0);
      assert.equal(empty.sites, 0);
      assert.equal(empty.users, 0);
      assert.equal(empty.actor, true);
      assert.equal(empty.migrations.length, 8);
      assert.ok(empty.migrations.includes("008_copilot_actor.sql"));

      const demo = probe(dir, true, "status");
      assert.equal(demo.seeded, true);
      assert.ok(demo.sites > 0);
      assert.equal(demo.users, 11);

      const stamped = probe(dir, false, "stamp");
      assert.equal(stamped.job?.status, "processing");
      assert.equal(stamped.job?.attempts, 2);
      copyFileSync(db, backup);

      const recovered = probe(dir, false, "recover");
      assert.equal(recovered.job?.attempts, 2);
      assert.equal(recovered.job?.status, "done");
      assert.equal(recovered.plannedDeparture, stamped.plannedDeparture);
      assert.equal(recovered.refreshedTrips, 0);

      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${db}${suffix}`;
        if (existsSync(sidecar)) unlinkSync(sidecar);
      }
      copyFileSync(backup, db);
      const restored = probe(dir, false, "status");
      assert.equal(restored.sites, stamped.sites);
      assert.equal(restored.job?.status, "processing");
      assert.equal(restored.job?.attempts, 2);
      assert.equal(restored.plannedDeparture, stamped.plannedDeparture);
      assert.equal(restored.refreshedTrips, 0);
      assert.equal(restored.users, 11);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
