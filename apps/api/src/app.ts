import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { SessionUser } from "@corelogistics/contracts";
import Fastify, { type FastifyError, type FastifyRequest } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { one } from "./db.js";
import { forbidden, HttpError, unauthorized } from "./errors.js";
import { authTokenOf, sessionUser } from "./modules/auth/service.js";
import analyticsRoutes from "./modules/analytics/routes.js";
import authRoutes from "./modules/auth/routes.js";
import { copilotRoutes } from "./modules/copilot/routes.js";
import { getCopilotMonitoring, initCopilot } from "./modules/copilot/worker.js";
import fleetRoutes from "./modules/fleet/routes.js";
import gateRoutes from "./modules/gate/routes.js";
import ingestRoutes from "./modules/ingest/routes.js";
import opsRoutes from "./modules/ops/routes.js";
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

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5180",
  "http://localhost:5181",
  "http://localhost:5182",
  "http://localhost:5183",
  "http://127.0.0.1:5180",
  "http://127.0.0.1:5181",
  "http://127.0.0.1:5182",
  "http://127.0.0.1:5183",
];

const DRIVER_TRIP_ACTION_RE = /^\/trips\/([^/]+)\/(?:depart|arrive|complete|issues|stops\/[^/]+\/(?:arrive|depart))$/;

export function allowedOrigin(origin?: string): string | undefined {
  if (!origin) return undefined;
  const trimmed = origin.trim();
  if (!trimmed) return undefined;
  const allowlist = new Set(DEFAULT_ALLOWED_ORIGINS);
  const extra = process.env.CORELOGISTICS_CORS_ORIGINS ?? "";
  for (const item of extra.split(",")) {
    const candidate = item.trim();
    if (!candidate) continue;
    try {
      allowlist.add(new URL(candidate).origin);
    } catch {
      // Ignore malformed env origin entries rather than broadening matching
    }
  }
  return allowlist.has(trimmed) ? trimmed : undefined;
}

function requestOrigin(req: FastifyRequest): string | undefined {
  const trustProxy = process.env.CORELOGISTICS_TRUST_PROXY === "1";
  const forwardedHost =
    trustProxy && typeof req.headers["x-forwarded-host"] === "string"
      ? req.headers["x-forwarded-host"].split(",")[0]?.trim()
      : undefined;
  const host = forwardedHost || (typeof req.headers.host === "string" ? req.headers.host.trim() : "");
  if (!host) return undefined;
  try {
    return new URL(`${req.protocol}://${host}`).origin;
  } catch {
    return undefined;
  }
}

export function originAllowedForRequest(candidate: string, req: FastifyRequest): boolean {
  return Boolean(allowedOrigin(candidate) || (candidate && candidate === requestOrigin(req)));
}

function csrfOriginAllowed(req: FastifyRequest): boolean {
  if (typeof req.headers.origin === "string") {
    return originAllowedForRequest(req.headers.origin.trim(), req);
  }
  if (typeof req.headers.referer === "string") {
    try {
      return originAllowedForRequest(new URL(req.headers.referer).origin, req);
    } catch {
      return false;
    }
  }
  return false;
}

function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const NUDGE_ACK_RE = /^\/ops\/nudges\/(\d+)\/ack$/;

