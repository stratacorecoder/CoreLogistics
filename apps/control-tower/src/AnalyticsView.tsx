import { formatDuration, ZONE_META, type AnalyticsSummary } from "@corelogistics/contracts";
import { Empty, ErrorNote, Panel, Pill, Progress, useApi, useNow, type Refs } from "@corelogistics/ui";
import { CheckCircle2, ChevronRight, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type DestinationView = "live" | "dispatch" | "fleet";

interface PriorityItem {
  id: string;
  tone: "danger" | "warn" | "info";
  title: string;
  detail: string;
  onClick?: () => void;
}

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
const php = (n: number) => `₱${Math.round(n).toLocaleString("en-US")}`;
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
const minutesSince = (iso: string, now: number) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, Math.round((now - ms) / 60_000)) : 0;
};

function buildPriorityItems({
  data,
  scope,
  refs,
  now,
  onNavigate,
  onJumpToFefo,
}: {
  data: AnalyticsSummary;
  scope: "site" | "network";
  refs: Refs;
  now: number;
  onNavigate?: (view: DestinationView) => void;
  onJumpToFefo: () => void;
}): PriorityItem[] {
  const items: PriorityItem[] = [];

  if (data.trips.delayed > 0) {
    items.push({
      id: "late-trips",
      tone: "danger",
      title: `${data.trips.delayed} ${plural(data.trips.delayed, "trip is", "trips are")} running late`,
      detail: `About ${php(data.risk.delayPenaltyExposure)} at risk in late-delivery penalties`,
      onClick: onNavigate ? () => onNavigate("dispatch") : undefined,
    });
  }

  if (data.risk.yardDetentionExposure > 0) {
    const maxWait = data.yard.maxCurrentDwellMinutes != null ? ` · longest wait ${formatDuration(data.yard.maxCurrentDwellMinutes)}` : "";
    items.push({
      id: "yard-dwell",
      tone: "warn",
      title: "Trucks are waiting too long in the yard",
      detail: `Over 2 hours · ${php(data.risk.yardDetentionExposure)} in waiting fees${maxWait}`,
      onClick: onNavigate ? () => onNavigate("live") : undefined,
    });
  }

  const busyDocks = data.docks
    .filter((d) => d.activeSince)
    .map((d) => ({ dock: d, busyMinutes: minutesSince(d.activeSince!, now) }))
    .sort((a, b) => b.busyMinutes - a.busyMinutes);

  const stalledDock = busyDocks.find((entry) => entry.busyMinutes >= 240);
  if (stalledDock) {
    const freeCount = data.docks.length - busyDocks.length;
    const dockName = scope === "network" ? `${refs.siteCode(stalledDock.dock.siteId)} ${stalledDock.dock.code}` : stalledDock.dock.code;
    const restCopy = freeCount <= 0 ? "All dock doors are currently busy." : `The other ${freeCount} ${plural(freeCount, "door is", "doors are")} free.`;
    items.push({
      id: `dock-${stalledDock.dock.locationId}`,
      tone: stalledDock.busyMinutes >= 24 * 60 ? "danger" : "warn",
      title: `Dock door ${dockName} has been busy for ${formatDuration(stalledDock.busyMinutes)}`,
      detail: `It may be stuck. ${restCopy}`,
      onClick: onNavigate ? () => onNavigate("live") : undefined,
    });
  }

  if (data.risk.expiredCount > 0 || data.risk.expiringSoonCount > 0) {
    const parts: string[] = [];
    if (data.risk.expiredCount > 0) parts.push(`${data.risk.expiredCount} expired`);
    if (data.risk.expiringSoonCount > 0) parts.push(`${data.risk.expiringSoonCount} expiring within 14d`);
    items.push({
      id: "fefo-expiry",
      tone: data.risk.expiredCount > 0 ? "danger" : "warn",
      title: parts.join(" · "),
      detail: `${data.risk.expiringUnitsQty.toLocaleString("en-US")} units (${php(data.risk.atRiskInventoryValue)}) need FEFO review`,
      onClick: onJumpToFefo,
    });
  }

  const inRepair = data.fleet.byStatus.maintenance ?? 0;
  if (inRepair > 0 && items.length < 4) {
    const avail = data.fleet.byStatus.available ?? 0;
    const costNote = data.risk.maintenanceCost > 0 ? ` · ${php(data.risk.maintenanceCost)} in repairs` : "";
    items.push({
      id: "fleet-repair",
      tone: "info",
      title: `${inRepair} ${plural(inRepair, "vehicle is", "vehicles are")} in repair`,
      detail: `${avail} of ${data.fleet.total} vehicles ready to use${costNote}`,
      onClick: onNavigate ? () => onNavigate("fleet") : undefined,
    });
  }

  const hotZone = [...data.capacityByZone].filter((z) => z.pct >= 85).sort((a, b) => b.pct - a.pct)[0];
  if (hotZone && items.length < 4) {
    items.push({
      id: `zone-${hotZone.zone}`,
      tone: hotZone.pct >= 95 ? "danger" : "warn",
      title: `${ZONE_META[hotZone.zone].label} storage is ${Math.round(hotZone.pct)}% full`,
      detail: `${hotZone.used} of ${hotZone.capacity} handling units used`,
      onClick: onNavigate ? () => onNavigate("live") : undefined,
    });
  }

  return items.slice(0, 4);
}

