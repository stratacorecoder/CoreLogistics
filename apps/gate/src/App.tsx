import {
  formatDuration,
  humanize,
  type DockAppointment,
  type DockPurpose,
  type DockSuggestion,
  type ExpectedTrip,
  type GateInspectionStatus,
  type GateVisit,
  type LocationStatus,
  type NudgeTargetRole,
  type Site,
  type SiteBoard,
} from "@corelogistics/contracts";
import {
  ActorBadge,
  api,
  DeskNotice,
  Empty,
  ErrorNote,
  Field,
  fmtDateTime,
  fmtTime,
  fromLocalInput,
  fromNow,
  LoginPage,
  MapLegend,
  Modal,
  NudgeBanner,
  Panel,
  PhotoProofPicker,
  Pill,
  qs,
  SendNudgeModal,
  Shell,
  SiteMap,
  SitePicker,
  Tabs,
  toLocalInput,
  useAction,
  useApi,
  useAuth,
  useFitMapCells,
  useLocalState,
  useNow,
  useRefs,
  WaybillModal,
  type MapLens,
  type Refs,
} from "@corelogistics/ui";
import {
  ArrowRightLeft,
  BellRing,
  Camera,
  CheckCircle2,
  DoorOpen,
  FileText,
  Navigation,
  Printer,
  ShieldAlert,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { GatePassModal } from "./GatePassModal.js";
import { GateTimeline, type SlotBookDraft } from "./GateTimeline.js";

const SiteMap3D = lazy(() => import("@corelogistics/ui").then((m) => ({ default: m.SiteMap3D })));

type Side = "expected" | "appointments" | "log";
type ApptView = "timeline" | "list";
type QueueSort = "priority" | "recent";
type GatePosture = "normal" | "express" | "audit";

function detentionExposureFor(dwellMinutes: number): number {
  if (dwellMinutes <= 120) return 0;
  return Math.min(20_000, Math.round((dwellMinutes - 120) * 25));
}

function visitPriorityScore(v: GateVisit): number {
  const holdBoost = v.inspectionStatus === "hold" ? 1_000_000 : 0;
  const overtimeBoost = v.dwellMinutes > 120 ? 100_000 : 0;
  const yardWaitingBoost = v.status === "in_yard" ? 10_000 : 0;
  return holdBoost + overtimeBoost + yardWaitingBoost + v.dwellMinutes;
}

export default function App() {
  const { user, ready, signIn, signOut } = useAuth("gate");
  const refs = useRefs(Boolean(user));
  const [siteId, setSiteIdRaw] = useLocalState<string | null>("gate.site", null);
  const setSiteId = useCallback((id: string) => setSiteIdRaw(id), [setSiteIdRaw]);
  if (!ready) return null;
  if (!user) return <LoginPage onSubmit={signIn} />;

  return (
    <>
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
      <DeskNotice desk="gate" />
    </>
  );
}

function GateDesk({ siteId, refs }: { siteId: string; refs: Refs }) {
  const { busy, run } = useAction();
  const now = useNow(30_000);
  const gateVisitEvent = (e: { type: string; siteId?: string | null }) =>
    (!e.siteId || e.siteId === siteId) &&
    (e.type.startsWith("gate.") || e.type.startsWith("dock.") || e.type.startsWith("yard.") || e.type === "device.read");

  const expected = useApi<ExpectedTrip[]>(`/gate/expected${qs({ siteId })}`, {
    live: (e) => e.type.startsWith("trip.") || e.type.startsWith("gate.") || e.type === "device.read",
  });
  const appointments = useApi<DockAppointment[]>(`/gate/appointments${qs({ siteId })}`, {
    live: (e) =>
      (!e.siteId || e.siteId === siteId) &&
      (e.type.startsWith("appointment.") || e.type.startsWith("gate.") || e.type === "copilot.applied" || e.type === "device.read"),
  });
  const visits = useApi<GateVisit[]>(`/gate/visits${qs({ siteId, open: "true" })}`, { live: gateVisitEvent });
  const log = useApi<GateVisit[]>(`/gate/visits${qs({ siteId, limit: 40 })}`, { live: gateVisitEvent });
  const board = useApi<SiteBoard>(`/sites/${siteId}/board`, {
    live: (e) => gateVisitEvent(e) || (e.type === "layout.saved" && e.siteId === siteId),
  });

  const [side, setSide] = useState<Side>("expected");
  const [apptView, setApptView] = useState<ApptView>("timeline");
  const [queueSort, setQueueSort] = useState<QueueSort>("priority");
  const [posture, setPosture] = useLocalState<GatePosture>("gate.posture", "normal");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lens, setLens] = useState<MapLens>("standard");
  const [view3D, setView3D] = useState(false);
  const [jockeyMode, setJockeyMode] = useState(false);
  const [pendingMove, setPendingMove] = useState<{ visitId: string; plate: string; target: LocationStatus } | null>(null);

  const [checkInFor, setCheckInFor] = useState<{ plate: string; tripId?: string; yardLocationId?: string } | null>(null);
  const [bookingDraft, setBookingDraft] = useState<SlotBookDraft | boolean>(false);
  const [passVisitId, setPassVisitId] = useState<string | null>(null);
  const [waybillTripId, setWaybillTripId] = useState<string | null>(null);
  const [nudgeTarget, setNudgeTarget] = useState<{
    targetRole: NudgeTargetRole;
    tripId?: string | null;
    locationCode?: string | null;
  } | null>(null);

  const activeVisits = visits.data ?? [];
  const selected = activeVisits.find((v) => v.id === selectedId) ?? null;
  const passVisit =
    activeVisits.find((v) => v.id === passVisitId) ??
    (log.data ?? []).find((v) => v.id === passVisitId) ??
    null;

  const sortedVisits = useMemo(() => {
    const list = [...activeVisits];
    if (queueSort === "priority") {
      return list.sort((a, b) => visitPriorityScore(b) - visitPriorityScore(a));
    }
    return list.sort((a, b) => Date.parse(b.checkInAt) - Date.parse(a.checkInAt));
  }, [activeVisits, queueSort]);

  const dockLocations = useMemo(
    () => (board.data?.locations ?? []).filter((l) => l.kind === "dock_door" && l.active),
    [board.data?.locations],
  );
  const freeDocksCount = dockLocations.filter((d) => d.occupied === 0).length;
  const inYardVisits = activeVisits.filter((v) => v.status === "in_yard" || !v.dock);
  const atDockVisits = activeVisits.filter((v) => v.status === "at_dock" && Boolean(v.dock));
  const overtimeVisits = activeVisits.filter((v) => v.dwellMinutes > 120);
  const detentionTotal = overtimeVisits.reduce((acc, v) => acc + detentionExposureFor(v.dwellMinutes), 0);
  const longestDwell = activeVisits.length ? Math.max(...activeVisits.map((v) => v.dwellMinutes)) : 0;
  const delayedExpectedCount = (expected.data ?? []).filter((t) => t.delayed).length;
  const holdCount = activeVisits.filter((v) => v.inspectionStatus === "hold").length;

  const highlight = useMemo(() => {
    if (!selected) return [];
    const own = [selected.yardLocationId, selected.dock?.locationId].filter((x): x is string => Boolean(x));
    if (jockeyMode && board.data) {
      const candidateIds = board.data.locations
        .filter((l) => l.active && l.occupied === 0 && (l.kind === "dock_door" || (selected.status === "in_yard" && l.kind === "yard_slot")))
        .map((l) => l.id);
      return [...own, ...candidateIds];
    }
    return own;
  }, [selected, jockeyMode, board.data]);

  const executeCellMove = async (visit: GateVisit, target: LocationStatus) => {
    setPendingMove(null);
    if (target.kind === "dock_door") {
      await run(
        () => api.post<GateVisit>(`/gate/visits/${visit.id}/dock`, { locationId: target.id }),
        `${visit.plate} dispatched → Dock ${target.code}`,
      );
      return;
    }
    if (target.kind === "yard_slot" && visit.status === "in_yard") {
      await run(
        () => api.post<GateVisit>(`/gate/visits/${visit.id}/yard`, { locationId: target.id }),
        `${visit.plate} relocated → Yard ${target.code}`,
      );
    }
  };

  const onCell = (locs: LocationStatus[]) => {
    const ids = new Set(locs.map((l) => l.id));
    const occupier = activeVisits.find(
      (x) => (x.yardLocationId && ids.has(x.yardLocationId) && x.status === "in_yard") || (x.dock && ids.has(x.dock.locationId)),
    );
    if (occupier) {
      setPendingMove(null);
      setSelectedId(occupier.id);
      return;
    }

    const freeDock = locs.find((l) => l.kind === "dock_door" && l.active && l.occupied === 0);
    const freeYard = locs.find((l) => l.kind === "yard_slot" && l.active && l.occupied === 0);
    const target = freeDock ?? freeYard;

    if (selected && target) {
      if (target.kind === "yard_slot" && selected.status !== "in_yard") return;
      if (jockeyMode) {
        void executeCellMove(selected, target);
      } else {
        setPendingMove({ visitId: selected.id, plate: selected.plate, target });
      }
      return;
    }

    if (!selected && freeYard) {
      setCheckInFor({ plate: "", yardLocationId: freeYard.id });
    }
  };

  const layout = board.data?.layout;
  const { ref: mapRef, cell } = useFitMapCells(layout?.cols ?? 0, layout?.rows ?? 0);
  const currentSite: Site | undefined = board.data?.site ?? refs.sites?.find((s) => s.id === siteId);

  return (
    <div className="gate-desk-shell">
      <NudgeBanner role="gate" siteId={siteId} />

      <div className="gate-command-strip">
        <div className="gate-kpi-row">
          <div className="gate-kpi-card">
            <span className="gate-kpi-label">IN YARD</span>
            <strong className="gate-kpi-val">{inYardVisits.length}</strong>
            <span className="gate-kpi-sub">Longest {longestDwell ? formatDuration(longestDwell) : "—"}</span>
          </div>
          <div className="gate-kpi-card">
            <span className="gate-kpi-label">AT DOCK</span>
            <strong className="gate-kpi-val">
              {atDockVisits.length} / {dockLocations.length}
            </strong>
            <span className="gate-kpi-sub">{freeDocksCount} door(s) free</span>
          </div>
          <div className="gate-kpi-card">
            <span className="gate-kpi-label">EXPECTED</span>
            <strong className="gate-kpi-val">{expected.data?.length ?? 0}</strong>
            <span className="gate-kpi-sub" style={delayedExpectedCount > 0 ? { color: "var(--danger)", fontWeight: 600 } : undefined}>
              {delayedExpectedCount > 0 ? `${delayedExpectedCount} delayed` : "On schedule"}
            </span>
          </div>
          <div className={`gate-kpi-card${overtimeVisits.length || holdCount ? " is-alert" : ""}`}>
            <span className="gate-kpi-label">DETENTION & HOLDS</span>
            <strong className="gate-kpi-val" style={{ color: detentionTotal > 0 ? "var(--danger)" : undefined }}>
              ₱{detentionTotal.toLocaleString("en-US")}
            </strong>
            <span className="gate-kpi-sub">
              {overtimeVisits.length} &gt;2h · {holdCount} hold
            </span>
          </div>
        </div>

        <div className="gate-posture-controls">
          <div className="gate-segmented" role="group" aria-label="Gate operating posture">
            {(
              [
                { id: "normal", label: "Standard Gate" },
                { id: "express", label: "Express Flow" },
                { id: "audit", label: "Inspection Hold" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={posture === opt.id ? "is-active" : ""}
                onClick={() => setPosture(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setNudgeTarget({ targetRole: "warehouse", locationCode: selected?.dock?.code ?? selected?.yardCode })}
          >
            <BellRing size={13} /> Tap & Nudge
          </button>
        </div>
      </div>

      <div className="three gate-board">
        <div className="stack gate-rail">
          <QuickGate
            siteId={siteId}
            posture={posture}
            onCheckIn={(plate) => setCheckInFor({ plate })}
            onCheckedOut={() => setSelectedId(null)}
          />
          <Panel
            scroll
            className="grow gate-side-panel"
            actions={
              side === "appointments" ? (
                <div className="row" style={{ gap: 4 }}>
                  <div className="gate-mini-toggle">
                    <button
                      type="button"
                      className={apptView === "timeline" ? "is-active" : ""}
                      onClick={() => setApptView("timeline")}
                    >
                      Timeline
                    </button>
                    <button
                      type="button"
                      className={apptView === "list" ? "is-active" : ""}
                      onClick={() => setApptView("list")}
                    >
                      List
                    </button>
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={() => setBookingDraft(true)}>
                    Book
                  </button>
                </div>
              ) : null
            }
            title={
              <Tabs<Side>
                value={side}
                onChange={setSide}
                options={[
                  { id: "expected", label: "Expected", badge: expected.data?.length },
                  {
                    id: "appointments",
                    label: "Appointments",
                    badge: (appointments.data ?? []).filter((a) => a.status === "scheduled").length || undefined,
                  },
                  { id: "log", label: "Gate log" },
                ]}
              />
            }
          >
            {side === "appointments" ? (
              apptView === "timeline" && board.data ? (
                <GateTimeline
                  appointments={appointments.data ?? []}
                  locations={board.data.locations}
                  visits={activeVisits}
                  now={now}
                  compact
                  onBookSlot={(draft) => setBookingDraft(draft)}
                  onCheckIn={(plate, tripId) => setCheckInFor({ plate, tripId })}
                  onViewWaybill={(id) => setWaybillTripId(id)}
                />
              ) : appointments.data?.length ? (
                <div className="list">
                  {appointments.data.map((a) => (
                    <div key={a.id} className="item">
                      <div className="row-between">
                        <span className="item-title mono">{a.plate}</span>
                        <Pill value={a.status} />
                      </div>
                      <div className="item-meta">
                        {a.carrier ? `${a.carrier} · ` : ""}
                        {a.purpose} {a.locationCode ? `· Door ${a.locationCode}` : ""}
                      </div>
                      <div className="row-between" style={{ marginTop: 4, flexWrap: "wrap", gap: 4 }}>
                        <span className="muted small">
                          {fmtTime(a.windowStart)} – {fmtTime(a.windowEnd)} ({fromNow(a.windowStart, now)})
                        </span>
                        <div className="row gap-sm">
                          {a.tripId ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              style={{ padding: "2px 7px" }}
                              onClick={() => setWaybillTripId(a.tripId)}
                            >
                              Waybill
                            </button>
                          ) : null}
                          {a.status === "scheduled" ? (
                            <>
                              <button
                                className="btn btn-primary btn-sm"
                                style={{ padding: "2px 8px" }}
                                onClick={() => setCheckInFor({ plate: a.plate, tripId: a.tripId ?? undefined })}
                              >
                                Check in
                              </button>
                              <button
                                className="btn btn-ghost btn-sm"
                                style={{ padding: "2px 8px" }}
                                disabled={busy}
                                onClick={() => run(() => api.post(`/gate/appointments/${a.id}/cancel`), `${a.code} cancelled`)}
                              >
                                Cancel
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty>No dock appointments. Click "Book" to schedule one.</Empty>
              )
            ) : side === "expected" ? (
              expected.data?.length ? (
                <div className="list">
                  {expected.data.map((t) => (
                    <div key={`${t.id}-${t.direction}`} className={`gate-expected-item${t.delayed ? " is-delayed" : ""}`}>
                      <div className="row-between">
                        <span className="gate-expected-plate">{t.plate ?? "No vehicle yet"}</span>
                        <span className={`dir-badge ${t.direction === "arriving" ? "is-arriving" : "is-collecting"}`}>
                          {t.direction === "arriving" ? "Arriving" : "Collecting"}
                        </span>
                      </div>
                      <div className="gate-expected-route">
                        {t.code} · {refs.siteCode(t.originSiteId)} → {refs.siteCode(t.destinationSiteId)} · {refs.driverName(t.driverId)}
                      </div>
                      <div className="gate-expected-footer">
                        <span className="muted small">
                          {t.direction === "arriving"
                            ? t.status === "in_transit"
                              ? `ETA ${fmtTime(t.etaAt)} (${fromNow(t.etaAt, now)})`
                              : `Not departed · due ${fmtTime(t.plannedArrival)}`
                            : `Departs ${fmtTime(t.plannedDeparture)} (${fromNow(t.plannedDeparture, now)})`}
                        </span>
                        {t.delayed ? <span className="live-badge-delay">⏱ +{t.delayMinutes}m</span> : <Pill value={t.status} />}
                      </div>
                      <div className="row" style={{ gap: 6, marginTop: 4 }}>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          style={{ padding: "3px 9px", fontSize: 11.5 }}
                          disabled={!t.plate}
                          onClick={() => t.plate && setCheckInFor({ plate: t.plate, tripId: t.id })}
                        >
                          Check in
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: "3px 8px", fontSize: 11.5 }}
                          onClick={() => setWaybillTripId(t.id)}
                        >
                          <FileText size={12} /> Waybill
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty>Nothing expected right now</Empty>
              )
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Plate</th>
                      <th>In / Out</th>
                      <th>Dwell</th>
                      <th>Slip</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(log.data ?? []).map((v) => (
                      <tr key={v.id}>
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            <span className="mono strong">{v.plate}</span>
                            {v.inspectionStatus === "hold" ? <Pill tone="danger">HOLD</Pill> : null}
                            {v.proofPhotoIn || v.proofPhotoOut ? <Camera size={12} className="muted" /> : null}
                          </div>
                          <div className="muted small">{v.tripCode ?? "no trip"}</div>
                        </td>
                        <td className="small">
                          <div>
                            {fmtTime(v.checkInAt)} {v.sourceIn !== "manual" ? <Pill tone="info">{v.sourceIn}</Pill> : null}
                          </div>
                          <div className="muted">{v.checkOutAt ? fmtTime(v.checkOutAt) : "On site"}</div>
                        </td>
                        <td className="small">{formatDuration(v.dwellMinutes)}</td>
                        <td>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPassVisitId(v.id)}>
                            Pass
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <Panel
          title={board.data ? `${board.data.site.code} yard & docks` : "Yard"}
          actions={
            <div className="gate-map-toolbar">
              <div className="segmented" role="tablist" aria-label="Yard map lens">
                {(["standard", "heat", "flow"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={!view3D && lens === m ? "is-on" : ""}
                    onClick={() => {
                      setView3D(false);
                      setLens(m);
                    }}
                  >
                    {humanize(m)}
                  </button>
                ))}
                <button
                  type="button"
                  className={view3D ? "is-on" : ""}
                  onClick={() => setView3D((v) => !v)}
                >
                  3D
                </button>
              </div>
              <button
                type="button"
                className={`btn btn-sm ${jockeyMode ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setJockeyMode((j) => !j)}
                title="When active, select a truck and click any free dock door or yard slot on the map to dispatch immediately"
              >
                <Navigation size={12} /> {jockeyMode ? "Jockey ON" : "Jockey"}
              </button>
            </div>
          }
          className="gate-map-panel"
        >
          <ErrorNote error={board.error} />
          {selected && jockeyMode ? (
            <div className="gate-jockey-banner">
              <span>
                <strong>Jockey Dispatch:</strong> {selected.plate} selected — click any glowing free{" "}
                <strong>Dock Door</strong> or <strong>Yard Slot</strong> to move immediately.
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setJockeyMode(false)}>
                Done
              </button>
            </div>
          ) : pendingMove ? (
            <div className="gate-jockey-banner">
              <span>
                Move <strong>{pendingMove.plate}</strong> to{" "}
                <strong>
                  {pendingMove.target.kind === "dock_door" ? `Dock ${pendingMove.target.code}` : `Yard ${pendingMove.target.code}`}
                </strong>
                ?
              </span>
              <div className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() => {
                    const vis = activeVisits.find((v) => v.id === pendingMove.visitId);
                    if (vis) void executeCellMove(vis, pendingMove.target);
                  }}
                >
                  Confirm move
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPendingMove(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {board.data && board.data.layout.cells.length ? (
            view3D ? (
              <div className="map-wrap gate-map-wrap" style={{ position: "relative" }}>
                <Suspense fallback={<Empty>Loading 3D Yard Twin…</Empty>}>
                  <SiteMap3D
                    layout={board.data.layout}
                    locations={board.data.locations}
                    lens={lens}
                    now={now}
                    highlight={highlight}
                    onCellClick={(_, locs) => onCell(locs)}
                  />
                </Suspense>
              </div>
            ) : (
              <div className="map-wrap gate-map-wrap" ref={mapRef}>
                <SiteMap
                  layout={board.data.layout}
                  locations={board.data.locations}
                  lens={lens}
                  now={now}
                  cellWidth={cell.w}
                  cellHeight={cell.h}
                  highlight={highlight}
                  onCellClick={(_, locs) => onCell(locs)}
                />
              </div>
            )
          ) : board.data ? (
            <Empty>No layout for this site yet.</Empty>
          ) : null}
          {!view3D ? (
            <div className="gate-map-footer">
              <MapLegend kinds={["gate", "dock_door", "yard_slot", "staging"]} />
            </div>
          ) : null}
        </Panel>

        <div className="stack gate-rail">
          {selected && board.data ? (
            <VisitPanel
              visit={selected}
              board={board.data}
              onClose={() => setSelectedId(null)}
              onOpenPass={() => setPassVisitId(selected.id)}
              onOpenWaybill={(tripId) => setWaybillTripId(tripId)}
              onNudge={(role) =>
                setNudgeTarget({
                  targetRole: role,
                  tripId: selected.tripId,
                  locationCode: selected.dock?.code ?? selected.yardCode ?? undefined,
                })
              }
            />
          ) : null}

          <Panel
            title={`On site (${activeVisits.length})`}
            scroll
            className="grow"
            actions={
              <div className="gate-mini-toggle">
                <button type="button" className={queueSort === "priority" ? "is-active" : ""} onClick={() => setQueueSort("priority")}>
                  Priority
                </button>
                <button type="button" className={queueSort === "recent" ? "is-active" : ""} onClick={() => setQueueSort("recent")}>
                  Recent
                </button>
              </div>
            }
          >
            {sortedVisits.length ? (
              <div className="on-site-truck-list">
                {sortedVisits.map((v) => {
                  const isInYard = v.status === "in_yard" || !v.dock;
                  const detention = detentionExposureFor(v.dwellMinutes);
                  const isOvertime = v.dwellMinutes > 120;
                  const isWarnDwell = !isOvertime && v.dwellMinutes >= 60;
                  return (
                    <div
                      key={v.id}
                      className={`on-site-truck-card${v.id === selectedId ? " is-selected" : ""}${
                        isOvertime || v.inspectionStatus === "hold" ? " is-priority-alert" : ""
                      }`}
                    >
                      <button
                        type="button"
                        className="on-site-truck-select"
                        onClick={() => setSelectedId(v.id === selectedId ? null : v.id)}
                      >
                        <div className="on-site-truck-row">
                          <span className="on-site-truck-plate">{v.plate}</span>
                          <span className={`on-site-badge ${isInYard ? "is-in-yard" : "is-at-dock"}`}>
                            <span className="on-site-badge-dot" />
                            {isInYard ? "In yard" : "At dock"}
                          </span>
                        </div>
                        <div className="on-site-truck-meta">
                          {v.dock ? `Dock ${v.dock.code} (${v.dock.purpose})` : v.yardCode ? `Yard ${v.yardCode}` : "No slot"}
                          {v.tripCode ? ` · ${v.tripCode}` : ""}
                          {v.sealIn ? ` · Seal ${v.sealIn}` : ""}
                        </div>
                        <div className="on-site-truck-flags">
                          <span
                            className={`on-site-dwell-pill${isOvertime ? " is-overtime" : isWarnDwell ? " is-warn" : ""}`}
                          >
                            {isOvertime
                              ? `OVERTIME ${formatDuration(v.dwellMinutes)} · ₱${detention.toLocaleString("en-US")}`
                              : `${formatDuration(v.dwellMinutes)} on site`}
                          </span>
                          {v.inspectionStatus === "hold" ? <Pill tone="danger">HOLD</Pill> : null}
                          {v.proofPhotoIn ? (
                            <span className="muted small" title="Check-in photo captured">
                              <Camera size={11} />
                            </span>
                          ) : null}
                        </div>
                      </button>

                      <div className="on-site-truck-actions">
                        {isInYard ? (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={busy || freeDocksCount === 0}
                            onClick={() =>
                              run(() => api.post<GateVisit>(`/gate/visits/${v.id}/dock`, {}), (r) => `${r.plate} → Dock ${r.dock?.code}`)
                            }
                          >
                            <DoorOpen size={11} /> Dock
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => run(() => api.post(`/gate/visits/${v.id}/dock/release`), `${v.plate} released to yard`)}
                          >
                            <ArrowRightLeft size={11} /> Release
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() =>
                            setNudgeTarget({
                              targetRole: isInYard ? "driver" : "warehouse",
                              tripId: v.tripId,
                              locationCode: v.dock?.code ?? v.yardCode ?? undefined,
                            })
                          }
                        >
                          <BellRing size={11} /> Nudge
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPassVisitId(v.id)}>
                          <Printer size={11} /> Pass
                        </button>
                        {v.tripId ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            title="Open trip waybill"
                            aria-label="Open trip waybill"
                            onClick={() => setWaybillTripId(v.tripId)}
                          >
                            <FileText size={11} /> Waybill
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
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
            defaultPosture={posture}
            onOpenWaybill={(id) => setWaybillTripId(id)}
            onClose={() => setCheckInFor(null)}
            onDone={(v) => {
              setCheckInFor(null);
              setSelectedId(v.id);
            }}
          />
        ) : null}
        {bookingDraft && board.data ? (
          <NewAppointmentModal
            siteId={siteId}
            board={board.data}
            draft={typeof bookingDraft === "object" ? bookingDraft : undefined}
            onClose={() => setBookingDraft(false)}
            onCreated={() => setBookingDraft(false)}
          />
        ) : null}
        {passVisit ? (
          <GatePassModal
            visit={passVisit}
            site={currentSite}
            onClose={() => setPassVisitId(null)}
            onOpenWaybill={(id) => {
              setPassVisitId(null);
              setWaybillTripId(id);
            }}
          />
        ) : null}
        {waybillTripId ? <WaybillModal tripId={waybillTripId} onClose={() => setWaybillTripId(null)} /> : null}
        {nudgeTarget ? (
          <SendNudgeModal
            targetRole={nudgeTarget.targetRole}
            siteId={siteId}
            tripId={nudgeTarget.tripId}
            locationCode={nudgeTarget.locationCode}
            onClose={() => setNudgeTarget(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

function NewAppointmentModal({
  siteId,
  board,
  draft,
  onClose,
  onCreated,
}: {
  siteId: string;
  board: SiteBoard;
  draft?: SlotBookDraft;
  onClose: () => void;
  onCreated: (a: DockAppointment) => void;
}) {
  const { busy, run } = useAction();
  const [plate, setPlate] = useState("");
  const [carrier, setCarrier] = useState("");
  const [purpose, setPurpose] = useState<DockPurpose>("unload");
  const [locationId, setLocationId] = useState(draft?.locationId ?? "");
  const now = new Date();
  const [start, setStart] = useState(
    toLocalInput(draft ? new Date(draft.windowStart) : new Date(now.getTime() + 30 * 60_000)),
  );
  const [end, setEnd] = useState(
    toLocalInput(draft ? new Date(draft.windowEnd) : new Date(now.getTime() + 90 * 60_000)),
  );
  const [notes, setNotes] = useState("");
  const docks = board.locations.filter((l) => l.kind === "dock_door" && l.active);

  return (
    <Modal title="Schedule dock appointment" onClose={onClose}>
      <div className="form">
        <div className="form-2">
          <Field label="Plate">
            <input
              className="input plate-input"
              placeholder="PLATE"
              value={plate}
              onChange={(e) => setPlate(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Carrier">
            <input
              className="input"
              placeholder="e.g. Swift, DHL"
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
            />
          </Field>
          <Field label="Purpose">
            <select className="select" value={purpose} onChange={(e) => setPurpose(e.target.value as DockPurpose)}>
              <option value="unload">Unload (Inbound)</option>
              <option value="load">Load (Outbound)</option>
            </select>
          </Field>
          <Field label="Reserved dock door" hint="Optional pre-assigned door">
            <select className="select" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Auto-assign at gate</option>
              {docks.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Window start">
            <input className="input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Window end">
            <input className="input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Notes">
          <input className="input" placeholder="Appointment notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <button
          className="btn btn-primary btn-lg"
          disabled={!plate || busy}
          onClick={async () => {
            const a = await run(
              () =>
                api.post<DockAppointment>("/gate/appointments", {
                  siteId,
                  plate,
                  carrier,
                  purpose,
                  locationId: locationId || undefined,
                  windowStart: fromLocalInput(start),
                  windowEnd: fromLocalInput(end),
                  notes,
                }),
              (res) => `Appointment ${res.code} booked for ${res.plate}`,
            );
            if (a) onCreated(a);
          }}
        >
          Book appointment
        </button>
      </div>
    </Modal>
  );
}

function QuickGate({
  siteId,
  posture,
  onCheckIn,
  onCheckedOut,
}: {
  siteId: string;
  posture: GatePosture;
  onCheckIn: (plate: string) => void;
  onCheckedOut: () => void;
}) {
  const [plate, setPlate] = useState("");
  const { busy, run } = useAction();

  const submitCheckIn = async () => {
    if (!plate) return;
    if (posture === "express") {
      const v = await run(
        () => api.post<GateVisit>("/gate/check-in", { siteId, plate, inspectionStatus: "passed" }),
        (r) => `${r.plate} express in${r.yardCode ? ` → ${r.yardCode}` : ""}`,
      );
      if (v) setPlate("");
      return;
    }
    onCheckIn(plate);
  };

  return (
    <Panel
      title="Gate"
      actions={
        posture === "express" ? (
          <Pill tone="ok">Express 1-Tap</Pill>
        ) : posture === "audit" ? (
          <Pill tone="danger">Hold Audit</Pill>
        ) : null
      }
    >
      <div className="form">
        <input
          className="input plate-input"
          placeholder="PLATE"
          value={plate}
          onChange={(e) => setPlate(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && plate && void submitCheckIn()}
        />
        <div className="form-2">
          <button
            className="btn btn-primary"
            style={{ padding: "8px 14px", fontWeight: 600 }}
            disabled={!plate || busy}
            onClick={() => void submitCheckIn()}
          >
            {posture === "express" ? "Express In" : "Check in"}
          </button>
          <button
            className="btn btn-gate-checkout"
            style={{ padding: "8px 14px" }}
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
  defaultPosture,
  onOpenWaybill,
  onClose,
  onDone,
}: {
  siteId: string;
  board: SiteBoard;
  initial: { plate: string; tripId?: string; yardLocationId?: string };
  expected: ExpectedTrip[];
  defaultPosture: GatePosture;
  onOpenWaybill: (tripId: string) => void;
  onClose: () => void;
  onDone: (v: GateVisit) => void;
}) {
  const { busy, run } = useAction();
  const [plate, setPlate] = useState(initial.plate);
  const [tripId, setTripId] = useState(initial.tripId ?? "");
  const [seal, setSeal] = useState("");
  const [notes, setNotes] = useState("");
  const [slot, setSlot] = useState(initial.yardLocationId ?? "");
  const [directDockId, setDirectDockId] = useState("");
  const [inspectionStatus, setInspectionStatus] = useState<GateInspectionStatus>(defaultPosture === "audit" ? "hold" : "passed");
  const [proofPhoto, setProofPhoto] = useState("");

  const freeSlots = board.locations.filter((l) => l.kind === "yard_slot" && l.occupied === 0);
  const freeDocks = board.locations.filter((l) => l.kind === "dock_door" && l.active && l.occupied === 0);
  const forPlate = expected.filter((t) => t.plate === plate);
  const resolvedTripId = tripId || forPlate[0]?.id || "";

  return (
    <Modal title="Gate Check-In & Security Inspection" onClose={onClose}>
      <div className="form">
        <Field label="Plate">
          <input className="input plate-input" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} />
        </Field>
        <Field label="Trip" hint="Leave on auto to match the plate against expected trips">
          <div className="row" style={{ gap: 6 }}>
            <select className="select" value={tripId} onChange={(e) => setTripId(e.target.value)}>
              <option value="">Auto-match{forPlate.length ? ` (${forPlate[0]!.code})` : ""}</option>
              {expected.map((t) => (
                <option key={`${t.id}-${t.direction}`} value={t.id}>
                  {t.code} · {t.plate ?? "—"} · {humanize(t.direction)}
                </option>
              ))}
            </select>
            {resolvedTripId ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenWaybill(resolvedTripId)}>
                <FileText size={13} /> Waybill
              </button>
            ) : null}
          </div>
        </Field>
        <div className="form-2">
          <Field label="Seal number">
            <input className="input" placeholder="e.g. SL-492018" value={seal} onChange={(e) => setSeal(e.target.value)} />
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
        <div className="form-2">
          <Field label="Security clearance">
            <div className="gate-mini-toggle" style={{ width: "100%" }}>
              <button
                type="button"
                className={inspectionStatus === "passed" ? "is-active" : ""}
                style={{ flex: 1 }}
                onClick={() => setInspectionStatus("passed")}
              >
                <ShieldCheck size={12} /> Cleared
              </button>
              <button
                type="button"
                className={inspectionStatus === "hold" ? "is-active is-danger" : ""}
                style={{ flex: 1 }}
                onClick={() => setInspectionStatus("hold")}
              >
                <ShieldAlert size={12} /> Hold
              </button>
            </div>
          </Field>
          <Field label="Direct-to-dock" hint="Optional skip yard wait">
            <select className="select" value={directDockId} onChange={(e) => setDirectDockId(e.target.value)}>
              <option value="">Park in yard first</option>
              <option value="__auto__" disabled={freeDocks.length === 0}>
                Auto-assign best free dock ({freeDocks.length})
              </option>
              {freeDocks.map((d) => (
                <option key={d.id} value={d.id}>
                  Direct → Dock {d.code}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Notes">
          <input className="input" placeholder="Seal integrity, trailer damage, escort notes..." value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <PhotoProofPicker value={proofPhoto} onChange={setProofPhoto} label="Capture plate / seal condition photo" />

        <button
          className="btn btn-primary btn-lg"
          disabled={busy || !plate}
          onClick={async () => {
            const v = await run(async () => {
              const checkedIn = await api.post<GateVisit>("/gate/check-in", {
                siteId,
                plate,
                sealNo: seal,
                notes,
                tripId: tripId || undefined,
                yardLocationId: slot || undefined,
                inspectionStatus,
                proofPhoto: proofPhoto || undefined,
              });
              if (directDockId && inspectionStatus !== "hold") {
                return api.post<GateVisit>(`/gate/visits/${checkedIn.id}/dock`, {
                  ...(directDockId !== "__auto__" ? { locationId: directDockId } : {}),
                });
              }
              return checkedIn;
            }, (r) => `${r.plate} in${r.dock ? ` → Dock ${r.dock.code}` : r.yardCode ? ` · Yard ${r.yardCode}` : ""}`);
            if (v) onDone(v);
          }}
        >
          <Truck size={15} /> {directDockId && inspectionStatus !== "hold" ? "Open gate & send to dock" : "Open gate"}
        </button>
      </div>
    </Modal>
  );
}

function VisitPanel({
  visit,
  board,
  onClose,
  onOpenPass,
  onOpenWaybill,
  onNudge,
}: {
  visit: GateVisit;
  board: SiteBoard;
  onClose: () => void;
  onOpenPass: () => void;
  onOpenWaybill: (tripId: string) => void;
  onNudge: (role: NudgeTargetRole) => void;
}) {
  const { busy, run } = useAction();
  const suggestion = useApi<DockSuggestion>(visit.dock ? null : `/gate/visits/${visit.id}/dock-suggestion`, {
    live: (e) => e.type.startsWith("gate.") || e.type.startsWith("dock.") || e.type.startsWith("appointment."),
  });
  const [purpose, setPurpose] = useState<DockPurpose | "">("");
  const [seal, setSeal] = useState("");
  const [proofOut, setProofOut] = useState("");
  const [moving, setMoving] = useState(false);

  const docks = board.locations.filter((l) => l.kind === "dock_door");
  const freeSlots = board.locations.filter((l) => l.kind === "yard_slot" && l.occupied === 0);
  const detentionFee = detentionExposureFor(visit.dwellMinutes);

  const assign = (locationId?: string) =>
    run(
      () => api.post<GateVisit>(`/gate/visits/${visit.id}/dock`, { locationId, purpose: purpose || undefined }),
      (r) => `${r.plate} → dock ${r.dock?.code}`,
    );

  const toggleHold = () => {
    const next: GateInspectionStatus = visit.inspectionStatus === "hold" ? "passed" : "hold";
    void run(
      () => api.patch<GateVisit>(`/gate/visits/${visit.id}/inspection`, { inspectionStatus: next }),
      `${visit.plate} marked ${next === "hold" ? "SECURITY HOLD" : "CLEARED"}`,
    );
  };

  return (
    <Panel
      title={<span className="mono">{visit.plate}</span>}
      actions={
        <div className="row" style={{ gap: 4 }}>
          <button className="btn btn-ghost btn-sm" onClick={onOpenPass} title="Print Yard Slip / Gate Pass">
            <Printer size={12} /> Pass
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      }
    >
      <div className="stack">
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Pill value={visit.status} />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ padding: "2px 8px" }}
            disabled={busy}
            onClick={toggleHold}
          >
            {visit.inspectionStatus === "hold" ? (
              <span style={{ color: "var(--danger)", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}>
                <ShieldAlert size={12} /> HOLD · Tap to clear
              </span>
            ) : (
              <span style={{ color: "var(--ok)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4 }}>
                <ShieldCheck size={12} /> Cleared · Tap to hold
              </span>
            )}
          </button>
        </div>

        <dl className="kv">
          <dt>Trip</dt>
          <dd>
            {visit.tripCode && visit.tripId ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ padding: "1px 6px", fontWeight: 600 }}
                onClick={() => onOpenWaybill(visit.tripId!)}
              >
                {visit.tripCode} · Waybill
              </button>
            ) : (
              "—"
            )}
          </dd>
          <dt>Dwell</dt>
          <dd>
            {fmtDateTime(visit.checkInAt)} · <strong>{formatDuration(visit.dwellMinutes)}</strong>
            {detentionFee > 0 ? <span style={{ color: "var(--danger)" }}> (₱{detentionFee.toLocaleString("en-US")})</span> : null}
          </dd>
          <dt>Seal in</dt>
          <dd>{visit.sealIn || "—"}</dd>
          <dt>Position</dt>
          <dd>{visit.dock ? `Dock ${visit.dock.code} (${visit.dock.purpose})` : visit.yardCode ? `Yard ${visit.yardCode}` : "No slot"}</dd>
        </dl>

        {visit.proofPhotoIn ? (
          <img
            src={visit.proofPhotoIn}
            alt="Gate check-in condition photo"
            style={{ width: "100%", maxHeight: 110, objectFit: "cover", borderRadius: 10, border: "1px solid var(--line)" }}
          />
        ) : null}

        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn btn-ghost btn-sm" style={{ flex: 1 }} onClick={() => onNudge("driver")}>
            <BellRing size={12} /> Nudge Driver
          </button>
          <button type="button" className="btn btn-ghost btn-sm" style={{ flex: 1 }} onClick={() => onNudge("warehouse")}>
            <CheckCircle2 size={12} /> Nudge Dock
          </button>
        </div>

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
            <input className="input" placeholder="Outbound seal #" value={seal} onChange={(e) => setSeal(e.target.value)} />
          </Field>
          <PhotoProofPicker value={proofOut} onChange={setProofOut} label="Gate-out condition / seal photo" />
          <button
            className="btn btn-warn"
            disabled={busy || visit.inspectionStatus === "hold"}
            title={visit.inspectionStatus === "hold" ? "Clear security hold above before checking out" : "Complete gate check-out"}
            onClick={async () => {
              const r = await run(
                () =>
                  api.post<GateVisit>("/gate/check-out", {
                    visitId: visit.id,
                    sealNo: seal,
                    proofPhoto: proofOut || undefined,
                  }),
                (v) => `${v.plate} checked out`,
              );
              if (r) onClose();
            }}
          >
            {visit.inspectionStatus === "hold" ? "Release Security Hold First" : "Check out"}
          </button>
        </div>
      </div>
    </Panel>
  );
}
