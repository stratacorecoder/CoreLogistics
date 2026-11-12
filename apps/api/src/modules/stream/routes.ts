import { EventQuerySchema, EventRecordSchema, type EventRecord } from "@corelogistics/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { originAllowedForRequest } from "../../app.js";
import { listEvents, subscribe } from "../../events.js";

export default async function streamRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/events",
    { schema: { tags: ["events"], summary: "Event log, newest first", querystring: EventQuerySchema, response: { 200: z.array(EventRecordSchema) } } },
    async (req) => listEvents(req.query),
  );

  r.get(
    "/stream",
    {
      schema: {
        tags: ["events"],
        summary: "Server-Sent Events: every new event as `data: <EventRecord JSON>`",
        description: "Optional `siteId` filter (site-less events such as fleet changes are always sent). Supports `Last-Event-ID` replay.",
        querystring: z.object({ siteId: z.string().optional() }),
      },
    },
    async (req, reply) => {
      const { siteId } = req.query;
      const wanted = (e: EventRecord) => !siteId || !e.siteId || e.siteId === siteId;
      reply.hijack();
      const res = reply.raw;
      const rawOrigin = typeof req.headers.origin === "string" ? req.headers.origin.trim() : undefined;
      const origin = rawOrigin && originAllowedForRequest(rawOrigin, req) ? rawOrigin : undefined;
      const headers: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      };
      if (origin) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Access-Control-Allow-Credentials"] = "true";
        headers.Vary = "Origin";
      }
      res.writeHead(200, headers);

      let closed = false;
      let ping: ReturnType<typeof setInterval> | null = null;
      let off: (() => void) | null = null;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (ping) clearInterval(ping);
        off?.();
      };
      const safeWrite = (chunk: string) => {
        if (closed || res.writableEnded || res.destroyed) {
          cleanup();
          return false;
        }
        try {
          res.write(chunk);
          return true;
        } catch {
          cleanup();
          return false;
        }
      };

      const send = (e: EventRecord) => safeWrite(`id: ${e.id}\nevent: event\ndata: ${JSON.stringify(e)}\n\n`);
      safeWrite("retry: 3000\n\n");

      const lastId = Number(req.headers["last-event-id"]);
      if (Number.isFinite(lastId) && lastId > 0) {
        for (const e of listEvents({ afterId: lastId, siteId, limit: 200 }).reverse()) {
          if (!send(e)) return;
        }
      }

      off = subscribe((e) => {
        if (wanted(e)) send(e);
      });
      ping = setInterval(() => {
        safeWrite(": ping\n\n");
      }, 25_000);
      req.raw.on("close", cleanup);
      res.on("close", cleanup);
      res.on("error", cleanup);
    },
  );
}
