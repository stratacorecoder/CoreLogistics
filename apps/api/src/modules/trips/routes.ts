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
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ctxOf, listEvents } from "../../events.js";
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

export default async function tripRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ["trips"];
  const one = { params: IdParamsSchema, response: { 200: TripSchema } };

  r.get("/trips", { schema: { tags, querystring: TripQuerySchema, response: { 200: z.array(TripSchema) } } }, async (req) =>
    listTrips(req.query),
  );
  r.post("/trips", { schema: { tags, body: TripInputSchema, response: { 200: TripSchema } } }, async (req) =>
    createTrip(req.body, ctxOf(req)),
  );
  r.get("/trips/:id", { schema: { tags, ...one } }, async (req) => getTrip(req.params.id));
  r.patch("/trips/:id", { schema: { tags, ...one, body: TripPatchSchema } }, async (req) =>
    updateTrip(req.params.id, req.body, ctxOf(req)),
  );

  r.post("/trips/:id/dispatch", { schema: { tags, ...one } }, async (req) => dispatchTrip(req.params.id, ctxOf(req)));
  r.post("/trips/:id/depart", { schema: { tags, ...one, summary: "Confirm departure (idempotent)" } }, async (req) =>
    departTrip(req.params.id, ctxOf(req)),
  );
  r.post("/trips/:id/arrive", { schema: { tags, ...one, summary: "Confirm arrival (idempotent)" } }, async (req) =>
    arriveTrip(req.params.id, ctxOf(req)),
  );
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
    async (req) => completeTrip(req.params.id, ctxOf(req), req.body),
  );
  r.post("/trips/:id/cancel", { schema: { tags, ...one } }, async (req) => cancelTrip(req.params.id, ctxOf(req)));

  r.post(
    "/trips/:id/stops/:stopId/arrive",
    { schema: { tags, params: TripStopParamsSchema, response: { 200: TripSchema } } },
    async (req) => stopEvent(req.params.id, req.params.stopId, "arrive", ctxOf(req)),
  );
  r.post(
    "/trips/:id/stops/:stopId/depart",
    { schema: { tags, params: TripStopParamsSchema, response: { 200: TripSchema } } },
    async (req) => stopEvent(req.params.id, req.params.stopId, "depart", ctxOf(req)),
  );

  r.post(
    "/trips/:id/issues",
    { schema: { tags, params: IdParamsSchema, body: TripIssueInputSchema, response: { 200: EventRecordSchema } } },
    async (req) => reportIssue(req.params.id, req.body, ctxOf(req)),
  );
  r.get(
    "/trips/:id/events",
    { schema: { tags, params: IdParamsSchema, response: { 200: z.array(EventRecordSchema) } } },
    async (req) => listEvents({ tripId: getTrip(req.params.id).id, limit: 200 }),
  );
}
