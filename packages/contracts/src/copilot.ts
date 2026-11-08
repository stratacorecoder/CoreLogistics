import { z } from "zod";
import { IdSchema } from "./common.js";

export const COPILOT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const CopilotSeveritySchema = z.enum(COPILOT_SEVERITIES);
export type CopilotSeverity = z.infer<typeof CopilotSeveritySchema>;

export const COPILOT_ACTION_TYPES = [
  "swap_dock",
  "reschedule_appointment",
  "resequence_pick",
  "reroute_crossdock",
] as const;
export const CopilotActionTypeSchema = z.enum(COPILOT_ACTION_TYPES);
export type CopilotActionType = z.infer<typeof CopilotActionTypeSchema>;

export const COPILOT_STATUSES = ["pending", "applied", "dismissed", "auto_applied"] as const;
export const CopilotStatusSchema = z.enum(COPILOT_STATUSES);
export type CopilotStatus = z.infer<typeof CopilotStatusSchema>;

export const CopilotPrescribedActionSchema = z.object({
  type: CopilotActionTypeSchema,
  targetId: z.string(),
  description: z.string(),
  payload: z.record(z.unknown()),
});
export type CopilotPrescribedAction = z.infer<typeof CopilotPrescribedActionSchema>;

export const CopilotRecommendationSchema = z.object({
  id: IdSchema,
  disruptionEventId: z.number().nullable(),
  severity: CopilotSeveritySchema,
  title: z.string(),
  rootCause: z.string(),
  impactSummary: z.string(),
  prescribedActions: z.array(CopilotPrescribedActionSchema),
  status: CopilotStatusSchema,
  siteId: IdSchema.nullable(),
  tripId: IdSchema.nullable(),
  createdAt: z.string(),
  appliedAt: z.string().nullable(),
});
export type CopilotRecommendation = z.infer<typeof CopilotRecommendationSchema>;

export const CopilotConfigSchema = z.object({
  autoPilot: z.boolean(),
});
export type CopilotConfig = z.infer<typeof CopilotConfigSchema>;
