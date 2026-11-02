import { z } from "zod";
import { EventSourceSchema, IdSchema, IsoDateSchema } from "./common.js";

export const EVENT_TYPES = [
  "site.created",
  "layout.saved",
  "vehicle.created",
  "vehicle.updated",
  "vehicle.position",
  "driver.created",
  "driver.updated",
  "maintenance.opened",
  "maintenance.closed",
  "trip.created",
  "trip.updated",
  "trip.dispatched",
  "trip.departed",
  "trip.stop_arrived",
  "trip.stop_departed",
  "trip.arrived",
  "trip.completed",
  "trip.cancelled",
  "trip.issue",
  "gate.check_in",
  "gate.check_out",
  "yard.moved",
  "dock.assigned",
  "dock.released",
  "receipt.created",
  "receipt.closed",
  "hu.received",
  "hu.sorted",
  "putaway.created",
  "putaway.done",
  "order.created",
  "order.released",
  "pick.done",
  "order.staged",
  "shipment.created",
  "hu.loaded",
  "shipment.departed",
  "device.created",
  "device.read",
  "appointment.created",
  "appointment.cancelled",
] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventRecordSchema = z.object({
  id: z.number().int(),
  type: EventTypeSchema,
  source: EventSourceSchema,
  actor: z.string().nullable(),
  siteId: IdSchema.nullable(),
  vehicleId: IdSchema.nullable(),
  tripId: IdSchema.nullable(),
  driverId: IdSchema.nullable(),
  locationId: IdSchema.nullable(),
  huId: IdSchema.nullable(),
  entityId: IdSchema.nullable(),
  message: z.string(),
  payload: z.record(z.unknown()),
  occurredAt: z.string(),
  recordedAt: z.string(),
});
export type EventRecord = z.infer<typeof EventRecordSchema>;

export const EventQuerySchema = z.object({
  siteId: IdSchema.optional(),
  vehicleId: IdSchema.optional(),
  tripId: IdSchema.optional(),
  driverId: IdSchema.optional(),
  huId: IdSchema.optional(),
  type: z.string().optional().describe("Exact type or prefix ending in '.', e.g. 'gate.'"),
  afterId: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const DEVICE_KINDS = ["camera", "rfid", "gps"] as const;
export const DeviceKindSchema = z.enum(DEVICE_KINDS);
export type DeviceKind = z.infer<typeof DeviceKindSchema>;

export const DeviceSchema = z.object({
  id: IdSchema,
  code: z.string(),
  name: z.string(),
  kind: DeviceKindSchema,
  siteId: IdSchema.nullable(),
  locationId: IdSchema.nullable(),
  vehicleId: IdSchema.nullable(),
  active: z.boolean(),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const DeviceInputSchema = z
  .object({
    code: z.string().min(1).max(24),
    name: z.string().min(1),
    kind: DeviceKindSchema,
    siteId: IdSchema.nullable().optional(),
    locationId: IdSchema.nullable().optional(),
    vehicleId: IdSchema.nullable().optional(),
  })
  .refine((d) => (d.kind === "gps" ? Boolean(d.vehicleId) : Boolean(d.locationId)), {
    message: "GPS units bind to a vehicle; cameras and RFID readers bind to a location",
  });
export type DeviceInput = z.input<typeof DeviceInputSchema>;

export const DeviceCreatedSchema = z.object({
  device: DeviceSchema,
  apiKey: z.string().describe("Shown once. Send as the x-device-key header."),
});

/**
 * Normalized payloads from automation hardware. Each resolves to the same
 * service calls that gate and warehouse staff trigger by hand.
 */
export const IngestInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("plate_read"),
    plate: z.string().min(2),
    direction: z.enum(["in", "out"]).optional(),
    confidence: z.number().min(0).max(1).optional(),
    occurredAt: IsoDateSchema.optional(),
  }),
  z.object({
    type: z.literal("rfid_read"),
    tag: z.string().min(1),
    occurredAt: IsoDateSchema.optional(),
  }),
  z.object({
    type: z.literal("gps_ping"),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    speedKph: z.number().nonnegative().optional(),
    headingDeg: z.number().min(0).max(360).optional(),
    occurredAt: IsoDateSchema.optional(),
  }),
]);
export type IngestInput = z.infer<typeof IngestInputSchema>;

export const IngestResultSchema = z.object({
  accepted: z.boolean(),
  action: z.string(),
  detail: z.string(),
  eventId: z.number().int().nullable().describe("Null for routine GPS pings that are only stored on the vehicle"),
});
export type IngestResult = z.infer<typeof IngestResultSchema>;
