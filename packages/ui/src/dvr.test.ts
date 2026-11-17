import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventRecord, GateVisit, SiteBoard } from "@corelogistics/contracts";
import { buildDvrBuckets, replaySiteState } from "./dvr.js";

function makeEvent(id: number, type: EventRecord["type"], opts: Partial<EventRecord> = {}): EventRecord {
  return {
    id,
    type,
    source: "manual",
    actor: "Ava Chen",
    siteId: "site_1",
    vehicleId: null,
    tripId: null,
    driverId: null,
    locationId: null,
    huId: null,
    entityId: null,
    message: `Event ${id}`,
    payload: {},
    occurredAt: new Date(Date.UTC(2026, 10, 17, 10, id, 0)).toISOString(),
    recordedAt: new Date(Date.UTC(2026, 10, 17, 10, id, 0)).toISOString(),
    ...opts,
  };
}

const baseBoard: SiteBoard = {
  site: {
    id: "site_1",
    code: "WH-C",
    name: "Central Warehouse",
    kind: "warehouse",
    address: "Manila",
    lat: 14.5,
    lng: 121.0,
    geofenceM: 400,
    hasLayout: true,
  },
  layout: { cols: 4, rows: 2, cells: [] },
  locations: [
    {
      id: "loc_y1",
      siteId: "site_1",
      code: "Y01",
      kind: "yard_slot",
      x: 0,
      y: 0,
      level: 1,
      zone: null,
      capacity: 1,
      occupied: 0,
      refs: [],
      since: null,
      active: true,
    },
    {
      id: "loc_d1",
      siteId: "site_1",
      code: "D01",
      kind: "dock_door",
      x: 1,
      y: 0,
      level: 1,
      zone: null,
      capacity: 1,
      occupied: 1,
      refs: ["ABC-123"],
      since: "2026-11-17T10:02:00Z",
      active: true,
    },
    {
      id: "loc_r1",
      siteId: "site_1",
      code: "R01-1",
      kind: "rack",
      x: 2,
      y: 0,
      level: 1,
      zone: "A",
      capacity: 4,
      occupied: 1,
      refs: ["HU-101"],
      since: "2026-11-17T10:03:00Z",
      active: true,
    },
  ],
};

describe("Operations DVR replay engine", () => {
  it("reconstructs prior yard, dock, and rack state when scrubbing backward", () => {
    const events: EventRecord[] = [
      makeEvent(1, "gate.check_in", { locationId: "loc_y1", tripId: "trp_1", message: "ABC-123 checked in at Y01" }),
      makeEvent(2, "dock.assigned", {
        locationId: "loc_d1",
        tripId: "trp_1",
        message: "ABC-123 to D01",
        payload: { fromLocationId: "loc_y1" },
      }),
      makeEvent(3, "putaway.done", { locationId: "loc_r1", message: "HU-101 stored in R01-1" }),
      makeEvent(4, "trip.issue", { tripId: "trp_1", message: "TRP-1 delay: Gate congestion" }),
    ];
    const liveVisits: GateVisit[] = [];

    // At cursor 0 (just after check-in): Y01 has ABC-123, D01 and R01-1 are empty
    const snap0 = replaySiteState({ liveBoard: baseBoard, liveVisits, events, cursorIndex: 0 });
    assert.equal(snap0.locations.find((l) => l.id === "loc_y1")?.occupied, 1);
    assert.equal(snap0.locations.find((l) => l.id === "loc_d1")?.occupied, 0);
    assert.equal(snap0.locations.find((l) => l.id === "loc_r1")?.occupied, 0);
    assert.equal(snap0.inYardCount, 1);
    assert.equal(snap0.atDockCount, 0);
    assert.equal(snap0.issueCount, 0);

    // At cursor 3 (latest): D01 and R01-1 occupied, 1 issue logged
    const snap3 = replaySiteState({ liveBoard: baseBoard, liveVisits, events, cursorIndex: 3 });
    assert.equal(snap3.locations.find((l) => l.id === "loc_d1")?.occupied, 1);
    assert.equal(snap3.locations.find((l) => l.id === "loc_r1")?.occupied, 1);
    assert.equal(snap3.issueCount, 1);
  });

  it("tags issue and nudge buckets cleanly for timeline markers", () => {
    const buckets = buildDvrBuckets([
      makeEvent(1, "gate.check_in"),
      makeEvent(2, "trip.issue"),
      makeEvent(3, "ops.nudge"),
    ]);
    assert.deepEqual(
      buckets.map((b) => [b.isIssue, b.isNudge]),
      [
        [false, false],
        [true, false],
        [false, true],
      ],
    );
  });
});
