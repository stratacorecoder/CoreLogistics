import {
  formatDuration,
  humanize,
  type AnalyticsSummary,
  type EventRecord,
  type GateVisit,
  type LocationStatus,
  type SiteBoard,
  type Trip,
} from "@corelogistics/contracts";
import {
  Empty,
  ErrorNote,
  fmtDateTime,
  fromNow,
  MapLegend,
  Panel,
  SiteMap,
  qs,
  useApi,
  useNow,
  type MapCell,
  type Refs,
} from "@corelogistics/ui";
import { useState } from "react";

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

export function LiveView({ siteId, refs }: { siteId: string; refs: Refs }) {
  const now = useNow(30_000);
  const board = useApi<SiteBoard>(`/sites/${siteId}/board`);
  const stats = useApi<AnalyticsSummary>(`/analytics/summary${qs({ siteId, days: 1 })}`);
  const visits = useApi<GateVisit[]>(`/gate/visits${qs({ siteId, open: "true" })}`);
  const trips = useApi<Trip[]>(`/trips${qs({ siteId, active: "true" })}`);
  const events = useApi<EventRecord[]>(`/events${qs({ siteId, limit: 40 })}`);
  const [selected, setSelected] = useState<{ cell: MapCell; locs: LocationStatus[] } | null>(null);

  const s = stats.data;
  const selectedVisit =
    selected &&
    visits.data?.find(
      (v) =>
        selected.locs.some((l) => l.id === v.yardLocationId) ||
        selected.locs.some((l) => l.id === v.dock?.locationId),
    );

  return (
    <div className="three" style={{ gridTemplateColumns: "250px minmax(0, 1fr) 250px" }}>
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
            <div className="live-kpi-value">{s?.yard.inYard ?? 0}</div>
            <div className="live-kpi-hint">
              Longest {s?.yard.maxCurrentDwellMinutes ? formatDuration(s.yard.maxCurrentDwellMinutes) : "—"}
            </div>
          </div>

          <div className="live-kpi-card">
            <div className="live-kpi-header">
              <span className="live-kpi-label">AT DOCK</span>
            </div>
            <div className="live-kpi-value">{s?.yard.atDock ?? 0}</div>
            <div className="live-kpi-hint">
              Turnaround {s?.turnaroundMinutes ? formatDuration(s.turnaroundMinutes) : "—"}
            </div>
          </div>

          <div className="live-kpi-card is-active-trips">
            <div className="live-kpi-header">
              <span className="live-kpi-label">ACTIVE TRIPS</span>
            </div>
            <div className="live-kpi-value color-blue">{s?.trips.active ?? 0}</div>
          </div>

          <div className="live-kpi-card is-delayed">
            <div className="live-kpi-header">
              <span className="live-kpi-label">DELAYED</span>
            </div>
            <div className="live-kpi-value color-red">{s?.trips.delayed ?? 0}</div>
          </div>
        </div>

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
        actions={<MapLegend />}
        className="grow"
      >
        <ErrorNote error={board.error} />
        {board.data && board.data.layout.cells.length ? (
          <div className="map-wrap" style={{ maxHeight: "calc(100vh - 160px)" }}>
            <SiteMap
              layout={board.data.layout}
              locations={board.data.locations}
              now={now}
              selectedKey={selected ? `${selected.cell.x}:${selected.cell.y}` : null}
              onCellClick={(cell, locs) => setSelected(locs.length ? { cell, locs } : null)}
            />
          </div>
        ) : board.data ? (
          <Empty>This site has no layout yet. Draw one in the Site designer.</Empty>
        ) : null}
      </Panel>

      <div className="stack" style={{ overflow: "auto" }}>
        {selected ? (
          <Panel title={`${humanize(selected.cell.kind)} ${selected.locs[0]?.code.replace(/-\d+$/, "") ?? ""}`}>
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
              <div className="list">
                {selected.locs.map((l) => (
                  <div key={l.id} className="row-between small">
                    <span className="mono">{l.code}</span>
                    <span className="muted">{l.refs.join(", ") || "empty"}</span>
                    <span>
                      {l.occupied}/{l.capacity}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        ) : null}

        <Panel title="Trips touching this site" scroll className="cap-half">
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
                  <div className="live-trip-time">
                    {t.status === "in_transit"
                      ? `ETA ${fmtDateTime(t.etaAt)} (${fromNow(t.etaAt, now)})`
                      : `Departs ${fmtDateTime(t.plannedDeparture)}`}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>No active trips</Empty>
          )}
        </Panel>

        <Panel
          title="Activity"
          actions={<span className="activity-feed-badge">Feed</span>}
          scroll
          className="grow"
        >
          {events.data?.length ? (
            <div className="activity-timeline-list">
              {events.data.map((e) => (
                <div key={e.id} className="activity-timeline-row">
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
    </div>
  );
}
