import { EventQuerySchema, EventRecordSchema, type EventRecord } from "@corelogistics/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
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
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": (req.headers.origin as string) ?? "*",
        "X-Accel-Buffering": "no",
      });
      const send = (e: EventRecord) => res.write(`id: ${e.id}\nevent: event\ndata: ${JSON.stringify(e)}\n\n`);
      res.write("retry: 3000\n\n");

      const lastId = Number(req.headers["last-event-id"]);
      if (Number.isFinite(lastId) && lastId > 0) {
        for (const e of listEvents({ afterId: lastId, siteId, limit: 200 }).reverse()) send(e);
      }

      const off = subscribe((e) => {
        if (wanted(e)) send(e);
      });
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.raw.on("close", () => {
        clearInterval(ping);
        off();
      });
    },
  );
}
