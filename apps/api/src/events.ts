import type { EventRecord, EventSource, EventType } from "@corelogistics/contracts";
import type { FastifyRequest } from "fastify";
import { afterCommit, many, nowIso, one, run, type Row } from "./db.js";
import { sessionUser, tokenOf } from "./modules/auth/service.js";

/** Who/what caused a state change. Every service call carries one. */
export interface Ctx {
  source: EventSource;
  actor: string | null;
  occurredAt?: string;
}

export const systemCtx: Ctx = { source: "system", actor: null };

export function ctxOf(req: FastifyRequest): Ctx {
  const signed = sessionUser(tokenOf(req));
  if (signed) return { source: "manual", actor: signed.name };
  const actor = req.headers["x-actor"];
  return {
    source: "manual",
    actor: typeof actor === "string" && actor.trim() ? decodeURIComponent(actor.trim()).slice(0, 64) : null,
  };
}

export function at(ctx: Ctx): string {
  return ctx.occurredAt ?? nowIso();
}

export interface EmitInput {
  type: EventType;
  message: string;
  siteId?: string | null;
  vehicleId?: string | null;
  tripId?: string | null;
  driverId?: string | null;
  locationId?: string | null;
  huId?: string | null;
  entityId?: string | null;
  payload?: Record<string, unknown>;
}

type Listener = (event: EventRecord) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function toEvent(r: Row): EventRecord {
  return {
    id: Number(r.id),
    type: r.type,
    source: r.source,
    actor: r.actor ?? null,
    siteId: r.site_id ?? null,
    vehicleId: r.vehicle_id ?? null,
    tripId: r.trip_id ?? null,
    driverId: r.driver_id ?? null,
    locationId: r.location_id ?? null,
    huId: r.hu_id ?? null,
    entityId: r.entity_id ?? null,
    message: r.message,
    payload: JSON.parse(r.payload || "{}"),
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
  };
}

/** Appends to the event log and broadcasts to SSE listeners after commit. */
export function emit(ctx: Ctx, e: EmitInput): EventRecord {
  const recordedAt = nowIso();
  const result = run(
    `INSERT INTO events (type, source, actor, site_id, vehicle_id, trip_id, driver_id, location_id, hu_id, entity_id, message, payload, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      e.type,
      ctx.source,
      ctx.actor,
      e.siteId ?? null,
      e.vehicleId ?? null,
      e.tripId ?? null,
      e.driverId ?? null,
      e.locationId ?? null,
      e.huId ?? null,
      e.entityId ?? null,
      e.message,
      JSON.stringify(e.payload ?? {}),
      ctx.occurredAt ?? recordedAt,
      recordedAt,
    ],
  );
  const record = toEvent(one("SELECT * FROM events WHERE id = ?", [Number(result.lastInsertRowid)])!);
  afterCommit(() => {
    for (const fn of listeners) {
      try {
        fn(record);
      } catch {
        // a broken SSE socket must not break the write path
      }
    }
  });
  return record;
}

export interface EventFilter {
  siteId?: string;
  vehicleId?: string;
  tripId?: string;
  driverId?: string;
  huId?: string;
  type?: string;
  afterId?: number;
  limit: number;
}

export function listEvents(f: EventFilter): EventRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  const eq = (col: string, v: unknown) => {
    if (v === undefined) return;
    where.push(`${col} = ?`);
    params.push(v);
  };
  eq("site_id", f.siteId);
  eq("vehicle_id", f.vehicleId);
  eq("trip_id", f.tripId);
  eq("driver_id", f.driverId);
  eq("hu_id", f.huId);
  if (f.type) {
    if (f.type.endsWith(".")) {
      where.push("type LIKE ?");
      params.push(`${f.type}%`);
    } else eq("type", f.type);
  }
  if (f.afterId !== undefined) {
    where.push("id > ?");
    params.push(f.afterId);
  }
  // Replays follow insertion order; history views follow when things happened (seeded and device events can be backdated).
  const order = f.afterId !== undefined ? "id DESC" : "occurred_at DESC, id DESC";
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ?`;
  return many(sql, [...params, f.limit]).map(toEvent);
}
