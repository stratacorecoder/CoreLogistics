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
import { ctxOf } from "../../events.js";
import { authenticateDevice, createDevice, ingest, listDevices, setDeviceActive } from "./service.js";

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
}