export function AnalyticsView({
  siteId,
  refs,
  onNavigate,
  onOpenCopilot,
}: {
  siteId: string;
  refs: Refs;
  onNavigate?: (view: DestinationView) => void;
  onOpenCopilot?: () => void;
}) {
  const [days, setDays] = useState(7);
  const [scope, setScope] = useState<"site" | "network">("site");
  const q = scope === "site" ? `siteId=${siteId}&days=${days}` : `days=${days}`;
  const { data, error } = useApi<AnalyticsSummary>(`/analytics/summary?${q}`, { intervalMs: 60_000 });
  const now = useNow(30_000);
  const chart = useChartTheme();
  const fefoRef = useRef<HTMLDivElement>(null);

  const scopeLabel = scope === "network" ? "the whole network" : refs.siteName(siteId);
  const jumpToFefo = () => fefoRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="page stack" style={{ gap: 14 }}>
      <div className="analytics-toolbar">
        <p className="analytics-subtitle">How {scopeLabel} is doing · updates every minute</p>
        <div className="row">
          <select className="select" aria-label="Analytics scope" value={scope} onChange={(e) => setScope(e.target.value as "site" | "network")}>
            <option value="site">{refs.siteName(siteId)}</option>
            <option value="network">Whole network</option>
          </select>
          <select className="select" aria-label="Time range" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                Last {d} {d === 1 ? "day" : "days"}
              </option>
            ))}
          </select>
          {onOpenCopilot ? (
            <button type="button" className="btn btn-ghost" onClick={onOpenCopilot}>
              <Sparkles size={14} />
              Ask Copilot
            </button>
          ) : null}
        </div>
      </div>

      <ErrorNote error={error} />

      {data ? (
        <>
          <div className="analytics-hero-grid">
            <MoneyAtRiskCard risk={data.risk} />
            <PriorityListCard
              items={buildPriorityItems({
                data,
                scope,
                refs,
                now,
                onNavigate,
                onJumpToFefo: jumpToFefo,
              })}
            />
          </div>

          <SummaryKpiStrip data={data} days={days} />

          <div className="analytics-detail-grid">
            <DockDoorsPanel docks={data.docks} scope={scope} refs={refs} now={now} />
            <StorageSpacePanel zones={data.capacityByZone} />
            <WorkWaitingPanel openWork={data.openWork} />
          </div>

          <BottomInsightSection data={data} days={days} chart={chart} fefoRef={fefoRef} />
        </>
      ) : null}
    </div>
  );
}

