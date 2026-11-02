import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { customAlphabet } from "nanoid";

const here = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = process.env.CORELOGISTICS_DATA_DIR ?? path.resolve(here, "../data");
const dbEnv = process.env.CORELOGISTICS_DB ?? "corelogistics.db";
export const isMemory = dbEnv === ":memory:";
export const dbFile = isMemory ? ":memory:" : path.isAbsolute(dbEnv) ? dbEnv : path.join(dataDir, dbEnv);
if (!isMemory) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
}

export const sqlite = new DatabaseSync(dbFile);
if (!isMemory) {
  sqlite.exec("PRAGMA journal_mode = WAL");
}
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.exec("PRAGMA busy_timeout = 3000");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

function bind(params: unknown[]): SQLInputValue[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p as SQLInputValue;
  });
}

export function one<T = Row>(sql: string, params: unknown[] = []): T | undefined {
  return sqlite.prepare(sql).get(...bind(params)) as T | undefined;
}

export function many<T = Row>(sql: string, params: unknown[] = []): T[] {
  return sqlite.prepare(sql).all(...bind(params)) as T[];
}

export function run(sql: string, params: unknown[] = []) {
  return sqlite.prepare(sql).run(...bind(params));
}

export function scalar<T = number>(sql: string, params: unknown[] = []): T {
  const row = one<Row>(sql, params);
  return (row ? Object.values(row)[0] : null) as T;
}

let depth = 0;
let pending: Array<() => void> = [];

/** Runs `fn` in a transaction. Nested calls join the outer transaction. */
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  depth++;
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    sqlite.exec("COMMIT");
    const queued = pending;
    pending = [];
    depth--;
    for (const cb of queued) cb();
    return result;
  } catch (err) {
    sqlite.exec("ROLLBACK");
    pending = [];
    depth--;
    throw err;
  }
}

/** Defers `fn` until the current transaction commits (or runs it now). */
export function afterCommit(fn: () => void) {
  if (depth > 0) pending.push(fn);
  else fn();
}

const nano = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);
export function newId(prefix: string): string {
  return `${prefix}_${nano()}`;
}

export function nextCode(name: string, prefix: string, pad = 4, start = 1000): string {
  run(
    `INSERT INTO sequences (name, value) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET value = value + 1`,
    [name, start + 1],
  );
  const value = scalar<number>("SELECT value FROM sequences WHERE name = ?", [name]);
  return `${prefix}-${String(value).padStart(pad, "0")}`;
}

export const nowIso = () => new Date().toISOString();

export const toBool = (v: unknown) => v === 1 || v === true || v === 1n;

export function placeholders(n: number) {
  return Array.from({ length: n }, () => "?").join(", ");
}

export function splitList(value: string | undefined): string[] {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}
