import {
  EventRecordSchema,
  IdParamsSchema,
  TripCompleteInputSchema,
  TripInputSchema,
  TripIssueInputSchema,
  TripPatchSchema,
  TripQuerySchema,
  TripSchema,
  TripStopParamsSchema,
} from "@corelogistics/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { forbidden } from "../../errors.js";
import { ctxOf, listEvents } from "../../events.js";
import { sessionUser, tokenOf } from "../auth/service.js";
import {
  arriveTrip,
  cancelTrip,
  completeTrip,
  createTrip,
  departTrip,
  dispatchTrip,
  getTrip,
  listTrips,
  reportIssue,
  stopEvent,
  updateTrip,
} from "./service.js";

function signedDriver(req: FastifyRequest) {
  const user = sessionUser(tokenOf(req));
  if (user?.role !== "driver") return null;
  if (!user.driverId) throw forbidden("This login is not tied to a driver record");
  return user;
}

function assertPlanner(req: FastifyRequest) {
  if (signedDriver(req)) throw forbidden("Drivers cannot change trip plans");
}

function assertAssignedDriver(req: FastifyRequest, tripId: string) {
  const driver = signedDriver(req);
  if (!driver) return;
  const trip = getTrip(tripId);
  if (trip.driverId !== driver.driverId) throw forbidden("This trip is assigned to another driver");
}

export default async function tripRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ["trips"];
  const one = { params: IdParamsSchema, response: { 200: TripSchema } };

  r.get("/trips", { schema: { tags, querystring: TripQuerySchema, response: { 200: z.array(TripSchema) } } }, async (req) => {
    const driver = signedDriver(req);
    if (!driver) return listTrips(req.query);
    if (req.query.driverId && req.query.driverId !== driver.driverId) {
      throw forbidden("This trip is assigned to another driver");
    }
    return listTrips({ ...req.query, driverId: driver.driverId! });
  });
  r.post("/trips", { schema: { tags, body: TripInputSchema, response: { 200: TripSchema } } }, async (req) => {
    assertPlanner(req);
    return createTrip(req.body, ctxOf(req));
  });
  r.get("/trips/:id", { schema: { tags, ...one } }, async (req) => {
    assertAssignedDriver(req, req.params.id);
    return getTrip(req.params.id);
  });
  r.patch("/trips/:id", { schema: { tags, ...one, body: TripPatchSchema } }, async (req) => {
    assertPlanner(req);
    return updateTrip(req.params.id, req.body, ctxOf(req));
  });

  r.post("/trips/:id/dispatch", { schema: { tags, ...one } }, async (req) => {
    assertPlanner(req);
    return dispatchTrip(req.params.id, ctxOf(req));
  });
  r.post("/trips/:id/depart", { schema: { tags, ...one, summary: "Confirm departure (idempotent)" } }, async (req) => {
    assertAssignedDriver(req, req.params.id);
    return departTrip(req.params.id, ctxOf(req));
  });
  r.post("/trips/:id/arrive", { schema: { tags, ...one, summary: "Confirm arrival (idempotent)" } }, async (req) => {
    assertAssignedDriver(req, req.params.id);
    return arriveTrip(req.params.id, ctxOf(req));
  });
  r.post(
    "/trips/:id/complete",
    {
      schema: {
        tags,
        ...one,
        summary: "Complete trip with optional electronic proof of delivery (e-POD)",
        body: TripCompleteInputSchema.optional(),
      },
    },
    async (req) => {
      assertAssignedDriver(req, req.params.id);
      return completeTrip(req.params.id, ctxOf(req), req.body);
    },
  );
  r.post("/trips/:id/cancel", { schema: { tags, ...one } }, async (req) => {
    assertPlanner(req);
    return cancelTrip(req.params.id, ctxOf(req));
  });

  r.post(
    "/trips/:id/stops/:stopId/arrive",
    { schema: { tags, params: TripStopParamsSchema, response: { 200: TripSchema } } },
    async (req) => {
      assertAssignedDriver(req, req.params.id);
      return stopEvent(req.params.id, req.params.stopId, "arrive", ctxOf(req));
    },
  );
  r.post(
    "/trips/:id/stops/:stopId/depart",
    { schema: { tags, params: TripStopParamsSchema, response: { 200: TripSchema } } },
    async (req) => {
      assertAssignedDriver(req, req.params.id);
      return stopEvent(req.params.id, req.params.stopId, "depart", ctxOf(req));
    },
  );

  r.post(
    "/trips/:id/issues",
    { schema: { tags, params: IdParamsSchema, body: TripIssueInputSchema, response: { 200: EventRecordSchema } } },
    async (req) => {
      assertAssignedDriver(req, req.params.id);
      return reportIssue(req.params.id, req.body, ctxOf(req));
    },
  );
  r.get(
    "/trips/:id/events",
    { schema: { tags, params: IdParamsSchema, response: { 200: z.array(EventRecordSchema) } } },
    async (req) => {
      assertAssignedDriver(req, req.params.id);
      return listEvents({ tripId: getTrip(req.params.id).id, limit: 200 });
    },
  );
}
