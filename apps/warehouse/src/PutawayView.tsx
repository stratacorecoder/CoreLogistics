import { ZONE_META, type LocationStatus, type PutawayTask, type ScanEntryMethod, type SiteBoard } from "@corelogistics/contracts";
import {
  api,
  classifyConfirmError,
  Empty,
  fromNow,
  MapLegend,
  newConfirmRequestId,
  Panel,
  qs,
  ScanButton,
  SiteMap,
  useAction,
  useApi,
  type ConfirmFailure,
} from "@corelogistics/ui";
import { useEffect, useMemo, useState } from "react";

export function PutawayView({ siteId, canOverride = false }: { siteId: string; canOverride?: boolean }) {
  const tasks = useApi<PutawayTask[]>(`/warehouse/putaway${qs({ siteId, status: "open" })}`);
  const board = useApi<SiteBoard>(`/sites/${siteId}/board`);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [override, setOverride] = useState<LocationStatus | null>(null);
  const [rack, setRack] = useState<LocationStatus[] | null>(null);
  const [huCode, setHuCode] = useState("");
  const [binCode, setBinCode] = useState("");
  const [method, setMethod] = useState<ScanEntryMethod>("keyboard");
  const [detectedHu, setDetectedHu] = useState<string | null>(null);
  const [detectedBin, setDetectedBin] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(newConfirmRequestId);
  const [failure, setFailure] = useState<ConfirmFailure | null>(null);
  const { busy, run } = useAction();

  const task = tasks.data?.find((t) => t.id === selectedId) ?? null;
  useEffect(() => {
    if ((!selectedId || !task) && tasks.data?.length) setSelectedId(tasks.data[0]!.id);
  }, [tasks.data, selectedId, task]);
  useEffect(() => {
    setOverride(null);
    setRack(null);
    setHuCode("");
    setBinCode("");
    setDetectedHu(null);
    setDetectedBin(null);
    setReason("");
    setFailure(null);
    setMethod("keyboard");
    setRequestId(newConfirmRequestId());
  }, [selectedId]);

  const target = override?.id ?? task?.suggestedLocationId ?? null;
  const highlight = useMemo(() => [target, task?.fromLocationId].filter((x): x is string => Boolean(x)), [target, task]);

  const confirm = (overrideMode: boolean) => {
    if (!task) return;
    void run(async () => {
      try {
        const result = await api.post<PutawayTask>(`/warehouse/putaway/${task.id}/confirm`, {
          mode: overrideMode ? "override" : "match",
          requestId,
          entryMethod: method,
          huBarcode: huCode.trim() || undefined,
          binBarcode: binCode.trim() || undefined,
          ...(overrideMode ? { reason: reason.trim() } : {}),
        });
        setFailure(null);
        setSelectedId(null);
        return result;
      } catch (err) {
        setFailure(classifyConfirmError(err));
        throw err;
      }
    }, (result) => `Stock confirmed: ${result.huCode} stored in ${result.confirmedCode}`);
  };

  return (
    <div className="three" style={{ gridTemplateColumns: "320px minmax(0, 1fr) 340px" }}>
      <Panel title={`Open tasks (${tasks.data?.length ?? 0})`} scroll>
        {tasks.data?.length ? (
          <div className="list">
            {tasks.data.map((t) => (
              <button key={t.id} className={`item${t.id === selectedId ? " is-selected" : ""}`} onClick={() => setSelectedId(t.id)}>
                <div className="row-between">
                  <span className="item-title mono">{t.huCode}</span>
                  <span className={`wh-task-bin-badge mono${t.id === selectedId ? " is-active" : ""}`}>
                    {t.suggestedCode ?? "?"}
                  </span>
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
              <div className={`big-target${override ? " tone-warn" : " is-suggested"}`}>
                <div className="wh-target-badge-row">
                  {!override ? <span className="wh-target-dot" /> : null}
                  <span className="sub">{override ? "Manual choice" : "Suggested bin"}</span>
                </div>
                <span className="code">{override?.code ?? task.suggestedCode ?? "—"}</span>
                <span className="sub">
                  Zone {task.zone} · {ZONE_META[task.zone].label} · {task.qty} units
                </span>
              </div>
              {!task.suggestedLocationId && !override ? (
                <p className="warn-text small">No free bin in a compatible zone. Pick one on the map or free up space.</p>
              ) : null}
              <label className="small" htmlFor={`put-hu-${task.id}`}>Unit barcode</label>
              <div className="row">
                <input
                  id={`put-hu-${task.id}`}
                  className="input scan-input grow"
                  value={huCode}
                  autoComplete="off"
                  onChange={(event) => {
                    setHuCode(event.target.value);
                    setMethod("keyboard");
                    setDetectedHu(null);
                  }}
                />
                <ScanButton
                  title="Scan unit barcode"
                  onScan={(scanned, via) => {
                    setHuCode(scanned);
                    setMethod(via === "manual" ? "manual" : "camera");
                    setDetectedHu(scanned);
                  }}
                />
              </div>
              <label className="small" htmlFor={`put-bin-${task.id}`}>Destination bin barcode</label>
              <div className="row">
                <input
                  id={`put-bin-${task.id}`}
                  className="input scan-input grow"
                  value={binCode}
                  autoComplete="off"
                  onChange={(event) => {
                    setBinCode(event.target.value);
                    setMethod("keyboard");
                    setDetectedBin(null);
                    setOverride(null);
                  }}
                />
                <ScanButton
                  title="Scan destination bin barcode"
                  onScan={(scanned, via) => {
                    setBinCode(scanned);
                    setMethod(via === "manual" ? "manual" : "camera");
                    setDetectedBin(scanned);
                    const matched = board.data?.locations.find((location) => location.code.toUpperCase() === scanned.toUpperCase());
                    setOverride(matched ?? null);
                  }}
                />
              </div>
              {detectedHu || detectedBin ? (
                <p className="small">
                  Code detected{detectedHu ? `: unit ${detectedHu}` : ""}{detectedBin ? `${detectedHu ? ", " : ": "}bin ${detectedBin}` : ""}. Stock is not confirmed until you submit.
                </p>
              ) : null}
              <button
                className="btn btn-primary btn-lg"
                disabled={busy || !huCode.trim() || !binCode.trim()}
                onClick={() => void confirm(false)}
              >
                Confirm stored in {override?.code ?? (binCode.trim() || task.suggestedCode)}
              </button>
              {failure ? (
                <div className="error-note" role="alert">
                  <strong>{failure.title}.</strong> {failure.message}
                  {failure.retry ? (
                    <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} disabled={busy} onClick={() => void confirm(false)}>
                      Retry same request
                    </button>
                  ) : null}
                </div>
              ) : null}
              {canOverride ? (
                <div className="row">
                  <input className="input grow" placeholder="Tower reason for bypassing the labels" value={reason} onChange={(event) => setReason(event.target.value)} />
                  <button className="btn btn-ghost" disabled={busy || reason.trim().length < 3} onClick={() => void confirm(true)}>
                    Tower review
                  </button>
                </div>
              ) : null}
              {override ? (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setOverride(null);
                    setBinCode(task.suggestedCode ?? "");
                    setDetectedBin(null);
                    setMethod("manual");
                  }}
                >
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
                    onClick={() => {
                      setOverride(l);
                      setBinCode(l.code);
                      setMethod("manual");
                      setDetectedBin(l.code);
                    }}
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