function MoneyAtRiskCard({ risk }: { risk: AnalyticsSummary["risk"] }) {
  const buckets = [
    { key: "late", label: "Late trips", amount: risk.delayPenaltyExposure, color: "var(--danger)" },
    { key: "wait", label: "Waiting fees", amount: risk.yardDetentionExposure, color: "var(--warn)" },
    { key: "repairs", label: "Repairs", amount: risk.maintenanceCost, color: "var(--violet)" },
    { key: "expiry", label: "Stock expiry", amount: risk.atRiskInventoryValue, color: "var(--map-staging)" },
  ];
  const total = buckets.reduce((sum, b) => sum + b.amount, 0);
  const hasUrgent = risk.delayPenaltyExposure + risk.yardDetentionExposure + risk.atRiskInventoryValue > 0;
  const totalToneClass = hasUrgent ? "is-danger" : total > 0 ? "is-warn" : "is-ok";

  return (
    <Panel>
      <div className="analytics-risk-eyebrow">Money at risk right now</div>
      <div className={`analytics-risk-total ${totalToneClass}`}>{php(total)}</div>
      <p className="analytics-risk-caption">From late trips, long truck waits, repairs and stock nearing expiry.</p>

      <div className="analytics-risk-bar" aria-label="Exposure breakdown">
        {total > 0 ? (
          buckets
            .filter((b) => b.amount > 0)
            .map((b) => (
              <span
                key={b.key}
                className="analytics-risk-seg"
                title={`${b.label}: ${php(b.amount)}`}
                style={{ width: `${(b.amount / total) * 100}%`, background: b.color }}
              />
            ))
        ) : (
          <span className="analytics-risk-seg" style={{ width: "100%", background: "var(--ok)" }} />
        )}
      </div>

      <div className="analytics-risk-breakdown">
        {buckets.map((b) => (
          <div key={b.key} className="analytics-risk-row">
            <span className="analytics-risk-label">
              <span className="analytics-risk-dot" style={{ background: b.color }} />
              {b.label}
            </span>
            <span className={`analytics-risk-amount${b.amount === 0 ? " is-zero" : ""}`}>{php(b.amount)}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function PriorityListCard({ items }: { items: PriorityItem[] }) {
  return (
    <Panel title="What to look at first">
      {items.length ? (
        <div className="analytics-priority-list">
          {items.map((item) => (
            <button key={item.id} type="button" className="analytics-priority-item" onClick={item.onClick} disabled={!item.onClick}>
              <div className="analytics-priority-main">
                <span className={`analytics-priority-dot tone-${item.tone}`} />
                <div>
                  <div className="analytics-priority-title">{item.title}</div>
                  <div className="analytics-priority-detail">{item.detail}</div>
                </div>
              </div>
              {item.onClick ? <ChevronRight size={16} className="analytics-priority-chevron" /> : null}
            </button>
          ))}
        </div>
      ) : (
        <div className="analytics-priority-empty">
          <CheckCircle2 size={18} />
          <div>
            <div className="strong">Nothing urgent right now</div>
            <div className="small muted">Trips, yard waits, dock doors and stock expiry look healthy.</div>
          </div>
        </div>
      )}
    </Panel>
  );
}

function SummaryKpiStrip({ data, days }: { data: AnalyticsSummary; days: number }) {
  const availableFleet = data.fleet.byStatus.available ?? 0;
  const inRepair = data.fleet.byStatus.maintenance ?? 0;
  const busyDocks = data.docks.filter((d) => Boolean(d.activeSince)).length;
  const liveDockPct = data.docks.length ? Math.round((busyDocks / data.docks.length) * 100) : null;
  const onTimeTone = toneFor(data.trips.onTimeArrivalPct);

  return (
    <div className="analytics-kpis-5">
      <PlainKpi
        label="Trips on the road"
        value={data.trips.active}
        hint={data.trips.delayed > 0 ? `${data.trips.delayed} running late` : `${data.trips.completedInPeriod} completed (${days}d)`}
        hintTone={data.trips.delayed > 0 ? "danger" : undefined}
      />
      <PlainKpi
        label="Trucks in the yard"
        value={data.yard.inYard}
        hint={`${data.yard.atDock} more at the docks`}
      />
      <PlainKpi
        label="Vehicles ready to use"
        value={
          <>
            {availableFleet}
            <span className="analytics-kpi-sub-total">of {data.fleet.total}</span>
          </>
        }
        hint={inRepair > 0 ? `${inRepair} in repair` : "None in repair"}
        hintTone={inRepair > 0 ? "warn" : undefined}
      />
      <PlainKpi
        label="Dock doors in use"
        value={pct(liveDockPct)}
        hint={data.docks.length ? `${busyDocks} of ${data.docks.length} doors busy` : "No dock doors"}
      />
      <PlainKpi
        label="Trucks arriving on time"
        value={pct(data.trips.onTimeArrivalPct)}
        valueTone={onTimeTone}
        hint={
          data.trips.delayed > 0
            ? `${data.trips.delayed} running late now`
            : data.trips.onTimeDeparturePct != null
              ? `${Math.round(data.trips.onTimeDeparturePct)}% departed on time`
              : `${data.trips.completedInPeriod} trips in ${days}d`
        }
      />
    </div>
  );
}

function PlainKpi({
  label,
  value,
  hint,
  valueTone,
  hintTone,
}: {
  label: string;
  value: ReactNode;
  hint: ReactNode;
  valueTone?: "ok" | "warn" | "danger";
  hintTone?: "warn" | "danger";
}) {
  return (
    <div className={`kpi${valueTone ? ` tone-${valueTone}` : ""}`}>
      <p className="kpi-label">{label}</p>
      <p className="kpi-value">{value}</p>
      <p className={`kpi-hint${hintTone ? ` is-${hintTone}` : ""}`}>{hint}</p>
    </div>
  );
}

function DockDoorsPanel({
  docks,
  scope,
  refs,
  now,
}: {
  docks: AnalyticsSummary["docks"];
  scope: "site" | "network";
  refs: Refs;
  now: number;
}) {
  const busyCount = docks.filter((d) => Boolean(d.activeSince)).length;
  return (
    <Panel title={`Dock doors · ${busyCount} of ${docks.length} in use`}>
      {docks.length ? (
        <div className="analytics-dock-grid">
          {docks.map((d) => {
            const busy = Boolean(d.activeSince);
            const busyMinutes = d.activeSince ? minutesSince(d.activeSince, now) : 0;
            const label = scope === "network" ? `${refs.siteCode(d.siteId)} ${d.code}` : d.code;
            return (
              <div
                key={d.locationId}
                className={`analytics-dock-tile${busy ? " is-busy" : ""}`}
                title={`${label}: ${d.assignments} ${plural(d.assignments, "turn")} · ${formatDuration(d.busyMinutes)} busy · ${Math.round(d.utilizationPct)}% utilization`}
              >
                <div className="analytics-dock-head">
                  <span className="analytics-dock-code">{label}</span>
                  <span className={`analytics-dock-badge ${busy ? "is-busy" : "is-free"}`}>{busy ? "In use" : "Free"}</span>
                </div>
                {busy ? (
                  <div className="analytics-dock-meta">Busy for {formatDuration(busyMinutes)}</div>
                ) : d.assignments > 0 ? (
                  <div className="analytics-dock-meta">
                    {d.assignments} {plural(d.assignments, "turn")} · {Math.round(d.utilizationPct)}%
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <Empty>No dock doors configured</Empty>
      )}
    </Panel>
  );
}

function StorageSpacePanel({ zones }: { zones: AnalyticsSummary["capacityByZone"] }) {
  return (
    <Panel title="Storage space">
      {zones.length ? (
        <div className="stack" style={{ gap: 12 }}>
          {zones.map((z) => (
            <div key={z.zone} className="analytics-zone-item">
              <div className="row-between small" style={{ marginBottom: 5 }}>
                <span className="strong">
                  {ZONE_META[z.zone].label}{" "}
                  <span className="muted" style={{ fontWeight: 500 }}>
                    ({z.zone})
                  </span>
                </span>
                <span className="muted mono">
                  {z.used} of {z.capacity} used · {Math.round(z.pct)}%
                </span>
              </div>
              <Progress value={z.used} max={z.capacity} tone={z.pct > 90 ? "danger" : z.pct > 75 ? "warn" : undefined} />
            </div>
          ))}
        </div>
      ) : (
        <Empty>No storage bins configured</Empty>
      )}
    </Panel>
  );
}

function WorkWaitingPanel({ openWork }: { openWork: AnalyticsSummary["openWork"] }) {
  const rows = [
    { label: "Deliveries to receive", value: openWork.receipts },
    { label: "Items to put on shelves", value: openWork.putaway },
    { label: "Items to pick", value: openWork.picks },
    { label: "Customer orders", value: openWork.orders },
    { label: "Shipments to send", value: openWork.shipments },
  ];

  return (
    <Panel title="Work waiting to be done">
      <div className="analytics-work-list">
        {rows.map((r) => (
          <div key={r.label} className="analytics-work-row">
            <span className="analytics-work-label">{r.label}</span>
            <span className={`analytics-work-val${r.value === 0 ? " is-zero" : ""}`}>{r.value}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function BottomInsightSection({
  data,
  days,
  chart,
  fefoRef,
}: {
  data: AnalyticsSummary;
  days: number;
  chart: ReturnType<typeof useChartTheme>;
  fefoRef: RefObject<HTMLDivElement>;
}) {
  const totals = data.throughput.reduce(
    (acc, d) => ({
      received: acc.received + d.received,
      shipped: acc.shipped + d.shipped,
      gateIn: acc.gateIn + d.gateIn,
      gateOut: acc.gateOut + d.gateOut,
    }),
    { received: 0, shipped: 0, gateIn: 0, gateOut: 0 },
  );
  const hasActivity = totals.received + totals.shipped + totals.gateIn + totals.gateOut > 0;
  const hasFefo = data.risk.fefoWatchlist.length > 0;

  if (!hasActivity && !hasFefo) {
    return (
      <div className="analytics-bottom-empty-grid" ref={fefoRef}>
        <Panel title={`Activity · last ${days} ${plural(days, "day")}`}>
          <p className="muted small" style={{ lineHeight: 1.5 }}>
            Nothing received, shipped or through the gate in the last {days} {plural(days, "day")}.
            {data.trips.onTimeDeparturePct == null && data.yard.avgDwellMinutes == null
              ? " No data yet for trips leaving on time or time spent in the yard."
              : ""}
          </p>
        </Panel>
        <Panel title="FEFO & expiry watch">
          <p className="muted small" style={{ lineHeight: 1.5 }}>
            Nothing has an expiry date at this scope, so there is nothing to watch.
          </p>
        </Panel>
      </div>
    );
  }

  return (
    <>
      {hasActivity ? (
        <div className="analytics-charts-grid">
          <Panel
            title="Daily throughput"
            actions={
              <span className="muted small mono">
                {totals.received} in · {totals.shipped} out
              </span>
            }
          >
            <div className="chart">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={data.throughput} margin={{ top: 8, right: 12, left: -12, bottom: 4 }}>
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
          <Panel
            title="Gate traffic"
            actions={
              <span className="muted small mono">
                {totals.gateIn} in · {totals.gateOut} out
              </span>
            }
          >
            <div className="chart">
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={data.throughput} margin={{ top: 8, right: 12, left: -12, bottom: 4 }}>
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
      ) : (
        <Panel title={`Activity · last ${days} ${plural(days, "day")}`}>
          <p className="muted small">Nothing received, shipped or through the gate in the last {days} {plural(days, "day")}.</p>
        </Panel>
      )}

      <div ref={fefoRef}>
        <Panel title={`FEFO & expiry watch (${data.risk.fefoWatchlist.length})`}>
          {hasFefo ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Unit</th>
                    <th>SKU</th>
                    <th>Lot #</th>
                    <th>Location</th>
                    <th className="right">Qty</th>
                    <th>Expiry Date</th>
                    <th className="right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.risk.fefoWatchlist.map((item) => {
                    const expired = item.daysRemaining <= 0;
                    const urgent = item.daysRemaining > 0 && item.daysRemaining <= 14;
                    return (
                      <tr key={item.id}>
                        <td className="mono strong">{item.huCode}</td>
                        <td>
                          <strong>{item.skuCode}</strong> <span className="muted small">{item.skuName}</span>
                        </td>
                        <td className="mono">{item.lotNumber ?? "—"}</td>
                        <td className="mono">{item.locationCode ?? "—"}</td>
                        <td className="right">{item.qty}</td>
                        <td className="mono">{item.expiryDate.slice(0, 10)}</td>
                        <td className="right">
                          <Pill
                            value={expired ? `Expired ${Math.abs(item.daysRemaining)}d ago` : `${item.daysRemaining}d left`}
                            tone={expired ? "danger" : urgent ? "warn" : "ok"}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted small">Nothing has an expiry date at this scope, so there is nothing to watch.</p>
          )}
        </Panel>
      </div>
    </>
  );
}
