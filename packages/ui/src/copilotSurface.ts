import type { CopilotMonitoring, CopilotRecommendation } from "@corelogistics/contracts";

export type StreamPhase = "connecting" | "online" | "offline";

export type CopilotSurface = "loading" | "disconnected" | "processing-failed" | "pending-review" | "pending" | "empty";

export const NO_PENDING_RECOMMENDATIONS = "No pending recommendations";

const EVENT_LABELS: Record<string, string> = {
  "trip.issue": "trip issues",
  "trip.updated": "trip updates",
  "trip.dispatched": "dispatch",
  "trip.departed": "departure",
  "trip.arrived": "arrival",
  "trip.stop_arrived": "stop arrival",
  "trip.stop_departed": "stop departure",
  "trip.completed": "completion",
  "trip.cancelled": "cancellation",
};

export function watchedSentence(events: string[] | undefined): string {
  if (!events) return "Loading the events this worker watches.";
  if (!events.length) return "This worker has not reported any watched events.";
  return `Watching ${events.map((event) => EVENT_LABELS[event] ?? event).join(", ")}.`;
}

export function surfaceOf(input: {
  recsLoading: boolean;
  recs?: CopilotRecommendation[];
  recsError: string | null;
  phase: StreamPhase;
  monitoring?: CopilotMonitoring;
  monLoading: boolean;
  monError: string | null;
}): CopilotSurface {
  if ((input.recsLoading && input.recs === undefined) || (input.monLoading && input.monitoring === undefined)) return "loading";
  if (input.recsError || input.monError || input.phase === "offline" || (input.monitoring && !input.monitoring.running)) {
    return "disconnected";
  }
  if ((input.monitoring?.failedJobs ?? 0) > 0) return "processing-failed";
  if (input.recs?.some((rec) => rec.lifecycle === "human_review")) return "pending-review";
  if (!input.recs?.length) return "empty";
  return "pending";
}

export function showsNoPending(surface: CopilotSurface): boolean {
  return surface === "empty";
}

export function disconnectedDetail(input: {
  recsError: string | null;
  monError: string | null;
  workerStopped: boolean;
  hasList: boolean;
}): string {
  if (input.recsError) return `${input.recsError} Pending recommendations were not confirmed.`;
  if (input.monError) return input.monError;
  if (input.workerStopped) return "The disruption worker is not running.";
  if (input.hasList) return "Live updates are disconnected. The list below is the last successful fetch.";
  return "Live updates are disconnected. Pending recommendations were not confirmed.";
}

export function autoEligibility(rec: CopilotRecommendation, autoOn: boolean): string {
  if (!rec.prescribedActions.length) return "Not eligible for auto-pilot. There is no executable action.";
  const rescheduleOnly = rec.prescribedActions.every((action) => action.type === "reschedule_appointment");
  if (rec.severity === "high" || rec.severity === "critical" || !rescheduleOnly) return "Needs Tower approval.";
  return autoOn ? "Eligible, and Auto-Pilot is on." : "Eligible for auto-pilot when it is on.";
}

export function actorLabel(rec: Pick<CopilotRecommendation, "actor" | "status">): string {
  if (rec.actor) return rec.actor;
  if (rec.status === "auto_applied" || rec.status === "resolved") return "System";
  return "Not recorded";
}
