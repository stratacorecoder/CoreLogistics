import { formatDuration, humanize, ZONE_META, type AnalyticsSummary } from "@corelogistics/contracts";
import { ErrorNote, Kpi, Panel, Progress, useApi, type Refs } from "@corelogistics/ui";
import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

function useChartTheme() {
  const [dark, setDark] = useState(() => document.documentElement.getAttribute("data-theme") === "dark");
  useEffect(() => {
    const node = document.documentElement;
    const sync = () => setDark(node.getAttribute("data-theme") === "dark");
    const obs = new MutationObserver(sync);
    obs.observe(node, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  if (dark) {
    return {
      axis: { stroke: "#cbd5e1", fontSize: 12 },
      grid: "rgba(255,255,255,0.08)",
      tooltip: {
        contentStyle: {
          background: "rgba(22, 29, 45, 0.94)",
          border: "1px solid rgba(255,255,255,0.14)",
          borderRadius: 14,
          color: "#f8fafc",
        },
        labelStyle: { color: "#f8fafc" },
      },
    };
  }
  return {
    axis: { stroke: "#475569", fontSize: 12 },
    grid: "rgba(15,23,42,0.08)",
    tooltip: {
      contentStyle: {
        background: "rgba(255,255,255,0.94)",
        border: "1px solid rgba(15,23,42,0.08)",
        borderRadius: 14,
        color: "#0f172a",
      },
      labelStyle: { color: "#0f172a" },
    },
  };
}

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v)}%`);
const toneFor = (v: number | null, good = 90, ok = 75) => (v == null ? undefined : v >= good ? "ok" : v >= ok ? "warn" : "danger");

export function AnalyticsView({ siteId, refs }: { siteId: string; refs: Refs }) {
  const [days, setDays] = useState(7);
  const [scope, setScope] = useState<"site" | "network">("site");
  const q = scope === "site" ? `siteId=${siteId}&days=${days}` : `days=${days}`;
  const { data, error } = useApi<AnalyticsSummary>(`/analytics/summary?${q}`, { intervalMs: 60_000 });
  const chart = useChartTheme();

  return (
    <div className="page stack">
      <div className="row-between">
        <div className="row">
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value as "site" | "network")}>
            <option value="site">{refs.siteName(siteId)}</option>
            <option value="network">Whole network</option>
          </select>
          <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                Last {d} {d === 1 ? "day" : "days"}
              </option>
            ))}
          </select>
        </div>
        <span className="muted small">Refreshes every minute</span>
      </div>
      <ErrorNote error={error} />
      {data ? (
        <>
          <div className="kpis">
            <Kpi label="On-time departures" value={pct(data.trips.onTimeDeparturePct)} tone={toneFor(data.trips.onTimeDeparturePct)} hint={`${data.trips.completedInPeriod} trips completed`} />
            <Kpi label="On-time arrivals" value={pct(data.trips.onTimeArrivalPct)} tone={toneFor(data.trips.onTimeArrivalPct)} hint={`${data.trips.delayed} running late now`} />
            <Kpi label="Avg yard dwell" value={formatDuration(data.yard.avgDwellMinutes)} hint={`${data.yard.visitsInPeriod} gate visits`} />
            <Kpi label="Truck turnaround" value={formatDuration(data.turnaroundMinutes)} hint="gate in to gate out" />
            <Kpi label="Dock utilization" value={pct(data.dockUtilizationPct)} hint={`${data.docks.length} doors`} />
            <Kpi label="Fleet available" value={`${data.fleet.byStatus.available ?? 0} / ${data.fleet.total}`} tone={(data.fleet.byStatus.maintenance ?? 0) > 0 ? "warn" : undefined} hint={`${data.fleet.byStatus.maintenance ?? 0} in maintenance`} />
          </div>

          <div className="split" style={{ padding: 0, overflow: "visible", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
            <Panel title="Daily throughput (handling units)">
              <div className="chart">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={data.throughput}>
                    <CartesianGrid stroke={chart.grid} vertical={false} />
                    <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} {...chart.axis} />
                    <YAxis allowDecimals={false} {...chart.axis} />
                    <Tooltip {...chart.tooltip} cursor={{ fill: "rgba(0,122,255,0.08)" }} />
                    <Legend />
                    <Bar dataKey="received" name="Received" fill="var(--map-gate)" radius={[6, 6, 0, 0]} />
                    <Bar dataKey="shipped" name="Shipped" fill="var(--map-dock)" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel title="Gate traffic">
              <div className="chart">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={data.throughput}>
                    <CartesianGrid stroke={chart.grid} vertical={false} />
                    <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} {...chart.axis} />
                    <YAxis allowDecimals={false} {...chart.axis} />
                    <Tooltip {...chart.tooltip} />
                    <Legend />
                    <Line type="monotone" dataKey="gateIn" name="In" stroke="var(--map-gate)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="gateOut" name="Out" stroke="var(--map-staging)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>

          <div className="three" style={{ padding: 0 }}>
            <Panel title="Dock doors">
              <table className="table">
                <thead>
                  <tr>
                    <th>Door</th>
                    <th className="right">Turns</th>
                    <th className="right">Busy</th>
                    <th style={{ width: "40%" }}>Utilization</th>
                  </tr>
                </thead>
                <tbody>
                  {data.docks.map((d) => (
                    <tr key={d.locationId}>
                      <td className="strong">
                        {scope === "network" ? `${refs.siteCode(d.siteId)} ` : ""}
                        {d.code}
                      </td>
                      <td className="right">{d.assignments}</td>
                      <td className="right">{formatDuration(d.busyMinutes)}</td>
                      <td>
                        <div className="row">
                          <Progress value={d.utilizationPct} max={100} tone={d.utilizationPct > 85 ? "danger" : d.utilizationPct > 60 ? "warn" : "ok"} />
                          <span className="small muted">{Math.round(d.utilizationPct)}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            <Panel title="Storage by zone">
              <div className="stack">
                {data.capacityByZone.map((z) => (
                  <div key={z.zone}>
                    <div className="row-between small">
                      <span style={{ color: ZONE_META[z.zone].color }} className="strong">
                        {z.zone} · {ZONE_META[z.zone].label}
                      </span>
                      <span className="muted">
                        {z.used} / {z.capacity} HU · {Math.round(z.pct)}%
                      </span>
                    </div>
                    <Progress value={z.used} max={z.capacity} tone={z.pct > 90 ? "danger" : z.pct > 75 ? "warn" : "ok"} />
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="Right now">
              <dl className="kv">
                <dt>Trips active</dt>
                <dd>{data.trips.active}</dd>
                <dt>Trips delayed</dt>
                <dd className={data.trips.delayed ? "danger-text" : ""}>{data.trips.delayed}</dd>
                <dt>Trucks in yard</dt>
                <dd>{data.yard.inYard}</dd>
                <dt>Trucks at docks</dt>
                <dd>{data.yard.atDock}</dd>
                <dt>Longest current dwell</dt>
                <dd>{formatDuration(data.yard.maxCurrentDwellMinutes)}</dd>
                {Object.entries(data.openWork).map(([k, v]) => (
                  <Row key={k} label={`Open ${humanize(k)}`} value={v} />
                ))}
              </dl>
            </Panel>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
