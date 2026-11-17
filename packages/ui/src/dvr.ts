import type { EventRecord, GateVisit, LocationStatus, SiteBoard } from "@corelogistics/contracts";

export interface DvrBucket {
  index: number;
  occurredAt: string;
  isIssue: boolean;
  isNudge: boolean;
  type: EventRecord["type"];
}

export interface DvrSnapshot {
  occurredAt: string;
  cursorIndex: number;
  activeEvent: EventRecord | null;
  locations: LocationStatus[];
  inYardCount: number;
  atDockCount: number;
  activeTripCount: number;
  issueCount: number;
  highlightedLocationIds: string[];
  eventsUpToCursor: EventRecord[];
}

function cloneLocations(locations: LocationStatus[]): Map<string, LocationStatus> {
  const map = new Map<string, LocationStatus>();
  for (const l of locations) {
    map.set(l.id, { ...l, refs: [...l.refs] });
  }
  return map;
}

function addRef(loc: LocationStatus | undefined, ref: string, since?: string | null) {
  if (!loc) return;
  if (ref && !loc.refs.includes(ref)) loc.refs.push(ref);
  loc.occupied = Math.min(loc.capacity || loc.occupied + 1, Math.max(loc.occupied + 1, loc.refs.length));
  if (since && !loc.since) loc.since = since;
}

function removeRef(loc: LocationStatus | undefined, ref?: string) {
  if (!loc) return;
  if (ref) {
    const idx = loc.refs.indexOf(ref);
    if (idx >= 0) loc.refs.splice(idx, 1);
  } else if (loc.refs.length > 0) {
    loc.refs.pop();
  }
  loc.occupied = Math.max(0, Math.min(loc.occupied - 1, loc.refs.length));
  if (loc.occupied === 0) loc.since = null;
}

function extractPlate(message: string): string {
  const first = message.split(/\s+/)[0]?.trim() ?? "";
  return first;
}

/**
 * Reconstructs the site's spatial board state at a specific historical event index
 * by walking backward from the live board over events after `cursorIndex`.
 */
export function replaySiteState(params: {
  liveBoard: SiteBoard;
  liveVisits: GateVisit[];
  events: EventRecord[];
  cursorIndex: number;
}): DvrSnapshot {
  const { liveBoard, liveVisits, events } = params;
  if (!events.length) {
    return {
      occurredAt: new Date().toISOString(),
      cursorIndex: 0,
      activeEvent: null,
      locations: liveBoard.locations,
      inYardCount: liveVisits.filter((v) => v.status === "in_yard" || !v.dock).length,
      atDockCount: liveVisits.filter((v) => Boolean(v.dock)).length,
      activeTripCount: 0,
      issueCount: 0,
      highlightedLocationIds: [],
      eventsUpToCursor: [],
    };
  }

  const clamped = Math.max(0, Math.min(events.length - 1, params.cursorIndex));
  const locs = cloneLocations(liveBoard.locations);
  const byId = locs;

  // Walk backward from newest event down to clamped + 1 to undo newer transitions
  for (let i = events.length - 1; i > clamped; i--) {
    const ev = events[i]!;
    const plate = extractPlate(ev.message);

    if (ev.type === "gate.check_in") {
      if (ev.locationId) removeRef(byId.get(ev.locationId), plate || undefined);
    } else if (ev.type === "gate.check_out") {
      // Undo check-out by restoring presence at its last known yard/dock if locationId was logged
      if (ev.locationId) addRef(byId.get(ev.locationId), plate, ev.occurredAt);
    } else if (ev.type === "dock.assigned") {
      if (ev.locationId) removeRef(byId.get(ev.locationId), plate || undefined);
      const prevYardId = typeof ev.payload?.fromLocationId === "string" ? ev.payload.fromLocationId : null;
      if (prevYardId) addRef(byId.get(prevYardId), plate, ev.occurredAt);
    } else if (ev.type === "dock.released") {
      if (ev.locationId) addRef(byId.get(ev.locationId), plate, ev.occurredAt);
    } else if (ev.type === "yard.moved") {
      if (ev.locationId) removeRef(byId.get(ev.locationId), plate || undefined);
    } else if (ev.type === "putaway.done" || ev.type === "hu.sorted" || ev.type === "hu.received") {
      if (ev.locationId) removeRef(byId.get(ev.locationId));
    } else if (ev.type === "pick.done" || ev.type === "hu.loaded") {
      if (ev.locationId) addRef(byId.get(ev.locationId), typeof ev.payload?.huCode === "string" ? ev.payload.huCode : "HU", ev.occurredAt);
    }
  }

  const reconstructed = Array.from(byId.values());
  let inYardCount = 0;
  let atDockCount = 0;
  for (const loc of reconstructed) {
    if (loc.kind === "yard_slot" && loc.occupied > 0) inYardCount += 1;
    if (loc.kind === "dock_door" && loc.occupied > 0) atDockCount += 1;
  }

  const upTo = events.slice(0, clamped + 1);
  const activeTripIds = new Set<string>();
  let issueCount = 0;
  for (const ev of upTo) {
    if (ev.tripId) {
      if (ev.type === "trip.completed" || ev.type === "trip.cancelled") {
        activeTripIds.delete(ev.tripId);
      } else if (ev.type.startsWith("trip.") || ev.type === "gate.check_in") {
        activeTripIds.add(ev.tripId);
      }
    }
    if (ev.type === "trip.issue") issueCount += 1;
  }

  const activeEvent = events[clamped] ?? null;
  const highlightedLocationIds = activeEvent?.locationId ? [activeEvent.locationId] : [];

  return {
    occurredAt: activeEvent?.occurredAt ?? new Date().toISOString(),
    cursorIndex: clamped,
    activeEvent,
    locations: reconstructed,
    inYardCount,
    atDockCount,
    activeTripCount: activeTripIds.size,
    issueCount,
    highlightedLocationIds,
    eventsUpToCursor: [...upTo].reverse(),
  };
}

export function buildDvrBuckets(events: EventRecord[]): DvrBucket[] {
  return events.map((ev, index) => ({
    index,
    occurredAt: ev.occurredAt,
    isIssue: ev.type === "trip.issue" || ev.type === "copilot.failed",
    isNudge: ev.type === "ops.nudge" || ev.type === "ops.nudge_ack",
    type: ev.type,
  }));
}
