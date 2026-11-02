import {
  DeviceCreatedSchema,
  DeviceInputSchema,
  DeviceSchema,
  IdParamsSchema,
  IngestInputSchema,
  IngestResultSchema,
  type Device,
} from "@corelogistics/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { badRequest } from "../../errors.js";
import { ctxOf } from "../../events.js";
import {
  authenticateDevice,
  authenticateTraccarDevice,
  createDevice,
  ingest,
  listDevices,
  setDeviceActive,
} from "./service.js";

const TraccarQuerySchema = z.object({
  id: z.string().optional(),
  lat: z.coerce.number(),
  lon: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  timestamp: z.union([z.coerce.number(), z.string()]).optional(),
  speed: z.coerce.number().optional(),
  bearing: z.coerce.number().optional(),
  altitude: z.coerce.number().optional(),
});

function parseTraccar(data: z.infer<typeof TraccarQuerySchema>, headerKey?: string) {
  const deviceKey = headerKey ?? data.id;
  const device = authenticateTraccarDevice(deviceKey);
  const lng = data.lng ?? data.lon;
  if (lng === undefined) throw badRequest("Missing longitude (lon or lng parameter)");
  let occurredAt: string | undefined;
  if (data.timestamp != null) {
    if (typeof data.timestamp === "number") {
      const ms = data.timestamp < 1e11 ? data.timestamp * 1000 : data.timestamp;
      occurredAt = new Date(ms).toISOString();
    } else {
      occurredAt = new Date(data.timestamp).toISOString();
    }
  }
  return {
    device,
    input: {
      type: "gps_ping" as const,
      lat: data.lat,
      lng,
      speedKph: data.speed,
      occurredAt,
    },
  };
}

export default async function ingestRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/devices", { schema: { tags: ["devices"], response: { 200: z.array(DeviceSchema) } } }, async () => listDevices());
  r.post(
    "/devices",
    {
      schema: {
        tags: ["devices"],
        summary: "Register a camera, RFID reader or GPS unit; returns its API key once",
        body: DeviceInputSchema,
        response: { 200: DeviceCreatedSchema },
      },
    },
    async (req) => createDevice(req.body, ctxOf(req)),
  );
  r.patch(
    "/devices/:id",
    { schema: { tags: ["devices"], params: IdParamsSchema, body: z.object({ active: z.boolean() }), response: { 200: DeviceSchema } } },
    async (req) => setDeviceActive(req.params.id, req.body.active),
  );

  const devices = new WeakMap<FastifyRequest, Device>();
  r.post(
    "/ingest/events",
    {
      onRequest: async (req) => {
        devices.set(req, authenticateDevice(req.headers["x-device-key"] as string | undefined));
      },
      schema: {
        tags: ["ingest"],
        summary: "Automation endpoint for cameras (plate_read), RFID readers (rfid_read) and GPS units (gps_ping)",
        description:
          "Authenticate with the `x-device-key` header. Reads resolve to the same actions staff perform by hand: " +
          "a plate at the gate checks a truck in or out, a plate or tag at a dock door docks it, an HU tag at a bin " +
          "confirms putaway, an HU tag at a loading dock loads it, and GPS geofences mark trips departed or arrived.",
        security: [{ deviceKey: [] }],
        headers: z.object({ "x-device-key": z.string().optional() }),
        body: IngestInputSchema,
        response: { 200: IngestResultSchema },
      },
    },
    async (req) => ingest(devices.get(req)!, req.body),
  );

  r.get(
    "/ingest/traccar",
    {
      schema: {
        tags: ["ingest"],
        summary: "OsmAnd / Traccar HTTP protocol GPS telemetry receiver (GET)",
        querystring: TraccarQuerySchema,
        response: { 200: IngestResultSchema },
      },
    },
    async (req) => {
      const headerKey = req.headers["x-device-key"] as string | undefined;
      const { device, input } = parseTraccar(req.query, headerKey);
      return ingest(device, input);
    },
  );

  r.post(
    "/ingest/traccar",
    {
      schema: {
        tags: ["ingest"],
        summary: "OsmAnd / Traccar HTTP protocol GPS telemetry receiver (POST)",
        querystring: TraccarQuerySchema.partial(),
        body: TraccarQuerySchema.partial().optional(),
        response: { 200: IngestResultSchema },
      },
    },
    async (req) => {
      const combined = { ...((req.body as any) || {}), ...((req.query as any) || {}) };
      const parsed = TraccarQuerySchema.parse(combined);
      const headerKey = req.headers["x-device-key"] as string | undefined;
      const { device, input } = parseTraccar(parsed, headerKey);
      return ingest(device, input);
    },
  );
}
