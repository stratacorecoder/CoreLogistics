import { z } from "zod";
import { IdSchema, IsoDateSchema } from "./common.js";
import { HandlingUnitSchema } from "./warehouse.js";

export const ORDER_STATUSES = [
  "open",
  "picking",
  "picked",
  "staged",
  "loaded",
  "shipped",
  "cancelled",
] as const;
export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OrderLineSchema = z.object({
  id: IdSchema,
  skuId: IdSchema,
  skuCode: z.string(),
  skuName: z.string(),
  qty: z.number().int(),
  pickedQty: z.number().int(),
});
export type OrderLine = z.infer<typeof OrderLineSchema>;

export const OrderSchema = z.object({
  id: IdSchema,
  code: z.string(),
  siteId: IdSchema,
  customerSiteId: IdSchema,
  status: OrderStatusSchema,
  dueAt: z.string(),
  createdAt: z.string(),
  shipmentId: IdSchema.nullable(),
  lines: z.array(OrderLineSchema),
  huCount: z.number().int(),
});
export type Order = z.infer<typeof OrderSchema>;

export const OrderInputSchema = z.object({
  siteId: IdSchema,
  customerSiteId: IdSchema,
  dueAt: IsoDateSchema,
  lines: z.array(z.object({ skuId: IdSchema, qty: z.number().int().positive() })).min(1),
});
export type OrderInput = z.input<typeof OrderInputSchema>;

export const OrderQuerySchema = z.object({
  siteId: IdSchema.optional(),
  status: z.string().optional().describe("Comma separated statuses"),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const PICK_STATUSES = ["open", "done", "cancelled"] as const;
export const PickStatusSchema = z.enum(PICK_STATUSES);

export const PickTaskSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  orderId: IdSchema,
  orderCode: z.string(),
  orderLineId: IdSchema,
  skuId: IdSchema,
  skuCode: z.string(),
  skuName: z.string(),
  fromLocationId: IdSchema,
  fromLocationCode: z.string(),
  fromHuId: IdSchema,
  fromHuCode: z.string(),
  qty: z.number().int(),
  status: PickStatusSchema,
  toHuId: IdSchema.nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  actor: z.string().nullable(),
});
export type PickTask = z.infer<typeof PickTaskSchema>;

export const ShortageSchema = z.object({
  skuId: IdSchema,
  skuCode: z.string(),
  missing: z.number().int(),
});

export const ReleaseResultSchema = z.object({
  order: OrderSchema,
  tasks: z.array(PickTaskSchema),
  shortages: z.array(ShortageSchema),
});
export type ReleaseResult = z.infer<typeof ReleaseResultSchema>;

export const PickConfirmResultSchema = z.object({
  task: PickTaskSchema,
  hu: HandlingUnitSchema,
  order: OrderSchema,
});

export const StageInputSchema = z.object({
  locationId: IdSchema.optional().describe("Staging location; first free one if omitted"),
});

export const SHIPMENT_STATUSES = ["planning", "loading", "loaded", "departed"] as const;
export const ShipmentStatusSchema = z.enum(SHIPMENT_STATUSES);
export type ShipmentStatus = z.infer<typeof ShipmentStatusSchema>;

export const ShipmentSchema = z.object({
  id: IdSchema,
  code: z.string(),
  siteId: IdSchema,
  tripId: IdSchema.nullable(),
  tripCode: z.string().nullable(),
  vehicleId: IdSchema.nullable(),
  status: ShipmentStatusSchema,
  dockLocationId: IdSchema.nullable(),
  dockCode: z.string().nullable(),
  createdAt: z.string(),
  departedAt: z.string().nullable(),
  orderIds: z.array(IdSchema),
  huTotal: z.number().int(),
  huLoaded: z.number().int(),
  loadedWeightKg: z.number(),
  loadedVolumeM3: z.number(),
  capacityKg: z.number().nullable(),
  capacityM3: z.number().nullable(),
});
export type Shipment = z.infer<typeof ShipmentSchema>;

export const ShipmentInputSchema = z.object({
  siteId: IdSchema,
  tripId: IdSchema.nullable().optional(),
  orderIds: z.array(IdSchema).min(1),
});
export type ShipmentInput = z.input<typeof ShipmentInputSchema>;

export const ShipmentPatchSchema = z.object({ tripId: IdSchema.nullable() });

export const LoadInputSchema = z.object({
  huIds: z.array(IdSchema).optional().describe("Defaults to every staged HU of the shipment"),
});
