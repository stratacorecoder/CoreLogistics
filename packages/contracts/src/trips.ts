import { z } from "zod";
import { IdSchema, IsoDateSchema } from "./common.js";
import { SiteSchema } from "./sites.js";

export const TRIP_KINDS = ["inbound", "outbound", "transfer"] as const;
export const TripKindSchema = z.enum(TRIP_KINDS);
export type TripKind = z.infer<typeof TripKindSchema>;

export const TRIP_STATUSES = [
  "planned",
  "dispatched",
  "in_transit",
  "arrived",
  "completed",
  "cancelled",
] as const;
export const TripStatusSchema = z.enum(TRIP_STATUSES);
export type TripStatus = z.infer<typeof TripStatusSchema>;

export const ACTIVE_TRIP_STATUSES: TripStatus[] = ["planned", "dispatched", "in_transit", "arrived"];

/** Minutes past plan before a departure or arrival counts as late. */
export const ON_TIME_TOLERANCE_MINUTES = 15;

export const TripStopSchema = z.object({
  id: IdSchema,
  seq: z.number().int(),
  siteId: IdSchema,
  plannedAt: z.string().nullable(),
  arrivedAt: z.string().nullable(),
  departedAt: z.string().nullable(),
});
export type TripStop = z.infer<typeof TripStopSchema>;

export const TripSchema = z.object({
  id: IdSchema,
  code: z.string(),
  kind: TripKindSchema,
  status: TripStatusSchema,
  originSiteId: IdSchema,
  destinationSiteId: IdSchema,
  vehicleId: IdSchema.nullable(),
  trailerId: IdSchema.nullable(),
  driverId: IdSchema.nullable(),
  plannedDeparture: z.string(),
  plannedArrival: z.string(),
  actualDeparture: z.string().nullable(),
  actualArrival: z.string().nullable(),
  completedAt: z.string().nullable(),
  notes: z.string(),
  createdAt: z.string(),
  stops: z.array(TripStopSchema),
  delayed: z.boolean(),
  delayMinutes: z.number().int(),
  etaAt: z.string().nullable(),
  podRecipient: z.string().nullable().optional(),
  podNotes: z.string().optional(),
  podSignature: z.string().nullable().optional(),
  podAt: z.string().nullable().optional(),
});
export type Trip = z.infer<typeof TripSchema>;

export const TripInputSchema = z
  .object({
    kind: TripKindSchema,
    originSiteId: IdSchema,
    destinationSiteId: IdSchema,
    vehicleId: IdSchema.nullable().optional(),
    trailerId: IdSchema.nullable().optional(),
    driverId: IdSchema.nullable().optional(),
    plannedDeparture: IsoDateSchema,
    plannedArrival: IsoDateSchema,
    notes: z.string().default(""),
    stops: z
      .array(z.object({ siteId: IdSchema, plannedAt: IsoDateSchema.nullable().optional() }))
      .default([]),
  })
  .refine((t) => t.originSiteId !== t.destinationSiteId, {
    message: "Origin and destination must differ",
  })
  .refine((t) => Date.parse(t.plannedArrival) > Date.parse(t.plannedDeparture), {
    message: "Planned arrival must be after planned departure",
  });
export type TripInput = z.input<typeof TripInputSchema>;

export const TripPatchSchema = z.object({
  vehicleId: IdSchema.nullable().optional(),
  trailerId: IdSchema.nullable().optional(),
  driverId: IdSchema.nullable().optional(),
  plannedDeparture: IsoDateSchema.optional(),
  plannedArrival: IsoDateSchema.optional(),
  notes: z.string().optional(),
});
export type TripPatch = z.input<typeof TripPatchSchema>;

export const TripQuerySchema = z.object({
  status: z.string().optional().describe("Comma separated statuses"),
  siteId: IdSchema.optional().describe("Matches origin, destination or a stop"),
  driverId: IdSchema.optional(),
  vehicleId: IdSchema.optional(),
  active: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const ISSUE_KINDS = ["delay", "breakdown", "accident", "cargo", "other"] as const;
export const IssueKindSchema = z.enum(ISSUE_KINDS);
export type IssueKind = z.infer<typeof IssueKindSchema>;

const ProofPhotoSchema = z
  .string()
  .trim()
  .max(250_000)
  .refine(
    (val) => !val || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(val),
    { message: "Photo proof must be a valid base64 PNG, JPEG, or WebP data URL" },
  )
  .optional()
  .describe("Optional base64 photo data URL (data:image/...)");

export const TripIssueInputSchema = z.object({
  kind: IssueKindSchema,
  message: z.string().min(1).max(500),
  lat: z.number().optional(),
  lng: z.number().optional(),
  proofPhoto: ProofPhotoSchema,
});
export type TripIssueInput = z.input<typeof TripIssueInputSchema>;

export const TripStopParamsSchema = z.object({ id: IdSchema, stopId: IdSchema });

export const TripCompleteInputSchema = z.object({
  recipient: z.string().trim().min(1).max(120).optional(),
  notes: z.string().max(500).optional(),
  signature: z
    .string()
    .trim()
    .max(150_000)
    .refine(
      (val) => !val || /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(val),
      { message: "Signature must be a valid base64 image data URL" },
    )
    .optional()
    .describe("Base64 image data URL (data:image/...)"),
  proofPhoto: ProofPhotoSchema,
});
export type TripCompleteInput = z.input<typeof TripCompleteInputSchema>;

export const WaybillLineSchema = z.object({
  orderCode: z.string(),
  customerName: z.string(),
  skuCode: z.string(),
  skuName: z.string(),
  qty: z.number().int(),
  pickedQty: z.number().int(),
  unitWeightKg: z.number(),
});

export const WaybillUnitSchema = z.object({
  code: z.string(),
  kind: z.string(),
  skuCode: z.string(),
  skuName: z.string(),
  qty: z.number().int(),
  lotNumber: z.string().nullable(),
  expiryDate: z.string().nullable(),
});

export const WaybillSchema = z.object({
  trip: TripSchema,
  origin: SiteSchema,
  destination: SiteSchema,
  vehiclePlate: z.string().nullable(),
  trailerCode: z.string().nullable(),
  driverName: z.string().nullable(),
  driverPhone: z.string().nullable(),
  shipments: z.array(z.object({ id: IdSchema, code: z.string(), status: z.string(), dockCode: z.string().nullable() })),
  lines: z.array(WaybillLineSchema),
  handlingUnits: z.array(WaybillUnitSchema),
  totalUnits: z.number().int(),
  totalWeightKg: z.number(),
  proofPhotos: z.array(z.object({ label: z.string(), dataUrl: z.string() })),
  generatedAt: z.string(),
});
export type Waybill = z.infer<typeof WaybillSchema>;

