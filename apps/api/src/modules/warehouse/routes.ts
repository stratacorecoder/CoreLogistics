import {
  HandlingUnitSchema,
  HuQuerySchema,
  IdParamsSchema,
  InventoryRowSchema,
  OkSchema,
  PutawayConfirmInputSchema,
  PutawayTaskSchema,
  ReceiptInputSchema,
  ReceiptSchema,
  ReceiveInputSchema,
  SiteQuerySchema,
  SkuInputSchema,
  SkuSchema,
  SortResultSchema,
  SortRuleInputSchema,
  SortRuleSchema,
} from "@corelogistics/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ctxOf } from "../../events.js";
import {
  closeReceipt,
  confirmPutaway,
  createReceipt,
  createRule,
  createSku,
  deleteRule,
  findHuByCode,
  getHu,
  getPutaway,
  getReceipt,
  getSku,
  listHus,
  listInventory,
  listPutaway,
  listReceipts,
  listRules,
  listSkus,
  receive,
  setRuleActive,
  sortHu,
} from "./service.js";

export default async function warehouseRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ["warehouse"];

  r.get("/skus", { schema: { tags, response: { 200: z.array(SkuSchema) } } }, async () => listSkus());
  r.post("/skus", { schema: { tags, body: SkuInputSchema, response: { 200: SkuSchema } } }, async (req) =>
    createSku(req.body),
  );
  r.get("/skus/:id", { schema: { tags, params: IdParamsSchema, response: { 200: SkuSchema } } }, async (req) =>
    getSku(req.params.id),
  );

  r.get(
    "/warehouse/inventory",
    {
      schema: {
        tags,
        querystring: SiteQuerySchema.extend({ skuId: z.string().optional() }),
        response: { 200: z.array(InventoryRowSchema) },
      },
    },
    async (req) => listInventory(req.query.siteId, req.query.skuId),
  );

  r.get(
    "/warehouse/hus",
    { schema: { tags, querystring: HuQuerySchema, response: { 200: z.array(HandlingUnitSchema) } } },
    async (req) => listHus(req.query),
  );
  r.get(
    "/warehouse/hus/:id",
    { schema: { tags, summary: "Look up a handling unit by id or barcode", params: IdParamsSchema, response: { 200: HandlingUnitSchema } } },
    async (req) => getHu(req.params.id),
  );
  r.get(
    "/warehouse/scan/:code",
    { schema: { tags, params: z.object({ code: z.string() }), response: { 200: HandlingUnitSchema } } },
    async (req) => findHuByCode(req.params.code),
  );

  r.get(
    "/warehouse/receipts",
    {
      schema: {
        tags,
        querystring: SiteQuerySchema.extend({ status: z.enum(["open", "closed"]).optional() }),
        response: { 200: z.array(ReceiptSchema) },
      },
    },
    async (req) => listReceipts(req.query.siteId, req.query.status),
  );
  r.post(
    "/warehouse/receipts",
    { schema: { tags, body: ReceiptInputSchema, response: { 200: ReceiptSchema } } },
    async (req) => createReceipt(req.body, ctxOf(req)),
  );
  r.get(
    "/warehouse/receipts/:id",
    { schema: { tags, params: IdParamsSchema, response: { 200: ReceiptSchema } } },
    async (req) => getReceipt(req.params.id),
  );
  r.post(
    "/warehouse/receipts/:id/receive",
    {
      schema: {
        tags,
        summary: "Receive one handling unit against a receipt",
        params: IdParamsSchema,
        body: ReceiveInputSchema,
        response: { 200: HandlingUnitSchema },
      },
    },
    async (req) => receive(req.params.id, req.body, ctxOf(req)),
  );
  r.post(
    "/warehouse/receipts/:id/close",
    { schema: { tags, params: IdParamsSchema, response: { 200: ReceiptSchema } } },
    async (req) => closeReceipt(req.params.id, ctxOf(req)),
  );

  r.get(
    "/warehouse/sort-rules",
    { schema: { tags, querystring: SiteQuerySchema, response: { 200: z.array(SortRuleSchema) } } },
    async (req) => listRules(req.query.siteId),
  );
  r.post(
    "/warehouse/sort-rules",
    { schema: { tags, body: SortRuleInputSchema, response: { 200: SortRuleSchema } } },
    async (req) => createRule(req.body),
  );
  r.patch(
    "/warehouse/sort-rules/:id",
    { schema: { tags, params: IdParamsSchema, body: z.object({ active: z.boolean() }), response: { 200: SortRuleSchema } } },
    async (req) => setRuleActive(req.params.id, req.body.active),
  );
  r.delete(
    "/warehouse/sort-rules/:id",
    { schema: { tags, params: IdParamsSchema, response: { 200: OkSchema } } },
    async (req) => deleteRule(req.params.id),
  );
  r.post(
    "/warehouse/hus/:id/sort",
    {
      schema: {
        tags,
        summary: "Run the sort engine on a received unit and create its putaway task",
        params: IdParamsSchema,
        response: { 200: SortResultSchema },
      },
    },
    async (req) => sortHu(req.params.id, ctxOf(req)),
  );

  r.get(
    "/warehouse/putaway",
    {
      schema: {
        tags,
        querystring: SiteQuerySchema.extend({ status: z.enum(["open", "done", "cancelled"]).optional() }),
        response: { 200: z.array(PutawayTaskSchema) },
      },
    },
    async (req) => listPutaway(req.query.siteId, req.query.status),
  );
  r.get(
    "/warehouse/putaway/:id",
    { schema: { tags, params: IdParamsSchema, response: { 200: PutawayTaskSchema } } },
    async (req) => getPutaway(req.params.id),
  );
  r.post(
    "/warehouse/putaway/:id/confirm",
    {
      schema: { tags, params: IdParamsSchema, body: PutawayConfirmInputSchema, response: { 200: PutawayTaskSchema } },
    },
    async (req) => confirmPutaway(req.params.id, req.body.locationId, ctxOf(req)),
  );
}
