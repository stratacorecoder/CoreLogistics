import {
  humanize,
  SORT_MATCH_KINDS,
  ZONE_META,
  type HandlingUnit,
  type Location,
  type SortMatchKind,
  type SortResult,
  type SortRule,
} from "@corelogistics/contracts";
import { api, Empty, Field, Panel, Pill, qs, useAction, useApi, type Refs } from "@corelogistics/ui";
import { useState } from "react";

export function SortView({ siteId, refs, onPutaway }: { siteId: string; refs: Refs; onPutaway: () => void }) {
  const queue = useApi<HandlingUnit[]>(`/warehouse/hus${qs({ siteId, status: "received" })}`);
  const { busy, run } = useAction();
  const [scan, setScan] = useState("");
  const [result, setResult] = useState<SortResult | null>(null);

  const sort = async (idOrCode: string) => {
    const r = await run(() => api.post<SortResult>(`/warehouse/hus/${encodeURIComponent(idOrCode)}/sort`), (x) => `${x.hu.code} → ${x.hu.sortLaneCode}`);
    if (r) {
      setResult(r);
      setScan("");
    }
  };

  return (
    <div className="three" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) 380px" }}>
      <div className="stack">
        <Panel title="Scan to sort">
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              if (scan) void sort(scan);
            }}
          >
            <input className="input scan-input" autoFocus placeholder="HU-…" value={scan} onChange={(e) => setScan(e.target.value.toUpperCase())} />
            <button className="btn btn-primary btn-lg" disabled={busy || !scan}>
              Sort
            </button>
          </form>
        </Panel>
        {result ? (
          <Panel title={`${result.hu.code} · ${result.hu.skuCode}`}>
            <div className="stack">
              <div className={`big-target${result.hu.destinationSiteId ? " tone-warn" : ""}`}>
                <span className="sub">Take to lane</span>
                <span className="code">{result.hu.sortLaneCode}</span>
                <span className="sub">{result.reason}</span>
              </div>
              {result.putaway ? (
                <div className="row-between">
                  <span>
                    Putaway task created · suggested bin <strong className="mono">{result.putaway.suggestedCode ?? "none free"}</strong>
                  </span>
                  <button className="btn btn-ghost btn-sm" onClick={onPutaway}>
                    Go to putaway
                  </button>
                </div>
              ) : (
                <p className="small">
                  Cross-dock unit for <strong>{refs.siteName(result.hu.destinationSiteId)}</strong>. It is staged at the lane and waits for an
                  outbound truck.
                </p>
              )}
            </div>
          </Panel>
        ) : null}
      </div>

      <Panel title={`Waiting to sort (${queue.data?.length ?? 0})`} scroll>
        {queue.data?.length ? (
          <div className="list">
            {queue.data.map((h) => (
              <div key={h.id} className="item">
                <div className="row-between">
                  <span className="item-title mono">{h.code}</span>
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => sort(h.id)}>
                    Sort
                  </button>
                </div>
                <div className="item-meta">
                  <span className="zone-dot" style={{ background: ZONE_META[h.zone].color }} />
                  {h.qty} × {h.skuCode} {h.skuName} · at {h.locationCode ?? "receiving"}
                </div>
                {h.destinationSiteId ? (
                  <div className="item-meta">
                    <Pill tone="violet">Cross-dock → {refs.siteCode(h.destinationSiteId)}</Pill>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <Empty>Nothing waiting</Empty>
        )}
      </Panel>

      <SortRules siteId={siteId} refs={refs} />
    </div>
  );
}

function SortRules({ siteId, refs }: { siteId: string; refs: Refs }) {
  const rules = useApi<SortRule[]>(`/warehouse/sort-rules${qs({ siteId })}`, { live: false });
  const lanes = useApi<Location[]>(`/sites/${siteId}/locations${qs({ kind: "sort_lane" })}`, { live: false });
  const { busy, run } = useAction();
  const [matchKind, setMatchKind] = useState<SortMatchKind>("destination");
  const [matchValue, setMatchValue] = useState("");
  const [laneId, setLaneId] = useState("");
  const [priority, setPriority] = useState(50);

  const valueOptions: string[] | null =
    matchKind === "destination"
      ? (refs.sites ?? []).filter((s) => s.id !== siteId).map((s) => s.code)
      : matchKind === "zone"
        ? ["A", "B", "C", "H"]
        : matchKind === "category"
          ? [...new Set((refs.skus ?? []).map((s) => s.category))].sort()
          : null;

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    if (await run(fn, msg)) rules.reload();
  };

  return (
    <Panel title="Sort rules" scroll>
      <div className="stack">
        <p className="muted small">Rules run top to bottom by priority; the first match picks the lane. Unmatched units go to a lane in their SKU's zone.</p>
        <div className="list">
          {(rules.data ?? []).map((r) => (
            <div key={r.id} className="item" style={{ opacity: r.active ? 1 : 0.5 }}>
              <div className="row-between">
                <span className="strong">
                  P{r.priority} · {humanize(r.matchKind)} = {r.matchValue}
                </span>
                <span className="mono strong">→ {r.sortLaneCode}</span>
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api.patch(`/warehouse/sort-rules/${r.id}`, { active: !r.active }), "Rule updated")}>
                  {r.active ? "Pause" : "Activate"}
                </button>
                <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act(() => api.del(`/warehouse/sort-rules/${r.id}`), "Rule deleted")}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="form">
          <div className="form-2">
            <Field label="Match on">
              <select
                className="select"
                value={matchKind}
                onChange={(e) => {
                  setMatchKind(e.target.value as SortMatchKind);
                  setMatchValue("");
                }}
              >
                {SORT_MATCH_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Value">
              {valueOptions ? (
                <select className="select" value={matchValue} onChange={(e) => setMatchValue(e.target.value)}>
                  <option value="">Choose…</option>
                  {valueOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="input" placeholder="SKU code" value={matchValue} onChange={(e) => setMatchValue(e.target.value.toUpperCase())} />
              )}
            </Field>
            <Field label="Lane">
              <select className="select" value={laneId} onChange={(e) => setLaneId(e.target.value)}>
                <option value="">Choose…</option>
                {(lanes.data ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code}
                    {l.zone ? ` · zone ${l.zone}` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <input className="input" type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
            </Field>
          </div>
          <button
            className="btn btn-primary"
            disabled={busy || !matchValue || !laneId}
            onClick={() => act(() => api.post("/warehouse/sort-rules", { siteId, matchKind, matchValue, sortLaneId: laneId, priority }), "Rule added")}
          >
            Add rule
          </button>
        </div>
      </div>
    </Panel>
  );
}
