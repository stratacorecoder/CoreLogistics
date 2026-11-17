import type {
  DockAppointment,
  GateVisit,
  LocationStatus,
} from "@corelogistics/contracts";
import { api, Empty, fmtTime, fromNow, Modal, Pill, useAction } from "@corelogistics/ui";
import { ArrowDownLeft, ArrowUpRight, CalendarClock, ChevronLeft, ChevronRight, FileText, Maximize2, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";

const HOUR_MS = 3600_000;

export interface SlotBookDraft {
  locationId: string;
  windowStart: string;
  windowEnd: string;
}

function floorHour(ms: number): number {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function hourLabel(ms: number): string {
  const h = new Date(ms).getHours();
  return `${String(h).padStart(2, "0")}:00`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function GateTimeline({
  appointments,
  locations,
  visits,
  now,
  compact = false,
  onBookSlot,
  onCheckIn,
  onViewWaybill,
}: {
  appointments: DockAppointment[];
  locations: LocationStatus[];
  visits: GateVisit[];
  now: number;
  compact?: boolean;
  onBookSlot: (draft: SlotBookDraft) => void;
  onCheckIn: (plate: string, tripId?: string) => void;
  onViewWaybill?: (tripId: string) => void;
}) {
  const { busy, run } = useAction();
  const [shiftHours, setShiftHours] = useState(0);
  const [showCancelled, setShowCancelled] = useState(false);
  const [selectedApptId, setSelectedApptId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const docks = useMemo(
    () => locations.filter((l) => l.kind === "dock_door" && l.active).sort((a, b) => a.code.localeCompare(b.code)),
    [locations],
  );

  const hourSpan = compact && !expanded ? 6 : 12;
  const isCompactMode = compact && !expanded;
  const windowStartMs = useMemo(
    () => floorHour(now) - (isCompactMode ? 1 : 2) * HOUR_MS + shiftHours * HOUR_MS,
    [now, shiftHours, isCompactMode],
  );
  const windowEndMs = windowStartMs + hourSpan * HOUR_MS;
  const hours = useMemo(
    () => Array.from({ length: hourSpan }, (_, idx) => windowStartMs + idx * HOUR_MS),
    [windowStartMs, hourSpan],
  );

  const visibleAppointments = useMemo(
    () => appointments.filter((a) => (showCancelled ? true : a.status !== "cancelled")),
    [appointments, showCancelled],
  );

  const selectedAppt = visibleAppointments.find((a) => a.id === selectedApptId) ?? null;

  const liveAtDock = useMemo(() => {
    const byLoc = new Map<string, GateVisit>();
    for (const v of visits) {
      if (v.dock?.locationId) byLoc.set(v.dock.locationId, v);
    }
    return byLoc;
  }, [visits]);

  const nowPct = clamp(((now - windowStartMs) / (hourSpan * HOUR_MS)) * 100, -1, 101);

  const rows = useMemo(() => {
    const base = docks.map((d) => ({
      id: d.id,
      code: d.code,
      zone: d.zone,
      liveVisit: liveAtDock.get(d.id) ?? null,
    }));
    const hasUnassigned = visibleAppointments.some((a) => !a.locationId);
    if (hasUnassigned) {
      base.push({ id: "__auto__", code: "AUTO", zone: null, liveVisit: null });
    }
    return base;
  }, [docks, liveAtDock, visibleAppointments]);

  const shiftAppt = async (appt: DockAppointment, deltaMinutes: number, nextLocationId?: string | null) => {
    const nextStart = new Date(Date.parse(appt.windowStart) + deltaMinutes * 60_000).toISOString();
    const nextEnd = new Date(Date.parse(appt.windowEnd) + deltaMinutes * 60_000).toISOString();
    await run(
      () =>
        api.patch<DockAppointment>(`/gate/appointments/${appt.id}`, {
          windowStart: nextStart,
          windowEnd: nextEnd,
          ...(nextLocationId !== undefined ? { locationId: nextLocationId } : {}),
        }),
      `${appt.code} updated`,
    );
  };

  const renderGrid = (isModalView: boolean) => {
    const laneCols = isModalView ? `repeat(${hours.length}, minmax(52px, 1fr))` : `repeat(${hours.length}, minmax(0, 1fr))`;
    return (
    <div className={`gate-gantt-root${isModalView ? " is-modal" : ""}`}>
      <div className="gate-gantt-toolbar">
        <div className="row" style={{ gap: 4 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShiftHours((h) => h - 4)} title="Earlier">
            <ChevronLeft size={14} /> 4h
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShiftHours(0)}>
            Now
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShiftHours((h) => h + 4)} title="Later">
            4h <ChevronRight size={14} />
          </button>
        </div>
        <span className="muted small mono">
          {hourLabel(windowStartMs)}–{hourLabel(windowEndMs)}
        </span>
        <div className="row" style={{ gap: 6 }}>
          <label className="row small muted" style={{ gap: 4, cursor: "pointer" }}>
            <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
            Cancelled
          </label>
          {compact && !isModalView ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setExpanded(true)}
              title="Open full dock timeline"
            >
              <Maximize2 size={13} /> Grid
            </button>
          ) : null}
        </div>
      </div>

      {!rows.length ? (
        <Empty>No active dock doors at this site</Empty>
      ) : (
        <div className="gate-gantt-scroll">
          <div className="gate-gantt-table">
            <div className="gate-gantt-header">
              <div className="gate-gantt-door-col">Door</div>
              <div className="gate-gantt-hours" style={{ gridTemplateColumns: laneCols }}>
                {hours.map((hMs) => (
                  <div key={hMs} className="gate-gantt-hour-cell">
                    {isModalView ? hourLabel(hMs) : `${String(new Date(hMs).getHours()).padStart(2, "0")}h`}
                  </div>
                ))}
              </div>
            </div>

            <div className="gate-gantt-body">
              {nowPct >= 0 && nowPct <= 100 ? (
                <div className="gate-gantt-now-line" style={{ left: `calc(50px + (100% - 50px) * ${nowPct / 100})` }} />
              ) : null}

              {rows.map((row) => {
                const rowAppts = visibleAppointments.filter((a) =>
                  row.id === "__auto__" ? !a.locationId : a.locationId === row.id,
                );
                return (
                  <div key={row.id} className="gate-gantt-row">
                    <div className="gate-gantt-door-label" title={row.liveVisit ? `Occupied by ${row.liveVisit.plate}` : "Free"}>
                      <span className="mono strong">{row.code}</span>
                      {row.liveVisit ? <span className="gate-gantt-live-dot" title={row.liveVisit.plate} /> : null}
                    </div>

                    <div className="gate-gantt-lane" style={{ gridTemplateColumns: laneCols }}>
                      {hours.map((hMs) => (
                        <button
                          key={hMs}
                          type="button"
                          className="gate-gantt-slot-bg"
                          disabled={row.id === "__auto__"}
                          title={
                            row.id === "__auto__"
                              ? "Auto-assigned appointments"
                              : `Book ${row.code} at ${hourLabel(hMs)}`
                          }
                          onClick={() => {
                            if (row.id === "__auto__") return;
                            onBookSlot({
                              locationId: row.id,
                              windowStart: new Date(hMs).toISOString(),
                              windowEnd: new Date(hMs + HOUR_MS).toISOString(),
                            });
                          }}
                        >
                          {row.id !== "__auto__" ? <Plus size={10} className="gate-gantt-slot-plus" /> : null}
                        </button>
                      ))}

                      {row.liveVisit ? (
                        (() => {
                          const startMs = Date.parse(row.liveVisit.dock?.assignedAt ?? row.liveVisit.checkInAt);
                          const endMs = Math.max(now + 20 * 60_000, startMs + 30 * 60_000);
                          if (endMs <= windowStartMs || startMs >= windowEndMs) return null;
                          const leftPct = clamp(((startMs - windowStartMs) / (hourSpan * HOUR_MS)) * 100, 0, 74);
                          const rightPct = clamp(((endMs - windowStartMs) / (hourSpan * HOUR_MS)) * 100, leftPct + (isModalView ? 12 : 24), 100);
                          return (
                            <div
                              className="gate-gantt-live-bar"
                              style={{ left: `${leftPct}%`, width: `${rightPct - leftPct}%` }}
                              title={`Live at ${row.code}: ${row.liveVisit.plate}`}
                            >
                              {row.liveVisit.plate}
                            </div>
                          );
                        })()
                      ) : null}

                      {rowAppts.map((a) => {
                        const sMs = Date.parse(a.windowStart);
                        const eMs = Date.parse(a.windowEnd);
                        if (eMs <= windowStartMs || sMs >= windowEndMs) return null;
                        const leftPct = clamp(((sMs - windowStartMs) / (hourSpan * HOUR_MS)) * 100, 0, 97);
                        const rightPct = clamp(((eMs - windowStartMs) / (hourSpan * HOUR_MS)) * 100, leftPct + 3, 100);
                        const active = a.id === selectedApptId;
                        return (
                          <button
                            key={a.id}
                            type="button"
                            className={`gate-gantt-bar is-${a.status}${active ? " is-selected" : ""}`}
                            style={{ left: `${leftPct}%`, width: `${rightPct - leftPct}%` }}
                            onClick={() => setSelectedApptId(active ? null : a.id)}
                            title={`${a.plate} · ${a.purpose} · ${fmtTime(a.windowStart)}–${fmtTime(a.windowEnd)}`}
                          >
                            {a.purpose === "unload" ? <ArrowDownLeft size={10} /> : <ArrowUpRight size={10} />}
                            <span className="truncate">{a.plate}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {selectedAppt ? (
        <div className="gate-gantt-inspector">
          <div className="row-between">
            <div className="row" style={{ gap: 6 }}>
              <CalendarClock size={14} />
              <strong className="mono">{selectedAppt.plate}</strong>
              <span className="muted small">{selectedAppt.code}</span>
              <Pill value={selectedAppt.status} />
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedApptId(null)}>
              <X size={13} />
            </button>
          </div>

          <div className="small muted">
            {selectedAppt.carrier ? `${selectedAppt.carrier} · ` : ""}
            {selectedAppt.purpose === "unload" ? "Inbound Unload" : "Outbound Load"} ·{" "}
            {fmtTime(selectedAppt.windowStart)}–{fmtTime(selectedAppt.windowEnd)} ({fromNow(selectedAppt.windowStart, now)})
          </div>

          {selectedAppt.status === "scheduled" ? (
            <div className="gate-gantt-controls">
              <select
                className="select"
                style={{ width: 112, padding: "4px 8px", fontSize: 12 }}
                disabled={busy}
                value={selectedAppt.locationId ?? ""}
                onChange={(e) => void shiftAppt(selectedAppt, 0, e.target.value || null)}
              >
                <option value="">Auto door</option>
                {docks.map((d) => (
                  <option key={d.id} value={d.id}>
                    Door {d.code}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => void shiftAppt(selectedAppt, -30)}
              >
                -30m
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => void shiftAppt(selectedAppt, 30)}
              >
                +30m
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => onCheckIn(selectedAppt.plate, selectedAppt.tripId ?? undefined)}
              >
                Check in
              </button>
              {selectedAppt.tripId && onViewWaybill ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => onViewWaybill(selectedAppt.tripId!)}
                >
                  <FileText size={13} /> Waybill
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() =>
                  run(() => api.post(`/gate/appointments/${selectedAppt.id}/cancel`), `${selectedAppt.code} cancelled`)
                }
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="row" style={{ gap: 6 }}>
              {selectedAppt.tripId && onViewWaybill ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => onViewWaybill(selectedAppt.tripId!)}
                >
                  <FileText size={13} /> View Waybill
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : (
        <div className="muted small" style={{ marginTop: 2 }}>
          Tap an empty hour to book, or a bar to re-slot.
        </div>
      )}
    </div>
    );
  };

  return (
    <>
      {renderGrid(false)}
      {expanded ? (
        <Modal title="Dock Door Schedule Matrix" onClose={() => setExpanded(false)} wide>
          {renderGrid(true)}
        </Modal>
      ) : null}
    </>
  );
}
