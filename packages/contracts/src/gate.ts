import { z } from "zod";
import { EventSourceSchema, IdSchema } from "./common.js";
import { VehicleKindSchema } from "./fleet.js";
import { TripSchema } from "./trips.js";

export const VISIT_STATUSES = ["in_yard", "at_dock", "departed"] as const;
export const VisitStatusSchema = z.enum(VISIT_STATUSES);
export type VisitStatus = z.infer<typeof VisitStatusSchema>;

export const DOCK_PURPOSES = ["unload", "load"] as const;
export const DockPurposeSchema = z.enum(DOCK_PURPOSES);
export type DockPurpose = z.infer<typeof DockPurposeSchema>;

export const DockInfoSchema = z.object({
  assignmentId: IdSchema,
  locationId: IdSchema,
  code: z.string(),
  purpose: DockPurposeSchema,
  assignedAt: z.string(),
});
export type DockInfo = z.infer<typeof DockInfoSchema>;

export const GateVisitSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  vehicleId: IdSchema,
  plate: z.string(),
  vehicleKind: VehicleKindSchema,
  tripId: IdSchema.nullable(),
  tripCode: z.string().nullable(),
  status: VisitStatusSchema,
  checkInAt: z.string(),
  checkOutAt: z.string().nullable(),
  yardLocationId: IdSchema.nullable(),
  yardCode: z.string().nullable(),
  sealIn: z.string(),
  sealOut: z.string(),
  notes: z.string(),
  sourceIn: EventSourceSchema,
  sourceOut: EventSourceSchema.nullable(),
  dock: DockInfoSchema.nullable(),
  dwellMinutes: z.number().int(),
});
export type GateVisit = z.infer<typeof GateVisitSchema>;

export const VisitQuerySchema = z.object({
  siteId: IdSchema.optional(),
  open: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const CheckInInputSchema = z
  .object({
    siteId: IdSchema,
    plate: z.string().optional(),
    vehicleId: IdSchema.optional(),
    tripId: IdSchema.optional(),
    sealNo: z.string().default(""),
    notes: z.string().default(""),
    yardLocationId: IdSchema.optional(),
  })
  .refine((v) => Boolean(v.plate || v.vehicleId), { message: "plate or vehicleId required" });
export type CheckInInput = z.input<typeof CheckInInputSchema>;

export const CheckOutInputSchema = z
  .object({
    visitId: IdSchema.optional(),
    siteId: IdSchema.optional(),
    plate: z.string().optional(),
    sealNo: z.string().default(""),
    notes: z.string().default(""),
  })
  .refine((v) => Boolean(v.visitId || (v.plate && v.siteId)), {
    message: "visitId, or plate and siteId, required",
  });
export type CheckOutInput = z.input<typeof CheckOutInputSchema>;

export const AssignDockInputSchema = z.object({
  locationId: IdSchema.optional(),
  purpose: DockPurposeSchema.optional(),
});
export type AssignDockInput = z.input<typeof AssignDockInputSchema>;

export const MoveYardInputSchema = z.object({ locationId: IdSchema });

export const DockSuggestionSchema = z.object({
  locationId: IdSchema.nullable(),
  code: z.string().nullable(),
  reason: z.string(),
});
export type DockSuggestion = z.infer<typeof DockSuggestionSchema>;

export const EXPECTED_DIRECTIONS = ["arriving", "collecting"] as const;
export const ExpectedTripSchema = TripSchema.extend({
  direction: z.enum(EXPECTED_DIRECTIONS),
  plate: z.string().nullable(),
});
export type ExpectedTrip = z.infer<typeof ExpectedTripSchema>;
