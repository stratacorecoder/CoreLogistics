import {
  HandlingUnitSchema,
  IdParamsSchema,
  LoadInputSchema,
  OrderInputSchema,
  OrderQuerySchema,
  OrderSchema,
  PickConfirmResultSchema,
  PickTaskSchema,
  ReleaseResultSchema,
  RequiredSiteQuerySchema,
  ShipmentInputSchema,
  ShipmentPatchSchema,
  ShipmentSchema,
  SiteQuerySchema,
  StageInputSchema,
} from "@corelogistics/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ctxOf } from "../../events.js";
import {
  confirmPick,
  createOrder,
  createShipment,
  departShipment,
  getOrder,
  getPick,
  getShipment,
  listOrders,
  listPicks,
  listShipments,
  listStagedCrossDock,
  loadShipment,
  releaseOrder,
  setShipmentTrip,
  stageOrder,
} from "./service.js";

export default async function outboundRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ["outbound"];

  r.get(
    "/outbound/orders",
    { schema: { tags, querystring: OrderQuerySchema, response: { 200: z.array(OrderSchema) } } },
    async (req) => listOrders(req.query),
  );
  r.post("/outbound/orders", { schema: { tags, body: OrderInputSchema, response: { 200: OrderSchema } } }, async (req) =>
    createOrder(req.body, ctxOf(req)),
  );
  r.get(
    "/outbound/orders/:id",
    { schema: { tags, params: IdParamsSchema, response: { 200: OrderSchema } } },
    async (req) => getOrder(req.params.id),
  );
  r.post(
    "/outbound/orders/:id/release",
    {
      schema: {
        tags,
        summary: "Allocate stock FIFO and create pick tasks",
        params: IdParamsSchema,
        response: { 200: ReleaseResultSchema },
      },
    },
    async (req) => releaseOrder(req.params.id, ctxOf(req)),
  );
  r.post(
    "/outbound/orders/:id/stage",
    { schema: { tags, params: IdParamsSchema, body: StageInputSchema, response: { 200: OrderSchema } } },
    async (req) => stageOrder(req.params.id, req.body.locationId, ctxOf(req)),
  );

  r.get(
    "/outbound/picks",
    {
      schema: {
        tags,
        querystring: SiteQuerySchema.extend({
          status: z.enum(["open", "done", "cancelled"]).optional(),
          orderId: z.string().optional(),
        }),
        response: { 200: z.array(PickTaskSchema) },
      },
    },
    async (req) => listPicks(req.query.siteId, req.query.status, req.query.orderId),
  );
  r.get(
    "/outbound/picks/:id",
    { schema: { tags, params: IdParamsSchema, response: { 200: PickTaskSchema } } },
    async (req) => getPick(req.params.id),
  );
  r.post(
    "/outbound/picks/:id/confirm",
    { schema: { tags, params: IdParamsSchema, response: { 200: PickConfirmResultSchema } } },
    async (req) => confirmPick(req.params.id, ctxOf(req)),
  );

  r.get(
    "/outbound/cross-dock",
    {
      schema: {
        tags,
        summary: "Cross-dock units staged and waiting for a truck",
        querystring: RequiredSiteQuerySchema,
        response: { 200: z.array(HandlingUnitSchema) },
      },
    },
    async (req) => listStagedCrossDock(req.query.siteId),
  );

  r.get(
    "/outbound/shipments",
    {
      schema: {
        tags,
        querystring: SiteQuerySchema.extend({ status: z.string().optional() }),
        response: { 200: z.array(ShipmentSchema) },
      },
    },
    async (req) => listShipments(req.query.siteId, req.query.status),
  );
  r.post(
    "/outbound/shipments",
    { schema: { tags, body: ShipmentInputSchema, response: { 200: ShipmentSchema } } },
    async (req) => createShipment(req.body, ctxOf(req)),
  );
  r.get(
    "/outbound/shipments/:id",
    { schema: { tags, params: IdParamsSchema, response: { 200: ShipmentSchema } } },
    async (req) => getShipment(req.params.id),
  );
  r.patch(
    "/outbound/shipments/:id",
    { schema: { tags, params: IdParamsSchema, body: ShipmentPatchSchema, response: { 200: ShipmentSchema } } },
    async (req) => setShipmentTrip(req.params.id, req.body.tripId),
  );
  r.post(
    "/outbound/shipments/:id/load",
    {
      schema: {
        tags,
        summary: "Load staged units onto the docked truck (capacity checked)",
        params: IdParamsSchema,
        body: LoadInputSchema,
        response: { 200: ShipmentSchema },
      },
    },
    async (req) => loadShipment(req.params.id, req.body.huIds, ctxOf(req)),
  );
  r.post(
    "/outbound/shipments/:id/depart",
    {
      schema: {
        tags,
        summary: "Close the shipment and hand off to the trip",
        params: IdParamsSchema,
        response: { 200: ShipmentSchema },
      },
    },
    async (req) => departShipment(req.params.id, ctxOf(req)),
  );
}
