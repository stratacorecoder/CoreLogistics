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
  EventFeed,
  fmtDateTime,
  fromNow,
  Kpi,
  MapLegend,
  Panel,
  Pill,
  SiteMap,
  qs,
  useApi,
  useNow,
  type MapCell,
  type Refs,
} from "@corelogistics/ui";
import { useState } from "react";

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
      (v) => selected.locs.some((l) => l.id === v.yardLocationId) || selected.locs.some((l) => l.id === v.dock?.locationId),
    );

  return (
    <div className="three">
      <div className="stack" style={{ overflow: "auto" }}>
        <div className="kpis" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Kpi label="In yard" value={s?.yard.inYard ?? "—"} hint={`Longest ${formatDuration(s?.yard.maxCurrentDwellMinutes)}`} />
          <Kpi label="At dock" value={s?.yard.atDock ?? "—"} hint={`Turnaround ${formatDuration(s?.turnaroundMinutes)}`} />
          <Kpi label="Active trips" value={s?.trips.active ?? "—"} />
          <Kpi label="Delayed" value={s?.trips.delayed ?? "—"} tone={s?.trips.delayed ? "danger" : undefined} />
        </div>
        <Panel title="On site now" scroll className="grow">
          {visits.data?.length ? (
            <div className="list">
              {visits.data.map((v) => (
                <div key={v.id} className="item">
                  <div className="row-between">
                    <span className="item-title mono">{v.plate}</span>
                    <Pill value={v.status} />
                  </div>
                  <div className="item-meta">
                    {v.dock ? `Dock ${v.dock.code} · ${v.dock.purpose}` : v.yardCode ? `Yard ${v.yardCode}` : "In yard, no slot"}
                    {v.tripCode ? ` · ${v.tripCode}` : ""} · {formatDuration(v.dwellMinutes)} on site
                  </div>
                </div>
              ))}
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
          <div className="map-wrap" style={{ maxHeight: "calc(100vh - 150px)" }}>
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
                <dd>{fmtDateTime(selectedVisit.checkInAt)} ({formatDuration(selectedVisit.dwellMinutes)})</dd>
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
            <div className="list">
              {trips.data.map((t) => (
                <div key={t.id} className={`item${t.delayed ? " is-alert" : ""}`}>
                  <div className="row-between">
                    <span className="item-title">{t.code}</span>
                    <span className="row">
                      {t.delayed ? <Pill tone="danger">+{t.delayMinutes}m</Pill> : null}
                      <Pill value={t.status} />
                    </span>
                  </div>
                  <div className="item-meta">
                    {refs.siteCode(t.originSiteId)} → {refs.siteCode(t.destinationSiteId)} · {refs.plate(t.vehicleId)}
                  </div>
                  <div className="item-meta">
                    {t.status === "in_transit" ? `ETA ${fmtDateTime(t.etaAt)} (${fromNow(t.etaAt, now)})` : `Departs ${fmtDateTime(t.plannedDeparture)}`}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>No active trips</Empty>
          )}
        </Panel>
        <Panel title="Activity" scroll className="grow">
          <EventFeed events={events.data} />
        </Panel>
      </div>
    </div>
  );
}
