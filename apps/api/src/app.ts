import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyError } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { HttpError } from "./errors.js";
import analyticsRoutes from "./modules/analytics/routes.js";
import authRoutes from "./modules/auth/routes.js";
import fleetRoutes from "./modules/fleet/routes.js";
import gateRoutes from "./modules/gate/routes.js";
import ingestRoutes from "./modules/ingest/routes.js";
import outboundRoutes from "./modules/outbound/routes.js";
import siteRoutes from "./modules/sites/routes.js";
import streamRoutes from "./modules/stream/routes.js";
import tripRoutes from "./modules/trips/routes.js";
import warehouseRoutes from "./modules/warehouse/routes.js";

interface ValidationIssue {
  instancePath?: string;
  message?: string;
  params?: { issue?: { path?: (string | number)[]; message?: string } };
}

function validationMessage(err: FastifyError): string {
  const issues = (err.validation ?? []) as unknown as ValidationIssue[];
  const parts = issues.map((i) => {
    const path = i.params?.issue?.path?.join(".") || i.instancePath?.replace(/^\//, "").replace(/\//g, ".");
    const msg = i.params?.issue?.message ?? i.message ?? "invalid";
    return path ? `${path}: ${msg}` : msg;
  });
  return parts.length ? `${err.validationContext ?? "request"} ${parts.join("; ")}` : err.message;
}

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ? { level: process.env.LOG_LEVEL ?? "info" } : false,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "CoreLogistics API",
        version: "0.1.0",
        description:
          "Fleet, yard and warehouse management. All state changes are written to the event log (`/events`, `/stream`). " +
          "Send `x-session` (or Bearer) after `/auth/login` so actions are attributed to the signed-in person.",
      },
      tags: [
        { name: "sites", description: "Sites, layouts and locations" },
        { name: "fleet", description: "Vehicles, drivers and maintenance" },
        { name: "trips", description: "Trip planning, dispatch and tracking" },
        { name: "gate", description: "Gate check-in/out, yard and dock doors" },
        { name: "warehouse", description: "Receiving, sorting, putaway and stock" },
        { name: "outbound", description: "Orders, picking, staging and loading" },
        { name: "ingest", description: "Automation input from cameras, RFID and GPS" },
        { name: "devices", description: "Registered automation devices" },
        { name: "analytics", description: "Operational KPIs" },
        { name: "events", description: "Event log and live stream" },
        { name: "auth", description: "Issued staff accounts" },
      ],
      components: {
        securitySchemes: {
          deviceKey: { type: "apiKey", in: "header", name: "x-device-key" },
          session: { type: "apiKey", in: "header", name: "x-session" },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    if (err.validation) return reply.code(400).send({ error: validationMessage(err) });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: err.message || "Internal error" });
  });

  app.get("/health", { schema: { hide: true } }, async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(siteRoutes);
  await app.register(fleetRoutes);
  await app.register(tripRoutes);
  await app.register(gateRoutes);
  await app.register(warehouseRoutes);
  await app.register(outboundRoutes);
  await app.register(ingestRoutes);
  await app.register(analyticsRoutes);
  await app.register(streamRoutes);

  return app;
}
