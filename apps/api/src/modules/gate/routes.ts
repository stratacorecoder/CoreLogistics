import {
  AssignDockInputSchema,
  CheckInInputSchema,
  CheckOutInputSchema,
  DockSuggestionSchema,
  ExpectedTripSchema,
  GateVisitSchema,
  IdParamsSchema,
  MoveYardInputSchema,
  RequiredSiteQuerySchema,
  VisitQuerySchema,
} from "@corelogistics/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ctxOf } from "../../events.js";
import {
  assignDock,
  checkIn,
  checkOut,
  expectedAtSite,
  getVisit,
  listVisits,
  moveInYard,
  releaseDock,
  suggestDock,
} from "./service.js";

export default async function gateRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ["gate"];
  const visit = { response: { 200: GateVisitSchema } };

  r.get(
    "/gate/expected",
    {
      schema: {
        tags,
        summary: "Trips expected at a site's gate",
        querystring: RequiredSiteQuerySchema,
        response: { 200: z.array(ExpectedTripSchema) },
      },
    },
    async (req) => expectedAtSite(req.query.siteId),
  );
  r.get(
    "/gate/visits",
    { schema: { tags, querystring: VisitQuerySchema, response: { 200: z.array(GateVisitSchema) } } },
    async (req) => listVisits(req.query),
  );
  r.get("/gate/visits/:id", { schema: { tags, params: IdParamsSchema, ...visit } }, async (req) =>
    getVisit(req.params.id),
  );
  r.post(
    "/gate/check-in",
    { schema: { tags, summary: "Truck enters the site", body: CheckInInputSchema, ...visit } },
    async (req) => checkIn(req.body, ctxOf(req)),
  );
  r.post(
    "/gate/check-out",
    { schema: { tags, summary: "Truck leaves the site", body: CheckOutInputSchema, ...visit } },
    async (req) => checkOut(req.body, ctxOf(req)),
  );
  r.get(
    "/gate/visits/:id/dock-suggestion",
    { schema: { tags, params: IdParamsSchema, response: { 200: DockSuggestionSchema } } },
    async (req) => suggestDock(req.params.id),
  );
  r.post(
    "/gate/visits/:id/dock",
    { schema: { tags, summary: "Assign (or move to) a dock door", params: IdParamsSchema, body: AssignDockInputSchema, ...visit } },
    async (req) => assignDock(req.params.id, req.body, ctxOf(req)),
  );
  r.post(
    "/gate/visits/:id/dock/release",
    { schema: { tags, params: IdParamsSchema, ...visit } },
    async (req) => releaseDock(req.params.id, ctxOf(req)),
  );
  r.post(
    "/gate/visits/:id/yard",
    { schema: { tags, params: IdParamsSchema, body: MoveYardInputSchema, ...visit } },
    async (req) => moveInYard(req.params.id, req.body.locationId, ctxOf(req)),
  );
}
