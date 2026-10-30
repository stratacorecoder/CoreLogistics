import { z } from "zod";
import { IdSchema, ZoneSchema } from "./common.js";

export const AnalyticsQuerySchema = z.object({
  siteId: IdSchema.optional(),
  days: z.coerce.number().int().min(1).max(90).default(7),
});

export const DockUtilizationSchema = z.object({
  locationId: IdSchema,
  code: z.string(),
  siteId: IdSchema,
  assignments: z.number().int(),
  busyMinutes: z.number().int(),
  utilizationPct: z.number(),
});

export const ZoneCapacitySchema = z.object({
  zone: ZoneSchema,
  capacity: z.number().int(),
  used: z.number().int(),
  pct: z.number(),
});

export const ThroughputDaySchema = z.object({
  date: z.string(),
  received: z.number().int(),
  shipped: z.number().int(),
  gateIn: z.number().int(),
  gateOut: z.number().int(),
});

export const AnalyticsSummarySchema = z.object({
  from: z.string(),
  to: z.string(),
  siteId: IdSchema.nullable(),
  fleet: z.object({
    total: z.number().int(),
    byStatus: z.record(z.number().int()),
  }),
  trips: z.object({
    active: z.number().int(),
    delayed: z.number().int(),
    completedInPeriod: z.number().int(),
    onTimeDeparturePct: z.number().nullable(),
    onTimeArrivalPct: z.number().nullable(),
  }),
  yard: z.object({
    inYard: z.number().int(),
    atDock: z.number().int(),
    visitsInPeriod: z.number().int(),
    avgDwellMinutes: z.number().nullable(),
    maxCurrentDwellMinutes: z.number().nullable(),
  }),
  dockUtilizationPct: z.number().nullable(),
  docks: z.array(DockUtilizationSchema),
  turnaroundMinutes: z.number().nullable(),
  capacityByZone: z.array(ZoneCapacitySchema),
  throughput: z.array(ThroughputDaySchema),
  openWork: z.object({
    receipts: z.number().int(),
    putaway: z.number().int(),
    picks: z.number().int(),
    orders: z.number().int(),
    shipments: z.number().int(),
  }),
});
export type AnalyticsSummary = z.infer<typeof AnalyticsSummarySchema>;
