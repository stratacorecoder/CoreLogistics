import { z } from "zod";
import { IdSchema, IsoDateSchema } from "./common.js";

export const VEHICLE_KINDS = ["truck", "trailer", "van"] as const;
export const VehicleKindSchema = z.enum(VEHICLE_KINDS);
export type VehicleKind = z.infer<typeof VehicleKindSchema>;

export const VEHICLE_STATUSES = [
  "available",
  "on_trip",
  "in_yard",
  "at_dock",
  "maintenance",
  "inactive",
] as const;
export const VehicleStatusSchema = z.enum(VEHICLE_STATUSES);
export type VehicleStatus = z.infer<typeof VehicleStatusSchema>;

export const VehicleSchema = z.object({
  id: IdSchema,
  code: z.string(),
  plate: z.string(),
  kind: VehicleKindSchema,
  model: z.string(),
  capacityKg: z.number(),
  capacityM3: z.number(),
  status: VehicleStatusSchema,
  homeSiteId: IdSchema.nullable(),
  currentSiteId: IdSchema.nullable(),
  odometerKm: z.number(),
  rfidTag: z.string().nullable(),
  lastLat: z.number().nullable(),
  lastLng: z.number().nullable(),
  lastSeenAt: z.string().nullable(),
});
export type Vehicle = z.infer<typeof VehicleSchema>;

export const VehicleInputSchema = z.object({
  code: z.string().min(1).max(16),
  plate: z.string().min(2).max(16),
  kind: VehicleKindSchema,
  model: z.string().default(""),
  capacityKg: z.number().nonnegative(),
  capacityM3: z.number().nonnegative(),
  homeSiteId: IdSchema.nullable().optional(),
  odometerKm: z.number().nonnegative().default(0),
  rfidTag: z.string().nullable().optional(),
});
export type VehicleInput = z.input<typeof VehicleInputSchema>;

export const VehiclePatchSchema = VehicleInputSchema.partial().extend({
  status: z.enum(["available", "inactive"]).optional(),
});
export type VehiclePatch = z.input<typeof VehiclePatchSchema>;

export const DRIVER_STATUSES = ["available", "on_trip", "off_duty"] as const;
export const DriverStatusSchema = z.enum(DRIVER_STATUSES);
export type DriverStatus = z.infer<typeof DriverStatusSchema>;

export const DriverSchema = z.object({
  id: IdSchema,
  code: z.string(),
  name: z.string(),
  phone: z.string(),
  licenseClass: z.string(),
  licenseExpiry: z.string(),
  status: DriverStatusSchema,
  homeSiteId: IdSchema.nullable(),
});
export type Driver = z.infer<typeof DriverSchema>;

export const DriverInputSchema = z.object({
  code: z.string().min(1).max(16),
  name: z.string().min(1),
  phone: z.string().default(""),
  licenseClass: z.string().default("C"),
  licenseExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  homeSiteId: IdSchema.nullable().optional(),
});
export type DriverInput = z.input<typeof DriverInputSchema>;

export const DriverPatchSchema = DriverInputSchema.partial().extend({
  status: z.enum(["available", "off_duty"]).optional(),
});

export const MAINTENANCE_KINDS = ["service", "repair", "inspection", "breakdown"] as const;
export const MaintenanceKindSchema = z.enum(MAINTENANCE_KINDS);
export type MaintenanceKind = z.infer<typeof MaintenanceKindSchema>;

export const MaintenanceRecordSchema = z.object({
  id: IdSchema,
  vehicleId: IdSchema,
  kind: MaintenanceKindSchema,
  description: z.string(),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
  costCents: z.number().int(),
  odometerKm: z.number().nullable(),
});
export type MaintenanceRecord = z.infer<typeof MaintenanceRecordSchema>;

export const MaintenanceInputSchema = z.object({
  vehicleId: IdSchema,
  kind: MaintenanceKindSchema,
  description: z.string().min(1),
  odometerKm: z.number().nonnegative().optional(),
  openedAt: IsoDateSchema.optional(),
});
export type MaintenanceInput = z.input<typeof MaintenanceInputSchema>;

export const MaintenanceCloseSchema = z.object({
  costCents: z.number().int().nonnegative().default(0),
});
