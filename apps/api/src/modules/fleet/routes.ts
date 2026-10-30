import {
  DriverInputSchema,
  DriverPatchSchema,
  DriverSchema,
  EventRecordSchema,
  IdParamsSchema,
  MaintenanceCloseSchema,
  MaintenanceInputSchema,
  MaintenanceRecordSchema,
  VehicleInputSchema,
  VehiclePatchSchema,
  VehicleSchema,
} from "@corelogistics/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ctxOf, listEvents } from "../../events.js";
import {
  closeMaintenance,
  createDriver,
  createVehicle,
  getDriver,
  getVehicle,
  listDrivers,
  listMaintenance,
  listVehicles,
  openMaintenance,
  updateDriver,
  updateVehicle,
} from "./service.js";

export default async function fleetRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ["fleet"];

  r.get("/vehicles", { schema: { tags, response: { 200: z.array(VehicleSchema) } } }, async () => listVehicles());
  r.post("/vehicles", { schema: { tags, body: VehicleInputSchema, response: { 200: VehicleSchema } } }, async (req) =>
    createVehicle(req.body, ctxOf(req)),
  );
  r.get("/vehicles/:id", { schema: { tags, params: IdParamsSchema, response: { 200: VehicleSchema } } }, async (req) =>
    getVehicle(req.params.id),
  );
  r.patch(
    "/vehicles/:id",
    { schema: { tags, params: IdParamsSchema, body: VehiclePatchSchema, response: { 200: VehicleSchema } } },
    async (req) => updateVehicle(req.params.id, req.body, ctxOf(req)),
  );
  r.get(
    "/vehicles/:id/events",
    {
      schema: {
        tags,
        summary: "Vehicle timeline",
        params: IdParamsSchema,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
        response: { 200: z.array(EventRecordSchema) },
      },
    },
    async (req) => listEvents({ vehicleId: getVehicle(req.params.id).id, limit: req.query.limit }),
  );

  r.get("/drivers", { schema: { tags, response: { 200: z.array(DriverSchema) } } }, async () => listDrivers());
  r.post("/drivers", { schema: { tags, body: DriverInputSchema, response: { 200: DriverSchema } } }, async (req) =>
    createDriver(req.body, ctxOf(req)),
  );
  r.get("/drivers/:id", { schema: { tags, params: IdParamsSchema, response: { 200: DriverSchema } } }, async (req) =>
    getDriver(req.params.id),
  );
  r.patch(
    "/drivers/:id",
    { schema: { tags, params: IdParamsSchema, body: DriverPatchSchema, response: { 200: DriverSchema } } },
    async (req) => updateDriver(req.params.id, req.body, ctxOf(req)),
  );

  r.get(
    "/maintenance",
    {
      schema: {
        tags,
        querystring: z.object({ vehicleId: z.string().optional(), open: z.enum(["true", "false"]).optional() }),
        response: { 200: z.array(MaintenanceRecordSchema) },
      },
    },
    async (req) =>
      listMaintenance({
        vehicleId: req.query.vehicleId,
        open: req.query.open === undefined ? undefined : req.query.open === "true",
      }),
  );
  r.post(
    "/maintenance",
    { schema: { tags, body: MaintenanceInputSchema, response: { 200: MaintenanceRecordSchema } } },
    async (req) => openMaintenance(req.body, ctxOf(req)),
  );
  r.post(
    "/maintenance/:id/close",
    { schema: { tags, params: IdParamsSchema, body: MaintenanceCloseSchema, response: { 200: MaintenanceRecordSchema } } },
    async (req) => closeMaintenance(req.params.id, req.body.costCents, ctxOf(req)),
  );
}
