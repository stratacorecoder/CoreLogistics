import {
  formatDuration,
  humanize,
  type DockPurpose,
  type DockSuggestion,
  type ExpectedTrip,
  type GateVisit,
  type LocationStatus,
  type SiteBoard,
} from "@corelogistics/contracts";
import {
  ActorBadge,
  api,
  Empty,
  ErrorNote,
  Field,
  fmtDateTime,
  fmtTime,
  fromNow,
  MapLegend,
  Modal,
  Panel,
  Pill,
  qs,
  LoginPage,
  useAuth,
  Shell,
  SiteMap,
  SitePicker,
  Tabs,
  useAction,
  useApi,
  useLocalState,
  useNow,
  useRefs,
  type Refs,
} from "@corelogistics/ui";
import { useCallback, useMemo, useState } from "react";

type Side = "expected" | "log";

export default function App() {
  const { user, ready, signIn, signOut } = useAuth("gate");
  const refs = useRefs();
  const [siteId, setSiteIdRaw] = useLocalState<string | null>("gate.site", null);
  const setSiteId = useCallback((id: string) => setSiteIdRaw(id), [setSiteIdRaw]);
  if (!ready) return null;
  if (!user) return <LoginPage onSubmit={signIn} />;

  return (
    <Shell
      mark="GT"
      title="CoreLogistics"
      role="Gate & Yard"
      onSwitchRole={() => void signOut()}
      right={
        <>
          <SitePicker sites={refs.sites} value={siteId} onChange={setSiteId} />
          <ActorBadge placeholder="Guard name" />
        </>
      }
    >
      {siteId ? <GateDesk key={siteId} siteId={siteId} refs={refs} /> : null}
    </Shell>
  );
}

