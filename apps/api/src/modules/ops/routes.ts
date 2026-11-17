import {
  NudgeAckInputSchema,
  NudgeInputSchema,
  NudgeQuerySchema,
  OpsNudgeSchema,
  type OpsNudge,
} from "@corelogistics/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { one } from "../../db.js";
import { notFound } from "../../errors.js";
import { ctxOf, emit, listEvents } from "../../events.js";

function toNudge(
  event: ReturnType<typeof listEvents>[number],
  acksByNudgeId: Map<number, ReturnType<typeof listEvents>[number]>,
): OpsNudge {
  const payload = event.payload ?? {};
  const ack = acksByNudgeId.get(event.id);
  const ackPayload = ack?.payload ?? {};
  return {
    id: event.id,
    targetRole: (payload.targetRole as OpsNudge["targetRole"]) ?? "warehouse",
    siteId: event.siteId,
    driverId: event.driverId,
    tripId: event.tripId,
    locationCode: typeof payload.locationCode === "string" ? payload.locationCode : null,
    priority: payload.priority === "urgent" ? "urgent" : "normal",
    message: typeof payload.note === "string" ? payload.note : event.message,
    sender: event.actor,
    createdAt: event.occurredAt,
    ackedAt: ack ? ack.occurredAt : null,
    ackedBy: ack ? ack.actor : null,
    ackNote: ack && typeof ackPayload.note === "string" && ackPayload.note ? ackPayload.note : null,
    ackPhoto: ack && typeof ackPayload.proofPhoto === "string" ? ackPayload.proofPhoto : null,
  };
}

export default async function opsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/ops/nudges",
    {
      schema: {
        tags: ["events"],
        summary: "List Tower-to-Floor/Driver priority nudges",
        querystring: NudgeQuerySchema,
        response: { 200: z.array(OpsNudgeSchema) },
      },
    },
    async (req) => {
      const { targetRole, siteId, driverId, openOnly, limit } = req.query;
      const nudges = listEvents({ siteId, driverId, type: "ops.nudge", limit: Math.min(300, limit * 3) });
      const acks = listEvents({ type: "ops.nudge_ack", limit: 300 });
      const ackMap = new Map<number, (typeof acks)[number]>();
      for (const ack of acks) {
        const nid = Number(ack.payload?.nudgeEventId);
        if (Number.isFinite(nid) && !ackMap.has(nid)) ackMap.set(nid, ack);
      }
      return nudges
        .map((e) => toNudge(e, ackMap))
        .filter((n) => (!targetRole || n.targetRole === targetRole) && (openOnly !== "true" || !n.ackedAt))
        .slice(0, limit);
    },
  );

  r.post(
    "/ops/nudges",
    {
      schema: {
        tags: ["events"],
        summary: "Send a live priority nudge from Control Tower to floor or driver",
        body: NudgeInputSchema,
        response: { 200: OpsNudgeSchema },
      },
    },
    async (req) => {
      const input = req.body;
      const prefix = input.priority === "urgent" ? "[URGENT NUDGE]" : "[Nudge]";
      const target = input.locationCode ? `${input.targetRole} @ ${input.locationCode}` : input.targetRole;
      const event = emit(ctxOf(req), {
        type: "ops.nudge",
        siteId: input.siteId ?? null,
        driverId: input.driverId ?? null,
        tripId: input.tripId ?? null,
        message: `${prefix} (${target}): ${input.message}`,
        payload: {
          targetRole: input.targetRole,
          locationCode: input.locationCode ?? null,
          priority: input.priority,
          note: input.message,
        },
      });
      return toNudge(event, new Map());
    },
  );

  r.post(
    "/ops/nudges/:id/ack",
    {
      schema: {
        tags: ["events"],
        summary: "Acknowledge a priority nudge with optional note or photo proof",
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: NudgeAckInputSchema,
        response: { 200: OpsNudgeSchema },
      },
    },
    async (req) => {
      const nudgeRow = one<{
        id: number;
        site_id: string | null;
        driver_id: string | null;
        trip_id: string | null;
        payload: string;
        actor: string | null;
        occurred_at: string;
        message: string;
      }>("SELECT * FROM events WHERE id = ? AND type = 'ops.nudge'", [req.params.id]);
      if (!nudgeRow) throw notFound("Nudge");
      const origPayload = JSON.parse(nudgeRow.payload || "{}") as Record<string, unknown>;
      const ackEvent = emit(ctxOf(req), {
        type: "ops.nudge_ack",
        siteId: nudgeRow.site_id,
        driverId: nudgeRow.driver_id,
        tripId: nudgeRow.trip_id,
        message: `Nudge #${nudgeRow.id} acknowledged${req.body.note ? `: ${req.body.note}` : ""}`,
        payload: {
          nudgeEventId: nudgeRow.id,
          targetRole: origPayload.targetRole ?? "warehouse",
          note: req.body.note ?? "",
          proofPhoto: req.body.proofPhoto ?? null,
        },
      });
      return {
        id: Number(nudgeRow.id),
        targetRole: (origPayload.targetRole as OpsNudge["targetRole"]) ?? "warehouse",
        siteId: nudgeRow.site_id,
        driverId: nudgeRow.driver_id,
        tripId: nudgeRow.trip_id,
        locationCode: typeof origPayload.locationCode === "string" ? origPayload.locationCode : null,
        priority: (origPayload.priority === "urgent" ? "urgent" : "normal") as OpsNudge["priority"],
        message: typeof origPayload.note === "string" ? origPayload.note : nudgeRow.message,
        sender: nudgeRow.actor,
        createdAt: nudgeRow.occurred_at,
        ackedAt: ackEvent.occurredAt,
        ackedBy: ackEvent.actor,
        ackNote: req.body.note ?? null,
        ackPhoto: req.body.proofPhoto ?? null,
      };
    },
  );
}
