import {
  CopilotConfigSchema,
  CopilotRecommendationSchema,
} from "@corelogistics/contracts";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ctxOf } from "../../events.js";
import {
  applyRecommendation,
  dismissRecommendation,
  getAutoPilotConfig,
  getRecommendation,
  listRecommendations,
  setAutoPilotConfig,
} from "./service.js";

export const copilotRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/copilot/recommendations",
    {
      schema: {
        tags: ["copilot"],
        summary: "List copilot recommendations",
        querystring: z.object({
          siteId: z.string().optional(),
          status: z.string().optional(),
          limit: z.coerce.number().int().positive().max(200).default(50),
        }),
        response: { 200: z.array(CopilotRecommendationSchema) },
      },
    },
    async (req) => listRecommendations(req.query),
  );

  app.get(
    "/copilot/recommendations/:id",
    {
      schema: {
        tags: ["copilot"],
        summary: "Get copilot recommendation by id",
        params: z.object({ id: z.string() }),
        response: { 200: CopilotRecommendationSchema },
      },
    },
    async (req) => getRecommendation(req.params.id),
  );

  app.post(
    "/copilot/recommendations/:id/apply",
    {
      schema: {
        tags: ["copilot"],
        summary: "Apply copilot recommendation",
        params: z.object({ id: z.string() }),
        response: { 200: CopilotRecommendationSchema },
      },
    },
    async (req) => applyRecommendation(req.params.id, ctxOf(req)),
  );

  app.post(
    "/copilot/recommendations/:id/dismiss",
    {
      schema: {
        tags: ["copilot"],
        summary: "Dismiss copilot recommendation",
        params: z.object({ id: z.string() }),
        response: { 200: CopilotRecommendationSchema },
      },
    },
    async (req) => dismissRecommendation(req.params.id, ctxOf(req)),
  );

  app.get(
    "/copilot/config",
    {
      schema: {
        tags: ["copilot"],
        summary: "Get copilot configuration",
        response: { 200: CopilotConfigSchema },
      },
    },
    async () => ({ autoPilot: getAutoPilotConfig() }),
  );

  app.post(
    "/copilot/config",
    {
      schema: {
        tags: ["copilot"],
        summary: "Update copilot configuration",
        body: CopilotConfigSchema,
        response: { 200: CopilotConfigSchema },
      },
    },
    async (req) => ({ autoPilot: setAutoPilotConfig(req.body.autoPilot) }),
  );
};
