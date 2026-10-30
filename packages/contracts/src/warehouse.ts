import { z } from "zod";
import { IdSchema, ZoneSchema } from "./common.js";

export const SkuSchema = z.object({
  id: IdSchema,
  code: z.string(),
  name: z.string(),
  category: z.string(),
  zone: ZoneSchema,
  unitWeightKg: z.number(),
  unitVolumeM3: z.number(),
});
export type Sku = z.infer<typeof SkuSchema>;

export const SkuInputSchema = z.object({
  code: z.string().min(1).max(24),
  name: z.string().min(1),
  category: z.string().min(1),
  zone: ZoneSchema,
  unitWeightKg: z.number().nonnegative(),
  unitVolumeM3: z.number().nonnegative(),
});
export type SkuInput = z.input<typeof SkuInputSchema>;

export const HU_KINDS = ["pallet", "parcel", "tote"] as const;
export const HuKindSchema = z.enum(HU_KINDS);
export type HuKind = z.infer<typeof HuKindSchema>;

export const HU_STATUSES = [
  "received",
  "sorted",
  "stored",
  "picked",
  "staged",
  "loaded",
  "shipped",
  "consumed",
] as const;
export const HuStatusSchema = z.enum(HU_STATUSES);
export type HuStatus = z.infer<typeof HuStatusSchema>;

export const HandlingUnitSchema = z.object({
  id: IdSchema,
  code: z.string(),
  kind: HuKindSchema,
  siteId: IdSchema,
  skuId: IdSchema,
  skuCode: z.string(),
  skuName: z.string(),
  zone: ZoneSchema,
  qty: z.number().int(),
  status: HuStatusSchema,
  locationId: IdSchema.nullable(),
  locationCode: z.string().nullable(),
  sortLaneId: IdSchema.nullable(),
  sortLaneCode: z.string().nullable(),
  destinationSiteId: IdSchema.nullable(),
  receiptId: IdSchema.nullable(),
  orderId: IdSchema.nullable(),
  shipmentId: IdSchema.nullable(),
  weightKg: z.number(),
  volumeM3: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HandlingUnit = z.infer<typeof HandlingUnitSchema>;

export const HuQuerySchema = z.object({
  siteId: IdSchema.optional(),
  status: z.string().optional().describe("Comma separated statuses"),
  receiptId: IdSchema.optional(),
  orderId: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});

export const RECEIPT_STATUSES = ["open", "closed"] as const;
export const ReceiptStatusSchema = z.enum(RECEIPT_STATUSES);

export const ReceiptLineSchema = z.object({
  id: IdSchema,
  skuId: IdSchema,
  skuCode: z.string(),
  skuName: z.string(),
  expectedQty: z.number().int(),
  receivedQty: z.number().int(),
});
export type ReceiptLine = z.infer<typeof ReceiptLineSchema>;

export const ReceiptSchema = z.object({
  id: IdSchema,
  code: z.string(),
  siteId: IdSchema,
  tripId: IdSchema.nullable(),
  visitId: IdSchema.nullable(),
  supplier: z.string(),
  status: ReceiptStatusSchema,
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  lines: z.array(ReceiptLineSchema),
  huCount: z.number().int(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export const ReceiptInputSchema = z.object({
  siteId: IdSchema,
  tripId: IdSchema.nullable().optional(),
  visitId: IdSchema.nullable().optional(),
  supplier: z.string().default(""),
  lines: z
    .array(z.object({ skuId: IdSchema, expectedQty: z.number().int().positive() }))
    .default([]),
});
export type ReceiptInput = z.input<typeof ReceiptInputSchema>;

export const ReceiveInputSchema = z.object({
  skuId: IdSchema,
  qty: z.number().int().positive(),
  kind: HuKindSchema.default("pallet"),
  code: z.string().min(3).max(32).optional().describe("Scanned barcode; generated if omitted"),
  destinationSiteId: IdSchema.nullable().optional().describe("Set for cross-dock freight"),
});
export type ReceiveInput = z.input<typeof ReceiveInputSchema>;

export const SORT_MATCH_KINDS = ["destination", "sku", "category", "zone"] as const;
export const SortMatchKindSchema = z.enum(SORT_MATCH_KINDS);
export type SortMatchKind = z.infer<typeof SortMatchKindSchema>;

export const SortRuleSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  priority: z.number().int(),
  matchKind: SortMatchKindSchema,
  matchValue: z.string(),
  sortLaneId: IdSchema,
  sortLaneCode: z.string(),
  active: z.boolean(),
});
export type SortRule = z.infer<typeof SortRuleSchema>;

export const SortRuleInputSchema = z.object({
  siteId: IdSchema,
  priority: z.number().int().default(100),
  matchKind: SortMatchKindSchema,
  matchValue: z.string().min(1),
  sortLaneId: IdSchema,
  active: z.boolean().default(true),
});
export type SortRuleInput = z.input<typeof SortRuleInputSchema>;

export const PUTAWAY_STATUSES = ["open", "done", "cancelled"] as const;
export const PutawayStatusSchema = z.enum(PUTAWAY_STATUSES);

export const PutawayTaskSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  huId: IdSchema,
  huCode: z.string(),
  skuCode: z.string(),
  skuName: z.string(),
  qty: z.number().int(),
  zone: ZoneSchema,
  fromLocationId: IdSchema.nullable(),
  fromCode: z.string().nullable(),
  suggestedLocationId: IdSchema.nullable(),
  suggestedCode: z.string().nullable(),
  confirmedLocationId: IdSchema.nullable(),
  confirmedCode: z.string().nullable(),
  status: PutawayStatusSchema,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  actor: z.string().nullable(),
});
export type PutawayTask = z.infer<typeof PutawayTaskSchema>;

export const PutawayConfirmInputSchema = z.object({
  locationId: IdSchema.optional().describe("Override the suggested bin"),
});

export const SortResultSchema = z.object({
  hu: HandlingUnitSchema,
  ruleId: IdSchema.nullable(),
  reason: z.string(),
  putaway: PutawayTaskSchema.nullable(),
});
export type SortResult = z.infer<typeof SortResultSchema>;

export const InventoryRowSchema = z.object({
  siteId: IdSchema,
  locationId: IdSchema,
  locationCode: z.string(),
  zone: ZoneSchema.nullable(),
  skuId: IdSchema,
  skuCode: z.string(),
  skuName: z.string(),
  qty: z.number().int(),
});
export type InventoryRow = z.infer<typeof InventoryRowSchema>;

export const SiteQuerySchema = z.object({ siteId: IdSchema.optional() });
export const RequiredSiteQuerySchema = z.object({ siteId: IdSchema });
