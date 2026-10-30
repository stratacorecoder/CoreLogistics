import { ZONE_META, type LocationStatus, type PutawayTask, type SiteBoard } from "@corelogistics/contracts";
import { api, Empty, fromNow, MapLegend, Panel, qs, SiteMap, useAction, useApi } from "@corelogistics/ui";
import { useEffect, useMemo, useState } from "react";

export function PutawayView({ siteId }: { siteId: string }) {
  const tasks = useApi<PutawayTask[]>(`/warehouse/putaway${qs({ siteId, status: "open" })}`);
  const board = useApi<SiteBoard>(`/sites/${siteId}/board`);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [override, setOverride] = useState<LocationStatus | null>(null);
  const [rack, setRack] = useState<LocationStatus[] | null>(null);
  const { busy, run } = useAction();

  const task = tasks.data?.find((t) => t.id === selectedId) ?? null;
  useEffect(() => {
    if ((!selectedId || !task) && tasks.data?.length) setSelectedId(tasks.data[0]!.id);
  }, [tasks.data, selectedId, task]);
  useEffect(() => {
    setOverride(null);
    setRack(null);
  }, [selectedId]);

  const target = override?.id ?? task?.suggestedLocationId ?? null;
  const highlight = useMemo(() => [target, task?.fromLocationId].filter((x): x is string => Boolean(x)), [target, task]);

  return (
    <div className="three" style={{ gridTemplateColumns: "320px minmax(0, 1fr) 340px" }}>
      <Panel title={`Open tasks (${tasks.data?.length ?? 0})`} scroll>
        {tasks.data?.length ? (
          <div className="list">
            {tasks.data.map((t) => (
              <button key={t.id} className={`item${t.id === selectedId ? " is-selected" : ""}`} onClick={() => setSelectedId(t.id)}>
                <div className="row-between">
                  <span className="item-title mono">{t.huCode}</span>
                  <span className="mono strong">{t.suggestedCode ?? "?"}</span>
                </div>
                <div className="item-meta">
                  <span className="zone-dot" style={{ background: ZONE_META[t.zone].color }} />
                  {t.qty} × {t.skuCode} · from {t.fromCode ?? "—"}
                </div>
                <div className="item-meta">{fromNow(t.createdAt)}</div>
              </button>
            ))}
          </div>
        ) : (
          <Empty>All units are put away</Empty>
        )}
      </Panel>

      <Panel title="Floor map" actions={<MapLegend kinds={["sort_lane", "staging", "rack", "dock_door"]} />}>
        {board.data ? (
          <div className="map-wrap" style={{ maxHeight: "calc(100vh - 150px)" }}>
            <SiteMap
              layout={board.data.layout}
              locations={board.data.locations}
              highlight={highlight}
              cellSize={30}
              onCellClick={(cell, locs) => setRack(cell.kind === "rack" && locs.length ? locs : null)}
            />
          </div>
        ) : null}
      </Panel>

      <div className="stack">
        {task ? (
          <Panel title={`${task.huCode} · ${task.skuName}`}>
            <div className="stack">
              <div className={`big-target${override ? " tone-warn" : ""}`}>
                <span className="sub">{override ? "Your choice" : "Suggested bin"}</span>
                <span className="code">{override?.code ?? task.suggestedCode ?? "—"}</span>
                <span className="sub">
                  Zone {task.zone} · {ZONE_META[task.zone].label} · {task.qty} units
                </span>
              </div>
              {!task.suggestedLocationId && !override ? (
                <p className="warn-text small">No free bin in a compatible zone. Pick one on the map or free up space.</p>
              ) : null}
              <button
                className="btn btn-primary btn-lg btn-block"
                disabled={busy || !target}
                onClick={async () => {
                  const r = await run(
                    () => api.post<PutawayTask>(`/warehouse/putaway/${task.id}/confirm`, { locationId: override?.id }),
                    (x) => `${x.huCode} stored in ${x.confirmedCode}`,
                  );
                  if (r) setSelectedId(null);
                }}
              >
                Confirm stored in {override?.code ?? task.suggestedCode}
              </button>
              {override ? (
                <button className="btn btn-ghost btn-sm" onClick={() => setOverride(null)}>
                  Back to suggestion
                </button>
              ) : null}
            </div>
          </Panel>
        ) : null}
        <Panel title={rack ? `Rack ${rack[0]!.code.replace(/-\d+$/, "")}` : "Choose a different bin"}>
          {rack ? (
            <div className="bin-grid">
              {rack.map((l) => {
                const wrongZone = task ? (task.zone === "H") !== (l.zone === "H") : false;
                return (
                  <button
                    key={l.id}
                    className={`bin-btn${override?.id === l.id ? " is-on" : ""}`}
                    disabled={!task || l.occupied >= l.capacity || wrongZone}
                    title={wrongZone ? "Hazmat must go to hazmat bins only" : l.refs.join(", ")}
                    onClick={() => setOverride(l)}
                  >
                    {l.code}
                    <small>
                      L{l.level} · {l.occupied}/{l.capacity}
                      {l.zone ? ` · ${l.zone}` : ""}
                    </small>
                  </button>
                );
              })}
            </div>
          ) : (
            <Empty>Tap a rack on the map to see its bins</Empty>
          )}
        </Panel>
      </div>
    </div>
  );
}
