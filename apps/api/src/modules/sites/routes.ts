import {
  IdParamsSchema,
  LocationKindSchema,
  LocationSchema,
  SiteBoardSchema,
  SiteInputSchema,
  SiteLayoutSchema,
  SiteSchema,
  ZONE_META,
  ZONES,
} from "@corelogistics/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ctxOf } from "../../events.js";
import {
  createSite,
  getBoard,
  getLayout,
  getSite,
  listLocations,
  listSites,
  saveLayout,
  updateSite,
} from "./service.js";

const tags = ["sites"];

export default async function siteRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/zones",
    {
      schema: {
        tags,
        summary: "Storage zones",
        response: {
          200: z.array(z.object({ code: z.string(), label: z.string(), color: z.string(), description: z.string() })),
        },
      },
    },
    async () => ZONES.map((code) => ({ code, ...ZONE_META[code] })),
  );

  r.get("/sites", { schema: { tags, response: { 200: z.array(SiteSchema) } } }, async () => listSites());

  r.post("/sites", { schema: { tags, body: SiteInputSchema, response: { 200: SiteSchema } } }, async (req) =>
    createSite(req.body, ctxOf(req)),
  );

  r.get("/sites/:id", { schema: { tags, params: IdParamsSchema, response: { 200: SiteSchema } } }, async (req) =>
    getSite(req.params.id),
  );

  r.patch(
    "/sites/:id",
    { schema: { tags, params: IdParamsSchema, body: SiteInputSchema.partial(), response: { 200: SiteSchema } } },
    async (req) => updateSite(req.params.id, req.body),
  );

  r.get(
    "/sites/:id/layout",
    { schema: { tags, params: IdParamsSchema, response: { 200: SiteLayoutSchema } } },
    async (req) => getLayout(req.params.id),
  );

  r.put(
    "/sites/:id/layout",
    {
      schema: {
        tags,
        summary: "Save the grid layout and re-derive locations",
        params: IdParamsSchema,
        body: SiteLayoutSchema,
        response: { 200: SiteLayoutSchema },
      },
    },
    async (req) => saveLayout(req.params.id, req.body, ctxOf(req)),
  );

  r.get(
    "/sites/:id/locations",
    {
      schema: {
        tags,
        params: IdParamsSchema,
        querystring: z.object({ kind: LocationKindSchema.optional() }),
        response: { 200: z.array(LocationSchema) },
      },
    },
    async (req) => listLocations(req.params.id, req.query.kind),
  );

  r.get(
    "/sites/:id/board",
    {
      schema: {
        tags,
        summary: "Layout plus live occupancy of every location",
        params: IdParamsSchema,
        response: { 200: SiteBoardSchema },
      },
    },
    async (req) => getBoard(req.params.id),
  );
}
