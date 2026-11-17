import { z } from "zod";
import { IdSchema, IsoDateSchema } from "./common.js";

export const COPILOT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const CopilotSeveritySchema = z.enum(COPILOT_SEVERITIES);
export type CopilotSeverity = z.infer<typeof CopilotSeveritySchema>;

/** `resequence_pick` and `reroute_crossdock` are named only. They are not executable. */
export const COPILOT_ACTION_TYPES = [
  "swap_dock",
  "reschedule_appointment",
  "resequence_pick",
  "reroute_crossdock",
] as const;
export const CopilotActionTypeSchema = z.enum(COPILOT_ACTION_TYPES);
export type CopilotActionType = z.infer<typeof CopilotActionTypeSchema>;

export const COPILOT_STATUSES = ["pending", "applied", "dismissed", "auto_applied", "resolved"] as const;
export const CopilotStatusSchema = z.enum(COPILOT_STATUSES);
export type CopilotStatus = z.infer<typeof CopilotStatusSchema>;

/** Live rows use actionable or human_review while status stays pending. Prior revisions are archived as superseded. */
export const COPILOT_LIFECYCLES = [
  "actionable",
  "human_review",
  "applied",
  "auto_applied",
  "dismissed",
  "superseded",
  "resolved",
] as const;
export const CopilotLifecycleSchema = z.enum(COPILOT_LIFECYCLES);
export type CopilotLifecycle = z.infer<typeof CopilotLifecycleSchema>;

export const SwapDockPayloadSchema = z.object({
  visitId: IdSchema,
  locationId: IdSchema,
  plate: z.string(),
  dockCode: z.string(),
});
export type SwapDockPayload = z.infer<typeof SwapDockPayloadSchema>;

export const RescheduleAppointmentPayloadSchema = z.object({
  appointmentId: IdSchema,
  newWindowStart: IsoDateSchema,
  newWindowEnd: IsoDateSchema,
});
export type RescheduleAppointmentPayload = z.infer<typeof RescheduleAppointmentPayloadSchema>;

export const SwapDockActionSchema = z.object({
  type: z.literal("swap_dock"),
  targetId: z.string(),
  description: z.string(),
  payload: SwapDockPayloadSchema,
});

export const RescheduleAppointmentActionSchema = z.object({
  type: z.literal("reschedule_appointment"),
  targetId: z.string(),
  description: z.string(),
  payload: RescheduleAppointmentPayloadSchema,
});

export const CopilotPrescribedActionSchema = z.discriminatedUnion("type", [
  SwapDockActionSchema,
  RescheduleAppointmentActionSchema,
]);
export type CopilotPrescribedAction = z.infer<typeof CopilotPrescribedActionSchema>;

export const CopilotTripPreconditionsSchema = z.object({
  id: IdSchema,
  status: z.string(),
  destinationSiteId: IdSchema,
  plannedDeparture: z.string(),
  plannedArrival: z.string(),
  actualDeparture: z.string().nullable(),
  actualArrival: z.string().nullable(),
  etaAt: z.string().nullable(),
});

export const CopilotAppointmentPreconditionsSchema = z.object({
  id: IdSchema,
  status: z.string(),
  tripId: IdSchema.nullable(),
  siteId: IdSchema,
  locationId: IdSchema.nullable(),
  windowStart: z.string(),
  windowEnd: z.string(),
});

export const CopilotDockSwapPreconditionsSchema = z.object({
  visitId: IdSchema,
  siteId: IdSchema,
  status: z.string(),
  locationId: IdSchema,
  locationActive: z.boolean(),
  dockFree: z.boolean(),
  reservationClear: z.boolean(),
});

export const CopilotProposedWindowSchema = z.object({
  windowStart: z.string(),
  windowEnd: z.string(),
  durationMs: z.number().int().positive(),
  anchor: z.literal("eta"),
  anchorAt: z.string(),
});
export type CopilotProposedWindow = z.infer<typeof CopilotProposedWindowSchema>;

/** Facts the recommendation was computed from. Apply rejects the action when they no longer hold. */
export const CopilotPreconditionsSchema = z.object({
  evaluatedAt: z.string(),
  trip: CopilotTripPreconditionsSchema.nullable(),
  appointment: CopilotAppointmentPreconditionsSchema.nullable(),
  dockSwap: CopilotDockSwapPreconditionsSchema.nullable(),
  proposedWindow: CopilotProposedWindowSchema.nullable(),
  manualReviewReason: z.string().nullable(),
});
export type CopilotPreconditions = z.infer<typeof CopilotPreconditionsSchema>;

