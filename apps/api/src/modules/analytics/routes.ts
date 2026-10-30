import { AnalyticsQuerySchema, AnalyticsSummarySchema } from "@corelogistics/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { summary } from "./service.js";

export default async function analyticsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    "/analytics/summary",
    {
      schema: {
        tags: ["analytics"],
        summary: "Dwell, dock utilization, on-time rates, turnaround, storage capacity and throughput",
        querystring: AnalyticsQuerySchema,
        response: { 200: AnalyticsSummarySchema },
      },
    },
    async (req) => summary(req.query.siteId, req.query.days),
  );
}
