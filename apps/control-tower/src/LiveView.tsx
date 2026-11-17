import {
  formatDuration,
  humanize,
  type AnalyticsSummary,
  type EventRecord,
  type GateVisit,
  type LocationStatus,
  type NudgeTargetRole,
  type SiteBoard,
  type Trip,
} from "@corelogistics/contracts";
import {
  buildDvrBuckets,
  Empty,
  ErrorNote,
  fmtDateTime,
  fromNow,
  issueReport,
  MapLegend,
  Panel,
  Pill,
  qs,
  RackInspector,
  replaySiteState,
  SendNudgeModal,
  SiteMap,
  useApi,
  useFitMapCells,
  useNow,
  WaybillModal,
  type MapCell,
  type MapLens,
  type Refs,
} from "@corelogistics/ui";
import { BellRing, FileText, History, Pause, Play, RotateCcw } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

const SiteMap3D = lazy(() => import("@corelogistics/ui").then((m) => ({ default: m.SiteMap3D })));

function formatEventTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const timeStr = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
  if (isSameDay) return timeStr;
  const monthStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${monthStr} ${timeStr}`;
}

export function LiveView({
  siteId,
  refs,
  focus,
  onOpenTrip,
  onOpenAnalytics,
}: {
  siteId: string;
  refs: Refs;
  focus?: { query: string; key: number } | null;
  onOpenTrip?: (code: string) => void;
  onOpenAnalytics?: () => void;
}) {
  const now = useNow(30_000);
  const forSite = (e: EventRecord) => !e.siteId || e.siteId === siteId;
  const board = useApi<SiteBoard>(`/sites/${siteId}/board`, {
    live: (e) =>
      forSite(e) &&
      (e.type.startsWith("gate.") ||
        e.type.startsWith("dock.") ||
        e.type.startsWith("yard.") ||
        e.type.startsWith("hu.") ||
        e.type.startsWith("putaway.") ||
        e.type === "pick.done" ||
        e.type === "layout.saved" ||
        e.type === "device.read"),
  });
  const stats = useApi<AnalyticsSummary>(`/analytics/summary${qs({ siteId, days: 1 })}`, {
    live: (e) =>
      forSite(e) &&
      (e.type.startsWith("gate.") ||
        e.type.startsWith("dock.") ||
        e.type.startsWith("trip.") ||
        e.type.startsWith("order.") ||
        e.type.startsWith("hu.") ||
        e.type.startsWith("putaway.") ||
        e.type === "pick.done" ||
        e.type === "device.read"),
  });
  const visits = useApi<GateVisit[]>(`/gate/visits${qs({ siteId, open: "true" })}`, {
    live: (e) =>
      forSite(e) &&
      (e.type.startsWith("gate.") || e.type.startsWith("dock.") || e.type.startsWith("yard.") || e.type === "device.read"),
  });
  const trips = useApi<Trip[]>(`/trips${qs({ siteId, active: "true" })}`, {
    live: (e) => e.type.startsWith("trip.") || e.type === "gate.check_in" || e.type === "gate.check_out" || e.type === "device.read",
  });
  const events = useApi<EventRecord[]>(`/events${qs({ siteId, limit: 40 })}`, { live: forSite });
  const reports = useApi<EventRecord[]>("/events?type=trip.issue&limit=6", {
    live: (e) => e.type === "trip.issue",
  });
  const [lens, setLens] = useState<MapLens>("standard");
  const [isometric, setIsometric] = useState(false);
  const [dvrActive, setDvrActive] = useState(false);
  const [dvrCursor, setDvrCursor] = useState<number | null>(null);
  const [dvrPlaying, setDvrPlaying] = useState(false);
  const [dvrSpeed, setDvrSpeed] = useState<1 | 4 | 10>(4);
  const [nudgeTarget, setNudgeTarget] = useState<{
    targetRole: NudgeTargetRole;
    driverId?: string | null;
    tripId?: string | null;
    locationCode?: string | null;
  } | null>(null);
  const [waybillTripId, setWaybillTripId] = useState<string | null>(null);
  const dvrEventsApi = useApi<EventRecord[]>(
    dvrActive ? `/events${qs({ siteId, limit: 200 })}` : null,
    { live: false },
  );
  const [selected, setSelected] = useState<{ cell: MapCell; locs: LocationStatus[] } | null>(null);
  const appliedFocus = useRef<number | null>(null);

  const dvrChrono = useMemo(
    () => [...(dvrEventsApi.data ?? [])].reverse(),
    [dvrEventsApi.data],
  );
  const effectiveCursor =
    dvrActive && dvrChrono.length
      ? Math.max(0, Math.min(dvrChrono.length - 1, dvrCursor ?? dvrChrono.length - 1))
      : 0;
  const dvrBuckets = useMemo(() => buildDvrBuckets(dvrChrono), [dvrChrono]);
  const dvrSnapshot = useMemo(() => {
    if (!dvrActive || !board.data || !dvrChrono.length) return null;
    return replaySiteState({
      liveBoard: board.data,
      liveVisits: visits.data ?? [],
      events: dvrChrono,
      cursorIndex: effectiveCursor,
    });
  }, [dvrActive, board.data, visits.data, dvrChrono, effectiveCursor]);

  useEffect(() => {
    if (!dvrActive || !dvrPlaying || !dvrChrono.length) return;
    const ms = dvrSpeed === 10 ? 180 : dvrSpeed === 4 ? 380 : 900;
    const timer = window.setInterval(() => {
      setDvrCursor((prev) => {
        const cur = prev ?? 0;
        if (cur >= dvrChrono.length - 1) {
          setDvrPlaying(false);
          return dvrChrono.length - 1;
        }
        return cur + 1;
      });
    }, ms);
    return () => window.clearInterval(timer);
  }, [dvrActive, dvrPlaying, dvrSpeed, dvrChrono.length]);

  useEffect(() => {
    if (!focus?.query || !board.data || appliedFocus.current === focus.key) return;
    appliedFocus.current = focus.key;
    const needle = focus.query.toLowerCase();
    const loc =
      board.data.locations.find((item) => item.code.toLowerCase() === needle) ??
      board.data.locations.find((item) => item.refs.some((ref) => ref.toLowerCase() === needle));
    if (!loc) return;
    const cell = board.data.layout.cells.find((item) => item.x === loc.x && item.y === loc.y);
    if (!cell) return;
    const locs = board.data.locations.filter((item) => item.x === loc.x && item.y === loc.y);
    setSelected({ cell, locs });
  }, [focus?.key, focus?.query, board.data]);

  const s = stats.data;
  const layout = board.data?.layout;
  const { ref: mapRef, cell } = useFitMapCells(layout?.cols ?? 0, layout?.rows ?? 0);
  const shownLocations = dvrSnapshot ? dvrSnapshot.locations : board.data?.locations ?? [];
  const shownEvents = dvrSnapshot ? dvrSnapshot.eventsUpToCursor.slice(0, 40) : events.data;
  const shownNow = dvrSnapshot ? Date.parse(dvrSnapshot.occurredAt) || now : now;
  const selectedVisit =
    selected &&
    visits.data?.find(
      (v) =>
        selected.locs.some((l) => l.id === v.yardLocationId) ||
        selected.locs.some((l) => l.id === v.dock?.locationId),
    );

  const openDvr = () => {
    setDvrActive(true);
    setDvrPlaying(false);
    setDvrCursor(null);
  };
  const closeDvr = () => {
    setDvrActive(false);
    setDvrPlaying(false);
    setDvrCursor(null);
  };

  return (
    <div className="three live-board">
      <div className="stack" style={{ overflow: "auto" }}>
        <div className="live-kpi-grid">
          <div className="live-kpi-card">
            <div className="live-kpi-header">
              <span className="live-kpi-label">IN YARD</span>
              <svg
                className="live-kpi-icon"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="1" y="3" width="15" height="13" rx="1" />
                <polygon points="16 8 20 8 23 11 23 16 16 16 16 8" />
                <circle cx="5.5" cy="18.5" r="2.5" />
                <circle cx="18.5" cy="18.5" r="2.5" />
              </svg>
            </div>
            <div className="live-kpi-value">{dvrSnapshot ? dvrSnapshot.inYardCount : (s?.yard.inYard ?? 0)}</div>
            <div className="live-kpi-hint">
              {dvrSnapshot
                ? "DVR snapshot"
                : `Longest ${s?.yard.maxCurrentDwellMinutes ? formatDuration(s.yard.maxCurrentDwellMinutes) : "—"}`}
            </div>
          </div>

          <div className="live-kpi-card">
            <div className="live-kpi-header">
              <span className="live-kpi-label">AT DOCK</span>
            </div>
            <div className="live-kpi-value">{dvrSnapshot ? dvrSnapshot.atDockCount : (s?.yard.atDock ?? 0)}</div>
            <div className="live-kpi-hint">
              {dvrSnapshot
                ? "Doors busy"
                : `Turnaround ${s?.turnaroundMinutes ? formatDuration(s.turnaroundMinutes) : "—"}`}
            </div>
          </div>

          <div className="live-kpi-card is-active-trips">
            <div className="live-kpi-header">
              <span className="live-kpi-label">ACTIVE TRIPS</span>
            </div>
            <div className="live-kpi-value color-blue">{dvrSnapshot ? dvrSnapshot.activeTripCount : (s?.trips.active ?? 0)}</div>
          </div>

          <div className="live-kpi-card is-delayed">
            <div className="live-kpi-header">
              <span className="live-kpi-label">{dvrSnapshot ? "ISSUES" : "DELAYED"}</span>
            </div>
            <div className="live-kpi-value color-red">{dvrSnapshot ? dvrSnapshot.issueCount : (s?.trips.delayed ?? 0)}</div>
          </div>
        </div>

        {s && !dvrSnapshot ? (
          <button
            type="button"
            className="on-site-truck-card"
            style={{ padding: "10px 12px", textAlign: "left", cursor: "pointer", width: "100%" }}
            onClick={() => onOpenAnalytics?.()}
            title="Open Financial & FEFO Risk Radar in Analytics"
          >
            <div className="row-between">
              <span className="live-kpi-label">EXPOSURE &amp; FEFO</span>
              <span className="mono strong" style={{ color: "var(--danger)", fontSize: 13 }}>
                ₱
                {Math.round(
                  s.risk.delayPenaltyExposure + s.risk.yardDetentionExposure + s.risk.atRiskInventoryValue,
                ).toLocaleString("en-US")}
              </span>
            </div>
            <div className="row-between" style={{ marginTop: 3 }}>
              <span className="on-site-truck-meta">
                {s.risk.expiredCount} expired · {s.risk.expiringSoonCount} ≤14d
              </span>
              <span className="small" style={{ color: "var(--accent)", fontWeight: 600 }}>
                Radar →
              </span>
            </div>
          </button>
        ) : null}

        <Panel title="On site now" scroll className="grow">
          {visits.data?.length ? (
            <div className="on-site-truck-list">
              {visits.data.map((v) => {
                const isInYard = v.status === "in_yard" || !v.dock;
                return (
                  <div key={v.id} className="on-site-truck-card">
                    <div className="on-site-truck-row">
                      <span className="on-site-truck-plate">{v.plate}</span>
                      <span className={`on-site-badge ${isInYard ? "is-in-yard" : "is-at-dock"}`}>
                        <span className="on-site-badge-dot" />
                        {isInYard ? "In yard" : "At dock"}
                      </span>
                    </div>
                    <div className="on-site-truck-meta">
                      {v.dock
                        ? `Dock ${v.dock.code} · ${v.dock.purpose || "Active"}`
                        : v.yardCode
                          ? `Yard ${v.yardCode}`
                          : "In yard"}
                      {" · "}
                      {formatDuration(v.dwellMinutes)} on site
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty>No vehicles on site</Empty>
          )}
        </Panel>
      </div>

      <Panel
        title={board.data ? `${board.data.site.code} · ${board.data.site.name}` : "Site"}
        actions={
          <div className="map-toolbar">
            {dvrActive ? <Pill value="DVR REPLAY" tone="warn" /> : null}
            <div className="segmented" role="group" aria-label="Map visualization lens">
              {(["standard", "heat", "flow"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={lens === mode ? "is-on" : ""}
                  onClick={() => setLens(mode)}
                >
                  {mode === "standard" ? "Standard" : mode === "heat" ? "Heat" : "Flow"}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`btn btn-sm ${isometric ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setIsometric((v) => !v)}
              title="Toggle 3D warehouse & yard digital twin"
            >
              3D Twin
            </button>
            <button
              type="button"
              className={`btn btn-sm ${dvrActive ? "btn-primary" : "btn-ghost"}`}
              onClick={() => (dvrActive ? closeDvr() : openDvr())}
              title="Scrub and replay historical site activity"
            >
              <History size={13} /> DVR Replay
            </button>
            <MapLegend />
          </div>
        }
        className="grow live-map-panel"
      >
        <ErrorNote error={board.error} />
        {board.data && board.data.layout.cells.length ? (
          isometric ? (
            <div className="map-wrap live-map-wrap" style={{ padding: 4 }}>
              <Suspense fallback={<Empty>Loading 3D twin…</Empty>}>
                <SiteMap3D
                  layout={board.data.layout}
                  locations={shownLocations}
                  now={shownNow}
                  lens={lens}
                  highlight={dvrSnapshot ? dvrSnapshot.highlightedLocationIds : undefined}
                  selectedKey={selected ? `${selected.cell.x}:${selected.cell.y}` : null}
                  onCellClick={(c, locs) => setSelected(locs.length ? { cell: c, locs } : null)}
                />
              </Suspense>
            </div>
          ) : (
            <div className="map-wrap live-map-wrap" ref={mapRef}>
              <SiteMap
                layout={board.data.layout}
                locations={shownLocations}
                now={shownNow}
                lens={lens}
                highlight={dvrSnapshot ? dvrSnapshot.highlightedLocationIds : undefined}
                cellWidth={cell.w}
                cellHeight={cell.h}
                selectedKey={selected ? `${selected.cell.x}:${selected.cell.y}` : null}
                onCellClick={(cell, locs) => setSelected(locs.length ? { cell, locs } : null)}
              />
            </div>
          )
        ) : board.data ? (
          <Empty>This site has no layout yet. Draw one in the Site designer.</Empty>
        ) : null}
        {dvrActive ? (
          <div className="dvr-bar is-replaying">
            <div className="dvr-bar-top">
              <div className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!dvrChrono.length}
                  onClick={() => {
                    if (!dvrPlaying && effectiveCursor >= dvrChrono.length - 1) setDvrCursor(0);
                    setDvrPlaying((p) => !p);
                  }}
                >
                  {dvrPlaying ? <Pause size={13} /> : <Play size={13} />}
                  {dvrPlaying ? "Pause" : "Play"}
                </button>
                <div className="segmented" role="group" aria-label="Replay speed">
                  {([1, 4, 10] as const).map((sp) => (
                    <button key={sp} type="button" className={dvrSpeed === sp ? "is-on" : ""} onClick={() => setDvrSpeed(sp)}>
                      {sp}x
                    </button>
                  ))}
                </div>
                <span className="mono small strong">
                  {dvrSnapshot?.activeEvent ? fmtDateTime(dvrSnapshot.activeEvent.occurredAt) : "No events"}
                </span>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={closeDvr}>
                <RotateCcw size={13} /> Back to Live
              </button>
            </div>
            {dvrChrono.length ? (
              <div className="dvr-scrubber-wrap">
                <div className="dvr-ticks" aria-hidden="true">
                  {dvrBuckets.map((b) =>
                    b.isIssue || b.isNudge ? (
                      <span
                        key={b.index}
                        className={`dvr-tick ${b.isIssue ? "is-issue" : "is-nudge"}`}
                        style={{ left: `${(b.index / Math.max(1, dvrChrono.length - 1)) * 100}%` }}
                      />
                    ) : null,
                  )}
                </div>
                <input
                  type="range"
                  className="dvr-range"
                  min={0}
                  max={Math.max(0, dvrChrono.length - 1)}
                  value={effectiveCursor}
                  aria-label="Operations DVR timeline scrubber"
                  onChange={(e) => {
                    setDvrPlaying(false);
                    setDvrCursor(Number(e.target.value));
                  }}
                />
                <div className="row-between small muted">
                  <span className="mono">
                    Event {effectiveCursor + 1} / {dvrChrono.length}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "70%" }}>
                    {dvrSnapshot?.activeEvent?.message ?? ""}
                  </span>
                </div>
              </div>
            ) : (
              <span className="muted small">Loading site event history…</span>
            )}
          </div>
        ) : null}
      </Panel>

      <div className="stack live-rail">
        {reports.data?.length ? (
          <Panel title="Driver reports">
            <div className="driver-report-list">
              {reports.data.slice(0, 4).map((event) => {
                const report = issueReport(event);
                if (!report) return null;
                return (
                  <button
                    key={event.id}
                    type="button"
                    className={`driver-report is-${report.tone}`}
                    onClick={() => report.code && onOpenTrip?.(report.code)}
                  >
                    <span className="driver-report-top">
                      <span className="driver-report-kind">{humanize(report.kind)}</span>
                      <span className="driver-report-code">{report.code}</span>
                      <span className="driver-report-time">{formatEventTime(event.occurredAt)}</span>
                    </span>
                    <span className="driver-report-text">{report.text}</span>
                    {event.actor ? <span className="driver-report-actor">{event.actor}</span> : null}
                  </button>
                );
              })}
            </div>
          </Panel>
        ) : null}
        {selected ? (
          <Panel
            title={`${humanize(selected.cell.kind)} ${selected.locs[0]?.code.replace(/-\d+$/, "") ?? ""}`}
            actions={
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  setNudgeTarget({
                    targetRole: selected.cell.kind === "yard_slot" || selected.cell.kind === "gate" ? "gate" : "warehouse",
                    locationCode: selected.locs[0]?.code.replace(/-\d+$/, "") ?? null,
                    tripId: selectedVisit?.tripId ?? null,
                  })
                }
              >
                <BellRing size={13} /> Nudge
              </button>
            }
          >
            {selectedVisit ? (
              <dl className="kv">
                <dt>Vehicle</dt>
                <dd className="mono">{selectedVisit.plate}</dd>
                <dt>Trip</dt>
                <dd>{selectedVisit.tripCode ?? "—"}</dd>
                <dt>Checked in</dt>
                <dd>
                  {fmtDateTime(selectedVisit.checkInAt)} ({formatDuration(selectedVisit.dwellMinutes)})
                </dd>
                {selectedVisit.dock ? (
                  <>
                    <dt>At dock since</dt>
                    <dd>{fmtDateTime(selectedVisit.dock.assignedAt)}</dd>
                  </>
                ) : null}
              </dl>
            ) : (
              <RackInspector locs={selected.locs} />
            )}
          </Panel>
        ) : null}

        <Panel title="Trips touching this site" scroll className="live-trips-panel">
          {trips.data?.length ? (
            <div className="live-trips-list">
              {trips.data.map((t) => (
                <div key={t.id} className="live-trip-card">
                  <div className="live-trip-header">
                    <span className="live-trip-code">{t.code}</span>
                    <div className="live-trip-badges">
                      {t.delayed ? (
                        <span className="live-badge-delay">⏱ +{t.delayMinutes}m</span>
                      ) : null}
                      <span className="live-badge-status">
                        <span className="badge-dot" />
                        {humanize(t.status)}
                      </span>
                    </div>
                  </div>
                  <div className="live-trip-route">
                    {refs.siteCode(t.originSiteId)} → {refs.siteCode(t.destinationSiteId)} · {refs.plate(t.vehicleId)}
                  </div>
                  <div className="row-between" style={{ marginTop: 4, gap: 6 }}>
                    <div className="live-trip-time">
                      {t.status === "in_transit"
                        ? `ETA ${fmtDateTime(t.etaAt)} (${fromNow(t.etaAt, now)})`
                        : `Departs ${fmtDateTime(t.plannedDeparture)}`}
                    </div>
                    <div className="row" style={{ gap: 4 }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setWaybillTripId(t.id)}
                        title="Open printable Waybill & e-POD"
                      >
                        <FileText size={12} /> Waybill
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() =>
                          setNudgeTarget({
                            targetRole: t.status === "in_transit" ? "driver" : "warehouse",
                            driverId: t.driverId,
                            tripId: t.id,
                            locationCode: t.code,
                          })
                        }
                        title="Tap & Nudge assigned team"
                      >
                        <BellRing size={12} /> Nudge
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>No active trips</Empty>
          )}
        </Panel>

        <Panel title={dvrSnapshot ? "Activity (DVR)" : "Activity"} scroll className="grow">
          {shownEvents?.length ? (
            <div className="activity-timeline-list">
              {shownEvents.map((e) => (
                <div key={e.id} className={`activity-timeline-row${e.type === "trip.issue" ? ` is-issue is-${issueReport(e)?.tone ?? "warn"}` : ""}`}>
                  <span className="activity-time">{formatEventTime(e.occurredAt)}</span>
                  <span className="activity-sep">|</span>
                  <span className="activity-msg">
                    {e.message}
                    {e.actor ? <span className="activity-actor"> · {e.actor}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty>No events yet</Empty>
          )}
        </Panel>
      </div>
      {nudgeTarget ? (
        <SendNudgeModal
          targetRole={nudgeTarget.targetRole}
          siteId={siteId}
          driverId={nudgeTarget.driverId}
          tripId={nudgeTarget.tripId}
          locationCode={nudgeTarget.locationCode}
          onClose={() => setNudgeTarget(null)}
        />
      ) : null}
      {waybillTripId ? <WaybillModal tripId={waybillTripId} onClose={() => setWaybillTripId(null)} /> : null}
    </div>
  );
}