export const CopilotPriorRevisionSchema = z.object({
  revision: z.number().int().positive(),
  disruptionEventId: z.number().int().nullable(),
  severity: CopilotSeveritySchema,
  lifecycle: CopilotLifecycleSchema,
  rootCause: z.string(),
  createdAt: z.string(),
});
export type CopilotPriorRevision = z.infer<typeof CopilotPriorRevisionSchema>;

export const CopilotRecommendationSchema = z.object({
  id: IdSchema,
  disruptionEventId: z.number().nullable(),
  revision: z.number().int().positive(),
  severity: CopilotSeveritySchema,
  title: z.string(),
  rootCause: z.string(),
  impactSummary: z.string(),
  prescribedActions: z.array(CopilotPrescribedActionSchema),
  preconditions: CopilotPreconditionsSchema,
  status: CopilotStatusSchema,
  lifecycle: CopilotLifecycleSchema,
  triggeringEventIds: z.array(z.number().int()),
  resolution: z.string().nullable(),
  executionError: z.string().nullable(),
  priorRevisions: z.array(CopilotPriorRevisionSchema),
  siteId: IdSchema.nullable(),
  tripId: IdSchema.nullable(),
  createdAt: z.string(),
  appliedAt: z.string().nullable(),
  /** Person who applied or dismissed the row. Null for system closes and open rows. */
  actor: z.string().nullable(),
});
export type CopilotRecommendation = z.infer<typeof CopilotRecommendationSchema>;

export const COPILOT_JOB_STATUSES = ["queued", "processing", "retry", "failed", "done"] as const;
export const CopilotJobStatusSchema = z.enum(COPILOT_JOB_STATUSES);
export type CopilotJobStatus = z.infer<typeof CopilotJobStatusSchema>;

export const CopilotJobSchema = z.object({
  id: IdSchema,
  eventId: z.number().int(),
  status: CopilotJobStatusSchema,
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.string().nullable(),
  processingError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CopilotJob = z.infer<typeof CopilotJobSchema>;

export const CopilotMonitoringSchema = z.object({
  running: z.boolean(),
  heartbeatAt: z.string().nullable(),
  lastSweepAt: z.string().nullable(),
  cursor: z.number().int().nullable(),
  backlog: z.number().int().nonnegative(),
  failedJobs: z.number().int().nonnegative(),
  monitoredEvents: z.array(z.string()),
});
export type CopilotMonitoring = z.infer<typeof CopilotMonitoringSchema>;

export const CopilotRevisionSchema = z.object({
  revision: z.number().int().positive(),
});
export type CopilotRevision = z.infer<typeof CopilotRevisionSchema>;

export const CopilotConfigSchema = z.object({
  autoPilot: z.boolean(),
});
export type CopilotConfig = z.infer<typeof CopilotConfigSchema>;

export const COPILOT_ASK_HINT =
  "Reads the live record. It cannot apply, dismiss, or change Auto\u2011Pilot.";

export const COPILOT_ASK_SUGGESTIONS = [
  "What needs me right now?",
  "Which trips are late?",
  "Which docks are free?",
  "What can Auto-Pilot do?",
] as const;

export const COPILOT_CITATION_KINDS = [
  "trip",
  "recommendation",
  "location",
  "visit",
  "order",
  "vehicle",
  "driver",
  "job",
  "appointment",
  "shipment",
  "receipt",
  "handling_unit",
  "sku",
  "site",
  "guide",
] as const;

export const CopilotCitationSchema = z.object({
  kind: z.enum(COPILOT_CITATION_KINDS),
  id: z.string(),
  label: z.string(),
});
export type CopilotCitation = z.infer<typeof CopilotCitationSchema>;

export const COPILOT_LINK_VIEWS = ["live", "dispatch", "fleet", "designer", "analytics"] as const;

/** A screen the operator can open. Built from the record, never from model text. */
export const CopilotLinkSchema = z.object({
  label: z.string().min(1).max(80),
  view: z.enum(COPILOT_LINK_VIEWS),
  focus: z.string().trim().min(1).max(80).optional(),
});
export type CopilotLink = z.infer<typeof CopilotLinkSchema>;

export const CopilotAskSchema = z.object({
  question: z.string().trim().min(1).max(500),
  siteId: z.string().trim().min(1).optional(),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(2000),
  })).max(8).optional(),
});
export type CopilotAsk = z.infer<typeof CopilotAskSchema>;

export const CopilotAnswerSchema = z.object({
  answer: z.string().min(1),
  citations: z.array(CopilotCitationSchema),
  suggestions: z.array(z.string()),
  links: z.array(CopilotLinkSchema),
});
export type CopilotAnswer = z.infer<typeof CopilotAnswerSchema>;