function authorizeWrite(method: string, path: string, user: SessionUser) {
  if (user.role === "tower") return;

  if (method === "POST") {
    const nudgeMatch = NUDGE_ACK_RE.exec(path);
    if (nudgeMatch) {
      const nudgeRow = one<{ driver_id: string | null; payload: string }>(
        "SELECT driver_id, payload FROM events WHERE id = ? AND type = 'ops.nudge'",
        [Number(nudgeMatch[1])],
      );
      if (nudgeRow) {
        let targetRole: string | undefined;
        try {
          targetRole = (JSON.parse(nudgeRow.payload || "{}") as { targetRole?: string }).targetRole;
        } catch {
          targetRole = undefined;
        }
        if (targetRole && targetRole !== user.role) {
          throw forbidden(`Only ${targetRole} or tower operators can acknowledge this nudge`);
        }
        if (user.role === "driver" && nudgeRow.driver_id && nudgeRow.driver_id !== user.driverId) {
          throw forbidden("You may only acknowledge nudges addressed to you");
        }
      }
      return;
    }
  }

  if (method === "POST" && path === "/ops/nudges") {
    if (user.role === "gate") return;
    throw forbidden("Control Tower or Gate operator role required");
  }

  if (path === "/gate" || path.startsWith("/gate/")) {
    if (user.role !== "gate") throw forbidden("Gate operator or planner role required");
    return;
  }

  if (path.startsWith("/warehouse/") || path.startsWith("/outbound/")) {
    if (user.role !== "warehouse") throw forbidden("Warehouse operator or planner role required");
    return;
  }

  if (method === "POST") {
    const tripMatch = DRIVER_TRIP_ACTION_RE.exec(path);
    if (tripMatch) {
      if (user.role !== "driver") throw forbidden("Assigned driver or planner role required");
      if (!user.driverId) throw forbidden("Account is not linked to a driver profile");
      const tripId = safeDecodeSegment(tripMatch[1]!);
      const trip = one<{ driver_id: string | null }>("SELECT driver_id FROM trips WHERE id = ?", [tripId]);
      if (trip && trip.driver_id !== user.driverId) {
        throw forbidden("You may only update trips assigned to you");
      }
      return;
    }
  }

  throw forbidden("Control Tower planner role required");
}

export async function buildApp(opts: { logger?: boolean } = {}) {
  const trustProxy = process.env.CORELOGISTICS_TRUST_PROXY === "1";
  const app = Fastify({
    logger: opts.logger ? { level: process.env.LOG_LEVEL ?? "info" } : false,
    trustProxy,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, false);
      const match = allowedOrigin(origin);
      cb(null, match ?? false);
    },
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-session", "x-actor", "x-device-key"],
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

  app.get("/health", { schema: { hide: true } }, async () => {
    const monitoring = getCopilotMonitoring();
    return {
      ok: true,
      heartbeatAt: monitoring.heartbeatAt,
      backlog: monitoring.backlog,
      failedJobs: monitoring.failedJobs,
    };
  });

  app.addHook("onRequest", async (req) => {
    if (req.method === "OPTIONS") return;
    if (process.env.NODE_ENV !== "production" && process.env.CORELOGISTICS_AUTH_DISABLED === "1") return;
    const path = req.url.split("?")[0]!;
    if (
      path === "/health" ||
      path === "/auth/login" ||
      path === "/docs" ||
      path.startsWith("/docs/") ||
      path.startsWith("/ingest/")
    ) {
      return;
    }

    const auth = authTokenOf(req);
    if (path === "/auth/logout") {
      if (auth.via === "cookie" && sessionUser(auth.token) && !csrfOriginAllowed(req)) {
        throw forbidden("Cross-site request blocked");
      }
      return;
    }

    const user = sessionUser(auth.token);
    if (!user) throw unauthorized("Sign in required");

    // Devices are restricted to Control Tower planners across all HTTP methods
    if (path === "/devices" || path.startsWith("/devices/")) {
      if (user.role !== "tower") throw forbidden("Control Tower planner role required");
    }

    // Administrative access control
    if (
      (path.startsWith("/sites/") && path.endsWith("/layout") && req.method === "PUT") ||
      (path === "/sites" && req.method === "POST") ||
      (path === "/copilot/config" && req.method === "POST") ||
      (path === "/copilot/ask" && req.method === "POST") ||
      (path.startsWith("/copilot/jobs/") && path.endsWith("/retry") && req.method === "POST") ||
      (path.startsWith("/copilot/recommendations/") &&
        (path.endsWith("/apply") || path.endsWith("/dismiss")) &&
        req.method === "POST")
    ) {
      if (user.role !== "tower") {
        throw forbidden("Control Tower planner role required");
      }
    }

    if (req.method === "GET" || req.method === "HEAD") {
      return;
    }

    if (auth.via === "cookie" && !csrfOriginAllowed(req)) {
      throw forbidden("Cross-site request blocked");
    }

    authorizeWrite(req.method, path, user);
  });

  await app.register(authRoutes);
  await app.register(siteRoutes);
  await app.register(fleetRoutes);
  await app.register(tripRoutes);
  await app.register(gateRoutes);
  await app.register(warehouseRoutes);
  await app.register(outboundRoutes);
  await app.register(ingestRoutes);
  await app.register(analyticsRoutes);
  await app.register(copilotRoutes);
  await app.register(opsRoutes);
  await app.register(streamRoutes);

  initCopilot(app);

  return app;
}
