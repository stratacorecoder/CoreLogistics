import { formatDuration, minutesBetween, type EventRecord, type Trip } from "@corelogistics/contracts";
import { fmtTime } from "./format.js";
import type { Refs } from "./refs.js";

export interface JourneyStage {
  key: string;
  label: string;
  state: "done" | "active" | "pending" | "delayed";
  time: string;
  meta: string;
}

export function buildTripJourney(trip: Trip, events: EventRecord[] = [], refs?: Refs): JourneyStage[] {
  const byType = new Map<string, EventRecord>();
  for (const e of events) {
    if (!byType.has(e.type)) byType.set(e.type, e);
  }
  const hasIssue = events.some((e) => e.type === "trip.issue");
  const actorOf = (type: string) => byType.get(type)?.actor ?? null;

  const legGap = (start: string | null, end: string | null) => {
    if (!start || !end) return null;
    const mins = Math.max(0, minutesBetween(start, end));
    return formatDuration(mins);
  };

  const dispatchedEv = byType.get("trip.dispatched");
  const departedAt = trip.actualDeparture;
  const arrivedAt = trip.actualArrival;
  const completedAt = trip.completedAt;

  const stages: JourneyStage[] = [
    {
      key: "planned",
      label: "1. Planned",
      state: "done",
      time: fmtTime(trip.createdAt),
      meta: `${refs ? refs.siteCode(trip.originSiteId) : "Origin"} · ${actorOf("trip.created") ?? "Control Tower"}`,
    },
    {
      key: "dispatched",
      label: "2. Dispatched",
      state: trip.status === "planned" ? "active" : trip.status === "cancelled" ? "pending" : "done",
      time: dispatchedEv ? fmtTime(dispatchedEv.occurredAt) : fmtTime(trip.plannedDeparture),
      meta: trip.vehicleId && refs ? refs.plate(trip.vehicleId) : "Awaiting assets",
    },
    {
      key: "departed",
      label: "3. Departed",
      state: departedAt ? "done" : trip.status === "dispatched" ? "active" : "pending",
      time: departedAt ? fmtTime(departedAt) : `Plan ${fmtTime(trip.plannedDeparture)}`,
      meta: departedAt
        ? actorOf("trip.departed") ?? "Driver"
        : trip.delayed && trip.status === "dispatched"
          ? `+${trip.delayMinutes}m late`
          : "At origin",
    },
    {
      key: "transit",
      label: "4. In Transit",
      state:
        trip.status === "in_transit"
          ? trip.delayed || hasIssue
            ? "delayed"
            : "active"
          : arrivedAt || completedAt
            ? "done"
            : "pending",
      time: trip.etaAt && trip.status === "in_transit" ? `ETA ${fmtTime(trip.etaAt)}` : legGap(departedAt, arrivedAt) ?? "—",
      meta:
        trip.stops.length > 0
          ? `${trip.stops.filter((s) => s.arrivedAt).length}/${trip.stops.length} stops`
          : trip.delayed
            ? `+${trip.delayMinutes}m delay`
            : "Direct leg",
    },
    {
      key: "arrived",
      label: "5. Arrived",
      state: arrivedAt ? "done" : trip.status === "in_transit" ? "pending" : "pending",
      time: arrivedAt ? fmtTime(arrivedAt) : `Plan ${fmtTime(trip.plannedArrival)}`,
      meta: refs ? refs.siteCode(trip.destinationSiteId) : "Destination",
    },
    {
      key: "delivered",
      label: "6. Delivered",
      state: completedAt ? "done" : trip.status === "arrived" ? "active" : "pending",
      time: completedAt ? fmtTime(completedAt) : "Awaiting e-POD",
      meta: trip.podRecipient ? `Signed: ${trip.podRecipient}` : legGap(arrivedAt, completedAt) ?? "POD pending",
    },
  ];

  return stages;
}

export function JourneyRibbon({ stages }: { stages: JourneyStage[] }) {
  return (
    <div className="journey-ribbon">
      {stages.map((stage) => (
        <div key={stage.key} className={`journey-stage is-${stage.state}`}>
          <span className="journey-stage-label">{stage.label}</span>
          <span className="journey-stage-time">{stage.time}</span>
          <span className="journey-stage-meta">{stage.meta}</span>
        </div>
      ))}
    </div>
  );
}
