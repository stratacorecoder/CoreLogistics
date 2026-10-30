import { z } from "zod";
import { IdSchema, IsoDateSchema } from "./common.js";

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

export const TripIssueInputSchema = z.object({
  kind: IssueKindSchema,
  message: z.string().min(1).max(500),
  lat: z.number().optional(),
  lng: z.number().optional(),
});
export type TripIssueInput = z.input<typeof TripIssueInputSchema>;

export const TripStopParamsSchema = z.object({ id: IdSchema, stopId: IdSchema });