function GateDesk({ siteId, refs }: { siteId: string; refs: Refs }) {
  const now = useNow(30_000);
  const expected = useApi<ExpectedTrip[]>(`/gate/expected${qs({ siteId })}`);
  const visits = useApi<GateVisit[]>(`/gate/visits${qs({ siteId, open: "true" })}`);
  const log = useApi<GateVisit[]>(`/gate/visits${qs({ siteId, limit: 40 })}`);
  const board = useApi<SiteBoard>(`/sites/${siteId}/board`);
  const [side, setSide] = useState<Side>("expected");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkInFor, setCheckInFor] = useState<{ plate: string; tripId?: string } | null>(null);

  const selected = visits.data?.find((v) => v.id === selectedId) ?? null;
  const highlight = useMemo(
    () => (selected ? [selected.yardLocationId, selected.dock?.locationId].filter((x): x is string => Boolean(x)) : []),
    [selected],
  );

  const onCell = (locs: LocationStatus[]) => {
    const ids = new Set(locs.map((l) => l.id));
    const v = visits.data?.find((x) => (x.yardLocationId && ids.has(x.yardLocationId) && x.status === "in_yard") || (x.dock && ids.has(x.dock.locationId)));
    if (v) setSelectedId(v.id);
  };

  return (
    <div className="three" style={{ gridTemplateColumns: "340px minmax(0, 1fr) 360px" }}>
      <div className="stack" style={{ overflow: "hidden" }}>
        <QuickGate siteId={siteId} onCheckIn={(plate) => setCheckInFor({ plate })} onCheckedOut={() => setSelectedId(null)} />
        <Panel
          scroll
          className="grow"
          title={
            <Tabs<Side>
              value={side}
              onChange={setSide}
              options={[
                { id: "expected", label: "Expected", badge: expected.data?.length },
                { id: "log", label: "Gate log" },
              ]}
            />
          }
        >
          {side === "expected" ? (
            expected.data?.length ? (
              <div className="list">
                {expected.data.map((t) => (
                  <button
                    key={`${t.id}-${t.direction}`}
                    className={`item${t.delayed ? " is-alert" : ""}`}
                    disabled={!t.plate}
                    onClick={() => t.plate && setCheckInFor({ plate: t.plate, tripId: t.id })}
                  >
                    <div className="row-between">
                      <span className="item-title mono">{t.plate ?? "No vehicle yet"}</span>
                      <span className={`dir-tag dir-${t.direction}`}>{t.direction === "arriving" ? "Arriving" : "Collecting"}</span>
                    </div>
                    <div className="item-meta">
                      {t.code} · {refs.siteCode(t.originSiteId)} → {refs.siteCode(t.destinationSiteId)} · {refs.driverName(t.driverId)}
                    </div>
                    <div className="row-between">
                      <span className="item-meta">
                        {t.direction === "arriving"
                          ? t.status === "in_transit"
                            ? `ETA ${fmtTime(t.etaAt)} (${fromNow(t.etaAt, now)})`
                            : `Not departed · due ${fmtTime(t.plannedArrival)}`
                          : `Departs ${fmtTime(t.plannedDeparture)} (${fromNow(t.plannedDeparture, now)})`}
                      </span>
                      {t.delayed ? <Pill tone="danger">+{t.delayMinutes}m</Pill> : <Pill value={t.status} />}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <Empty>Nothing expected right now</Empty>
            )
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Plate</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Dwell</th>
                </tr>
              </thead>
              <tbody>
                {(log.data ?? []).map((v) => (
                  <tr key={v.id}>
                    <td>
                      <div className="mono strong">{v.plate}</div>
                      <div className="muted small">{v.tripCode ?? "no trip"}</div>
                    </td>
                    <td className="small">
                      {fmtTime(v.checkInAt)} {v.sourceIn !== "manual" ? <Pill tone="info">{v.sourceIn}</Pill> : null}
                    </td>
                    <td className="small">{v.checkOutAt ? fmtTime(v.checkOutAt) : <Pill value={v.status} />}</td>
                    <td className="small">{formatDuration(v.dwellMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel title={board.data ? `${board.data.site.code} yard & docks` : "Yard"} actions={<MapLegend kinds={["gate", "dock_door", "yard_slot", "staging"]} />}>
        <ErrorNote error={board.error} />
        {board.data && board.data.layout.cells.length ? (
          <div className="map-wrap" style={{ maxHeight: "calc(100vh - 150px)" }}>
            <SiteMap
              layout={board.data.layout}
              locations={board.data.locations}
              now={now}
              highlight={highlight}
              onCellClick={(_, locs) => onCell(locs)}
            />
          </div>
        ) : board.data ? (
          <Empty>No layout for this site yet.</Empty>
        ) : null}
      </Panel>

      <div className="stack" style={{ overflow: "hidden" }}>
        {selected && board.data ? (
          <VisitPanel visit={selected} board={board.data} onClose={() => setSelectedId(null)} />
        ) : null}
        <Panel title={`On site (${visits.data?.length ?? 0})`} scroll className="grow">
          {visits.data?.length ? (
            <div className="list">
              {visits.data.map((v) => (
                <button key={v.id} className={`item${v.id === selectedId ? " is-selected" : ""}${v.tripId && v.dwellMinutes > 240 ? " is-alert" : ""}`} onClick={() => setSelectedId(v.id)}>
                  <div className="row-between">
                    <span className="item-title mono">{v.plate}</span>
                    <Pill value={v.status} />
                  </div>
                  <div className="item-meta">
                    {v.dock ? `Dock ${v.dock.code} · ${v.dock.purpose}` : v.yardCode ? `Yard ${v.yardCode}` : "No slot"}
                    {v.tripCode ? ` · ${v.tripCode}` : ""}
                  </div>
                  <div className="item-meta">{formatDuration(v.dwellMinutes)} on site</div>
                </button>
              ))}
            </div>
          ) : (
            <Empty>Yard is empty</Empty>
          )}
        </Panel>
      </div>

      {checkInFor && board.data ? (
        <CheckInModal
          siteId={siteId}
          board={board.data}
          initial={checkInFor}
          expected={expected.data ?? []}
          onClose={() => setCheckInFor(null)}
          onDone={(v) => {
            setCheckInFor(null);
            setSelectedId(v.id);
          }}
        />
      ) : null}
    </div>
  );
}

function QuickGate({ siteId, onCheckIn, onCheckedOut }: { siteId: string; onCheckIn: (plate: string) => void; onCheckedOut: () => void }) {
  const [plate, setPlate] = useState("");
  const { busy, run } = useAction();
  return (
    <Panel title="Gate">
      <div className="form">
        <input
          className="input plate-input"
          placeholder="PLATE"
          value={plate}
          onChange={(e) => setPlate(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && plate && onCheckIn(plate)}
        />
        <div className="form-2">
          <button className="btn btn-primary btn-lg" disabled={!plate} onClick={() => onCheckIn(plate)}>
            Check in
          </button>
          <button
            className="btn btn-warn btn-lg"
            disabled={!plate || busy}
            onClick={async () => {
              const v = await run(() => api.post<GateVisit>("/gate/check-out", { siteId, plate }), (r) => `${r.plate} checked out`);
              if (v) {
                setPlate("");
                onCheckedOut();
              }
            }}
          >
            Check out
          </button>
        </div>
      </div>
    </Panel>
  );
}

function CheckInModal({
  siteId,
  board,
  initial,
  expected,
  onClose,
  onDone,
}: {
  siteId: string;
  board: SiteBoard;
  initial: { plate: string; tripId?: string };
  expected: ExpectedTrip[];
  onClose: () => void;
  onDone: (v: GateVisit) => void;
}) {
  const { busy, run } = useAction();
  const [plate, setPlate] = useState(initial.plate);
  const [tripId, setTripId] = useState(initial.tripId ?? "");
  const [seal, setSeal] = useState("");
  const [notes, setNotes] = useState("");
  const [slot, setSlot] = useState("");
  const freeSlots = board.locations.filter((l) => l.kind === "yard_slot" && l.occupied === 0);
  const forPlate = expected.filter((t) => t.plate === plate);

  return (
    <Modal title="Check in" onClose={onClose}>
      <div className="form">
        <Field label="Plate">
          <input className="input plate-input" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} />
        </Field>
        <Field label="Trip" hint="Leave on auto to match the plate against expected trips">
          <select className="select" value={tripId} onChange={(e) => setTripId(e.target.value)}>
            <option value="">Auto-match{forPlate.length ? ` (${forPlate[0]!.code})` : ""}</option>
            {expected.map((t) => (
              <option key={`${t.id}-${t.direction}`} value={t.id}>
                {t.code} · {t.plate ?? "—"} · {humanize(t.direction)}
              </option>
            ))}
          </select>
        </Field>
        <div className="form-2">
          <Field label="Seal number">
            <input className="input" value={seal} onChange={(e) => setSeal(e.target.value)} />
          </Field>
          <Field label="Yard slot">
            <select className="select" value={slot} onChange={(e) => setSlot(e.target.value)}>
              <option value="">Auto-assign ({freeSlots.length} free)</option>
              {freeSlots.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Notes">
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <button
          className="btn btn-primary btn-lg"
          disabled={busy || !plate}
          onClick={async () => {
            const v = await run(
              () =>
                api.post<GateVisit>("/gate/check-in", {
                  siteId,
                  plate,
                  sealNo: seal,
                  notes,
                  tripId: tripId || undefined,
                  yardLocationId: slot || undefined,
                }),
              (r) => `${r.plate} in · ${r.yardCode ? `yard ${r.yardCode}` : "no free slot"}${r.tripCode ? ` · ${r.tripCode}` : ""}`,
            );
            if (v) onDone(v);
          }}
        >
          Open gate
        </button>
      </div>
    </Modal>
  );
}

function VisitPanel({ visit, board, onClose }: { visit: GateVisit; board: SiteBoard; onClose: () => void }) {
  const { busy, run } = useAction();
  const suggestion = useApi<DockSuggestion>(visit.dock ? null : `/gate/visits/${visit.id}/dock-suggestion`);
  const [purpose, setPurpose] = useState<DockPurpose | "">("");
  const [seal, setSeal] = useState("");
  const [moving, setMoving] = useState(false);
  const docks = board.locations.filter((l) => l.kind === "dock_door");
  const freeSlots = board.locations.filter((l) => l.kind === "yard_slot" && l.occupied === 0);

  const assign = (locationId?: string) =>
    run(
      () => api.post<GateVisit>(`/gate/visits/${visit.id}/dock`, { locationId, purpose: purpose || undefined }),
      (r) => `${r.plate} → dock ${r.dock?.code}`,
    );

  return (
    <Panel title={<span className="mono">{visit.plate}</span>} actions={<button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>}>
      <div className="stack">
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            <Pill value={visit.status} />
          </dd>
          <dt>Trip</dt>
          <dd>{visit.tripCode ?? "—"}</dd>
          <dt>Checked in</dt>
          <dd>
            {fmtDateTime(visit.checkInAt)} · {formatDuration(visit.dwellMinutes)}
          </dd>
          <dt>Seal in</dt>
          <dd>{visit.sealIn || "—"}</dd>
          <dt>Position</dt>
          <dd>{visit.dock ? `Dock ${visit.dock.code} (${visit.dock.purpose})` : visit.yardCode ? `Yard ${visit.yardCode}` : "No slot"}</dd>
        </dl>

        {visit.dock ? (
          <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => api.post(`/gate/visits/${visit.id}/dock/release`), "Dock released, back to yard")}>
            Release dock {visit.dock.code}
          </button>
        ) : (
          <div className="form">
            <div className="row-between">
              <span className="field-label">Assign dock</span>
              <select className="select" style={{ width: 130 }} value={purpose} onChange={(e) => setPurpose(e.target.value as DockPurpose | "")}>
                <option value="">Auto purpose</option>
                <option value="unload">Unload</option>
                <option value="load">Load</option>
              </select>
            </div>
            {suggestion.data ? <p className="small muted">{suggestion.data.reason}</p> : null}
            <div className="dock-grid">
              {docks.map((d) => (
                <button
                  key={d.id}
                  className={`dock-btn${suggestion.data?.locationId === d.id ? " is-suggested" : ""}`}
                  disabled={busy || d.occupied > 0}
                  onClick={() => assign(d.id)}
                >
                  {d.code}
                  <small>{d.occupied > 0 ? d.refs[0] : d.zone ? `zone ${d.zone}` : "free"}</small>
                </button>
              ))}
            </div>
            {suggestion.data?.locationId ? (
              <button className="btn btn-primary" disabled={busy} onClick={() => assign(suggestion.data!.locationId!)}>
                Send to suggested {suggestion.data.code}
              </button>
            ) : null}
            {visit.status === "in_yard" ? (
              moving ? (
                <div className="dock-grid">
                  {freeSlots.map((l) => (
                    <button
                      key={l.id}
                      className="dock-btn"
                      disabled={busy}
                      onClick={async () => {
                        await run(() => api.post(`/gate/visits/${visit.id}/yard`, { locationId: l.id }), `Moved to ${l.code}`);
                        setMoving(false);
                      }}
                    >
                      {l.code}
                    </button>
                  ))}
                </div>
              ) : (
                <button className="btn btn-ghost btn-sm" onClick={() => setMoving(true)}>
                  Move in yard
                </button>
              )
            ) : null}
          </div>
        )}

        <div className="form">
          <Field label="Seal out">
            <input className="input" value={seal} onChange={(e) => setSeal(e.target.value)} />
          </Field>
          <button
            className="btn btn-warn"
            disabled={busy}
            onClick={async () => {
              const r = await run(() => api.post<GateVisit>("/gate/check-out", { visitId: visit.id, sealNo: seal }), (v) => `${v.plate} checked out`);
              if (r) onClose();
            }}
          >
            Check out
          </button>
        </div>
      </div>
    </Panel>
  );
}
