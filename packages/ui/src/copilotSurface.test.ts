import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CopilotMonitoring, CopilotRecommendation } from "@corelogistics/contracts";
import {
  actorLabel,
  autoEligibility,
  disconnectedDetail,
  NO_PENDING_RECOMMENDATIONS,
  showsNoPending,
  surfaceOf,
  watchedSentence,
} from "./copilotSurface.js";

const monitored = [
  "trip.issue",
  "trip.updated",
  "trip.dispatched",
  "trip.departed",
  "trip.arrived",
  "trip.stop_arrived",
  "trip.stop_departed",
  "trip.completed",
  "trip.cancelled",
];

function monitoring(patch: Partial<CopilotMonitoring> = {}): CopilotMonitoring {
  return {
    running: true,
    heartbeatAt: "2026-11-09T00:00:00.000Z",
    lastSweepAt: "2026-11-09T00:00:00.000Z",
    cursor: 1,
    backlog: 0,
    failedJobs: 0,
    monitoredEvents: monitored,
    ...patch,
  };
}

function rec(patch: Partial<CopilotRecommendation>): CopilotRecommendation {
  return {
    id: "rec",
    revision: 1,
    status: "pending",
    lifecycle: "pending",
    severity: "low",
    title: "Delay",
    rootCause: "Late departure",
    impactSummary: "Dock wait",
    prescribedActions: [],
    preconditions: { proposedWindow: null, manualReviewReason: null },
    priorRevisions: [],
    triggeringEventIds: [],
    resolution: null,
    executionError: null,
    siteId: "site",
    tripId: "trip",
    createdAt: "2026-11-09T00:00:00.000Z",
    appliedAt: null,
    actor: null,
    ...patch,
  } as CopilotRecommendation;
}

describe("Copilot monitoring surfaces", () => {
  const base = {
    recsLoading: false,
    recs: [] as CopilotRecommendation[],
    recsError: null,
    phase: "online" as const,
    monitoring: monitoring(),
    monLoading: false,
    monError: null,
  };

  it("keeps loading, a connecting stream, and a failed fetch distinct from an empty result", () => {
    assert.equal(surfaceOf({ ...base, recsLoading: true, recs: undefined, monitoring: undefined, monLoading: true }), "loading");
    assert.equal(surfaceOf({ ...base, phase: "connecting" }), "empty");
    assert.equal(showsNoPending(surfaceOf({ ...base, phase: "connecting" })), true);
    assert.equal(surfaceOf({ ...base, recsError: "Failed to fetch", recs: undefined }), "disconnected");
    assert.equal(showsNoPending(surfaceOf({ ...base, recsError: "Failed to fetch", recs: undefined })), false);
    assert.equal(surfaceOf({ ...base, phase: "offline" }), "disconnected");
    assert.equal(showsNoPending(surfaceOf({ ...base, phase: "offline" })), false);
    assert.match(disconnectedDetail({ recsError: "Failed to fetch", monError: null, workerStopped: false, hasList: false }), /not confirmed/);
    assert.match(disconnectedDetail({ recsError: null, monError: null, workerStopped: false, hasList: true }), /last successful fetch/);
    assert.equal(NO_PENDING_RECOMMENDATIONS, "No pending recommendations");
    assert.equal(showsNoPending("empty"), true);
    assert.equal(showsNoPending("disconnected"), false);
  });

  it("ranks a stopped worker, failed jobs, and human review ahead of the pending count", () => {
    assert.equal(surfaceOf({ ...base, monitoring: monitoring({ running: false }) }), "disconnected");
    assert.equal(surfaceOf({ ...base, monitoring: monitoring({ failedJobs: 2 }), recs: [rec({ lifecycle: "human_review" })] }), "processing-failed");
    assert.equal(surfaceOf({ ...base, recs: [rec({ lifecycle: "human_review" }), rec({ id: "rec-2", prescribedActions: [{ type: "reschedule_appointment" }] as CopilotRecommendation["prescribedActions"] })] }), "pending-review");
    assert.equal(surfaceOf({ ...base, recs: [rec({ prescribedActions: [{ type: "reschedule_appointment" }] as CopilotRecommendation["prescribedActions"] })] }), "pending");
  });

  it("describes only the events the worker reports, and the real auto-pilot rule", () => {
    const sentence = watchedSentence(monitored);
    assert.match(sentence, /trip issues, trip updates, dispatch, departure, arrival, stop arrival, stop departure, completion, cancellation/);
    assert.equal(/telematics|gate check-in|dock door/i.test(sentence), false);
    assert.match(autoEligibility(rec({}), false), /no executable action/);
    assert.match(autoEligibility(rec({ severity: "high", prescribedActions: [{ type: "reschedule_appointment" }] as CopilotRecommendation["prescribedActions"] }), true), /Tower approval/);
    assert.match(autoEligibility(rec({ severity: "low", prescribedActions: [{ type: "swap_dock" }] as CopilotRecommendation["prescribedActions"] }), true), /Tower approval/);
    assert.match(autoEligibility(rec({ severity: "medium", prescribedActions: [{ type: "reschedule_appointment" }] as CopilotRecommendation["prescribedActions"] }), false), /when it is on/);
    assert.match(autoEligibility(rec({ severity: "low", prescribedActions: [{ type: "reschedule_appointment" }] as CopilotRecommendation["prescribedActions"] }), true), /Auto-Pilot is on/);
    assert.equal(actorLabel(rec({ status: "auto_applied" })), "System");
    assert.equal(actorLabel(rec({ status: "resolved" })), "System");
    assert.equal(actorLabel(rec({ status: "applied" })), "Not recorded");
    assert.equal(actorLabel(rec({ status: "dismissed", actor: "Ava Chen" })), "Ava Chen");
  });
});
