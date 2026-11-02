import {
  humanize,
  TRIP_KINDS,
  type EventRecord,
  type Trip,
  type TripInput,
  type TripKind,
  type TripPatch,
  type TripStatus,
} from "@corelogistics/contracts";
import {
  api,
  EventFeed,
  Field,
  fmtDateTime,
  fromLocalInput,
  fromNow,
  Modal,
  Pill,
  toLocalInput,
  useAction,
  useApi,
  useNow,
  type Refs,
} from "@corelogistics/ui";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowRightLeft,
  ArrowUpRight,
  Calendar,
  CalendarClock,
  CheckCircle2,
  Clock,
  MapPin,
  Navigation,
  Plus,
  Search,
  Send,
  Truck,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

const COLUMNS: Array<{
  status: TripStatus;
  label: string;
  icon: LucideIcon;
  color: string;
}> = [
  { status: "planned", label: "Planned", icon: CalendarClock, color: "var(--info)" },
  { status: "dispatched", label: "Dispatched", icon: Send, color: "var(--accent)" },
  { status: "in_transit", label: "In transit", icon: Truck, color: "var(--warn)" },
  { status: "arrived", label: "Arrived", icon: MapPin, color: "var(--ok)" },
  { status: "completed", label: "Completed", icon: CheckCircle2, color: "var(--muted)" },
];

export function DispatchView({ refs }: { refs: Refs }) {
  const now = useNow(30_000);
  const active = useApi<Trip[]>("/trips?active=true&limit=300");
  const recent = useApi<Trip[]>("/trips?status=completed,cancelled&active=false&limit=20");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");
  const [quickFilter, setQuickFilter] = useState<
    "all" | "delayed" | "needs_assets" | "outbound" | "inbound" | "transfer"
  >("all");

  const all = useMemo(() => [...(active.data ?? []), ...(recent.data ?? [])], [active.data, recent.data]);

  const delayedCount = useMemo(() => all.filter((t) => t.delayed).length, [all]);
  const needsAssetsCount = useMemo(() => all.filter((t) => !t.vehicleId || !t.driverId).length, [all]);
  const outboundCount = useMemo(() => all.filter((t) => t.kind === "outbound").length, [all]);
  const inboundCount = useMemo(() => all.filter((t) => t.kind === "inbound").length, [all]);
  const transferCount = useMemo(() => all.filter((t) => t.kind === "transfer").length, [all]);

  const visible = all.filter((t) => {
    if (quickFilter === "delayed" && !t.delayed) return false;
    if (quickFilter === "needs_assets" && t.vehicleId && t.driverId) return false;
    if (quickFilter === "outbound" && t.kind !== "outbound") return false;
    if (quickFilter === "inbound" && t.kind !== "inbound") return false;
    if (quickFilter === "transfer" && t.kind !== "transfer") return false;

    if (!filter) return true;
    const hay = `${t.code} ${refs.siteCode(t.originSiteId)} ${refs.siteCode(t.destinationSiteId)} ${refs.plate(t.vehicleId)} ${refs.driverName(t.driverId)}`;
    return hay.toLowerCase().includes(filter.toLowerCase());
  });

  const open = all.find((t) => t.id === openId) ?? null;

  return (
    <div className="page stack dispatch-page" style={{ display: "flex", overflow: "hidden" }}>
      <div className="dispatch-toolbar">
        <div className="dispatch-search-box">
          <Search className="dispatch-search-icon" size={15} />
          <input
            className="dispatch-search-input"
            placeholder="Search trip, route, plate, driver…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter ? (
            <button
              type="button"
              className="dispatch-clear-btn"
              onClick={() => setFilter("")}
              aria-label="Clear search"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>

        <div className="dispatch-filter-pills">
          <button
            type="button"
            className={`filter-chip ${quickFilter === "all" ? "is-active" : ""}`}
            onClick={() => setQuickFilter("all")}
          >
            <span>All Trips</span>
            <span className="chip-count">{all.length}</span>
          </button>
          <button
            type="button"
            className={`filter-chip chip-delayed ${quickFilter === "delayed" ? "is-active" : ""}`}
            onClick={() => setQuickFilter(quickFilter === "delayed" ? "all" : "delayed")}
          >
            <span className="dot dot-danger" />
            <span>Delayed</span>
            <span className="chip-count chip-count-danger">{delayedCount}</span>
          </button>
          <button
            type="button"
            className={`filter-chip chip-warn ${quickFilter === "needs_assets" ? "is-active" : ""}`}
            onClick={() => setQuickFilter(quickFilter === "needs_assets" ? "all" : "needs_assets")}
          >
            <span className="dot dot-warn" />
            <span>Needs Assets</span>
            <span className="chip-count chip-count-warn">{needsAssetsCount}</span>
          </button>
          <button
            type="button"
            className={`filter-chip ${quickFilter === "outbound" ? "is-active" : ""}`}
            onClick={() => setQuickFilter(quickFilter === "outbound" ? "all" : "outbound")}
          >
            <ArrowUpRight size={12} className="text-accent" />
            <span>Outbound</span>
            <span className="chip-count">{outboundCount}</span>
          </button>
          <button
            type="button"
            className={`filter-chip ${quickFilter === "inbound" ? "is-active" : ""}`}
            onClick={() => setQuickFilter(quickFilter === "inbound" ? "all" : "inbound")}
          >
            <ArrowDownLeft size={12} className="text-info" />
            <span>Inbound</span>
            <span className="chip-count">{inboundCount}</span>
          </button>
          <button
            type="button"
            className={`filter-chip ${quickFilter === "transfer" ? "is-active" : ""}`}
            onClick={() => setQuickFilter(quickFilter === "transfer" ? "all" : "transfer")}
          >
            <ArrowRightLeft size={12} className="text-violet" />
            <span>Transfer</span>
            <span className="chip-count">{transferCount}</span>
          </button>
        </div>

        <div className="dispatch-spacer" />

        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Plus size={15} />
          <span>New trip</span>
        </button>
      </div>

      {/* Connected Pipeline Track Header */}
      <div className="pipeline-track-header">
        {COLUMNS.map((col, idx) => (
          <div key={col.status} className={`pipeline-header-stage stage-${col.status}`}>
            <div className="pipeline-header-title">
              <col.icon size={15} className="stage-icon" />
              <span>{col.label}</span>
            </div>
            {idx < COLUMNS.length - 1 && (
              <div className={`pipeline-header-connector connector-${col.status}`}>
                <span className="connector-line" />
                <ArrowRight size={13} className="connector-arrow" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Pipeline Board Grid */}
      <div className="pipeline-board-grid">
        {COLUMNS.map((col, idx) => {
          const trips = visible.filter((t) => t.status === col.status);
          const isLastCol = idx === COLUMNS.length - 1;
          return (
            <div key={col.status} className={`pipeline-stage-column stage-${col.status}`}>
              <div className="pipeline-column-cards">
                {trips.length ? (
                  trips.map((t) => {
                    const hasMissingAssets = !t.vehicleId || !t.driverId;
                    return (
                      <div key={t.id} className="pipeline-card-wrapper">
                        <div
                          className={`trip-card${t.delayed ? " is-delayed" : ""} stage-${col.status}`}
                          onClick={() => setOpenId(t.id)}
                          role="button"
                          tabIndex={0}
                        >
                          <div className="trip-card-header">
                            <span className="trip-code">{t.code}</span>
                            <div className="trip-badges">
                              {t.delayed ? (
                                <span className="badge-delayed">
                                  <Clock size={11} />
                                  <span>+{t.delayMinutes}m</span>
                                </span>
                              ) : null}
                              <span className={`badge-kind badge-${t.kind}`}>
                                {t.kind === "outbound" && <ArrowUpRight size={11} />}
                                {t.kind === "inbound" && <ArrowDownLeft size={11} />}
                                {t.kind === "transfer" && <ArrowRightLeft size={11} />}
                                <span>{humanize(t.kind)}</span>
                              </span>
                            </div>
                          </div>

                          <div className={`trip-route-row route-${col.status} kind-${t.kind}`}>
                            <span className="site-tag origin" title={refs.siteName(t.originSiteId)}>
                              {refs.siteCode(t.originSiteId)}
                            </span>
                            <div className="route-connector">
                              <span className="route-line" />
                              <ArrowRight size={11} className="route-arrow" />
                              {t.stops.length > 0 ? (
                                <span className="stops-badge" title={t.stops.map((s) => refs.siteCode(s.siteId)).join(", ")}>
                                  +{t.stops.length} step{t.stops.length > 1 ? "s" : ""}
                                </span>
                              ) : null}
                            </div>
                            <span className="site-tag destination" title={refs.siteName(t.destinationSiteId)}>
                              {refs.siteCode(t.destinationSiteId)}
                            </span>
                          </div>

                          <div className="trip-resources">
                            {hasMissingAssets ? (
                              <div className="resource-alert-box">
                                {!t.vehicleId && (
                                  <div className="resource-alert-item">
                                    <Truck size={12} className="alert-icon" />
                                    <span>⚠ Truck required</span>
                                  </div>
                                )}
                                {!t.driverId && (
                                  <div className="resource-alert-item">
                                    <User size={12} className="alert-icon" />
                                    <span>⚠ Driver unassigned</span>
                                  </div>
                                )}
                                {t.vehicleId && (
                                  <div className="resource-row">
                                    <Truck size={12} className="resource-icon" />
                                    <span className="resource-val">
                                      {refs.vehicleLabel(t.vehicleId)}
                                      {t.trailerId ? ` + ${refs.vehicleById.get(t.trailerId)?.code}` : ""}
                                    </span>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="trip-resources-normal">
                                <div className="resource-row">
                                  <Truck size={12} className="resource-icon" />
                                  <span className="resource-val">
                                    {refs.vehicleLabel(t.vehicleId)}
                                    {t.trailerId ? ` + ${refs.vehicleById.get(t.trailerId)?.code}` : ""}
                                  </span>
                                </div>
                                <div className="resource-row">
                                  <User size={12} className="resource-icon" />
                                  <span className="resource-val">{refs.driverName(t.driverId)}</span>
                                </div>
                              </div>
                            )}
                          </div>

                          <div className="trip-card-footer">
                            <span className="timing-readout">
                              {t.status === "in_transit" ? (
                                <>
                                  <Navigation size={11} className="timing-icon text-accent" />
                                  <span>ETA {fmtDateTime(t.etaAt)} · {fromNow(t.etaAt, now)}</span>
                                </>
                              ) : t.status === "completed" ? (
                                <>
                                  <CheckCircle2 size={11} className="timing-icon text-ok" />
                                  <span>Done {fmtDateTime(t.completedAt)}</span>
                                </>
                              ) : t.status === "arrived" ? (
                                <>
                                  <MapPin size={11} className="timing-icon text-ok" />
                                  <span>Arrived {fmtDateTime(t.actualArrival)}</span>
                                </>
                              ) : (
                                <>
                                  <Calendar size={11} className="timing-icon" />
                                  <span>Departs {fmtDateTime(t.plannedDeparture)} · {fromNow(t.plannedDeparture, now)}</span>
                                </>
                              )}
                            </span>
                          </div>
                        </div>

                        {!isLastCol && (
                          <div className="pipeline-flow-arrow" aria-hidden="true">
                            <ArrowRight size={13} />
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="empty-stage">No trips in this stage</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {open ? <TripModal trip={open} refs={refs} onClose={() => setOpenId(null)} /> : null}
      {creating ? (
        <NewTripModal
          refs={refs}
          onClose={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            setOpenId(t.id);
          }}
        />
      ) : null}
    </div>
  );
}

function AssetSelects({
  refs,
  value,
  onChange,
}: {
  refs: Refs;
  value: { vehicleId: string | null; trailerId: string | null; driverId: string | null };
  onChange: (v: { vehicleId: string | null; trailerId: string | null; driverId: string | null }) => void;
}) {
  const powered = (refs.vehicles ?? []).filter((v) => v.kind !== "trailer");
  const trailers = (refs.vehicles ?? []).filter((v) => v.kind === "trailer");
  return (
    <div className="form-2">
      <Field label="Vehicle">
        <select className="select" value={value.vehicleId ?? ""} onChange={(e) => onChange({ ...value, vehicleId: e.target.value || null })}>
          <option value="">— none —</option>
          {powered.map((v) => (
            <option key={v.id} value={v.id} disabled={v.status === "maintenance" || v.status === "inactive"}>
              {v.code} · {v.plate} · {Math.round(v.capacityKg / 1000)}t · {humanize(v.status)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Trailer">
        <select className="select" value={value.trailerId ?? ""} onChange={(e) => onChange({ ...value, trailerId: e.target.value || null })}>
          <option value="">— none —</option>
          {trailers.map((v) => (
            <option key={v.id} value={v.id}>
              {v.code} · {v.model} · {humanize(v.status)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Driver">
        <select className="select" value={value.driverId ?? ""} onChange={(e) => onChange({ ...value, driverId: e.target.value || null })}>
          <option value="">— none —</option>
          {(refs.drivers ?? []).map((d) => (
            <option key={d.id} value={d.id} disabled={d.status === "off_duty"}>
              {d.name} · {d.licenseClass} · {humanize(d.status)}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function TripModal({ trip, refs, onClose }: { trip: Trip; refs: Refs; onClose: () => void }) {
  const events = useApi<EventRecord[]>(`/trips/${trip.id}/events`);
  const { busy, run } = useAction();
  const editable = trip.status === "planned" || trip.status === "dispatched";
  const [assets, setAssets] = useState({ vehicleId: trip.vehicleId, trailerId: trip.trailerId, driverId: trip.driverId });
  const [dep, setDep] = useState(toLocalInput(trip.plannedDeparture));
  const [arr, setArr] = useState(toLocalInput(trip.plannedArrival));
  const dirty =
    assets.vehicleId !== trip.vehicleId ||
    assets.trailerId !== trip.trailerId ||
    assets.driverId !== trip.driverId ||
    dep !== toLocalInput(trip.plannedDeparture) ||
    arr !== toLocalInput(trip.plannedArrival);

  const act = (path: string, label: string) => run(() => api.post<Trip>(`/trips/${trip.id}/${path}`), `${trip.code} ${label}`);

  return (
    <Modal title={`${trip.code} · ${refs.siteCode(trip.originSiteId)} → ${refs.siteCode(trip.destinationSiteId)}`} onClose={onClose}>
      <div className="row">
        <Pill value={trip.status} />
        <Pill tone="muted">{humanize(trip.kind)}</Pill>
        {trip.delayed ? <Pill tone="danger">{trip.delayMinutes} min late</Pill> : <Pill tone="ok">On time</Pill>}
      </div>
      <dl className="kv">
        <dt>Route</dt>
        <dd>
          {refs.siteName(trip.originSiteId)} → {trip.stops.map((s) => `${refs.siteName(s.siteId)} → `).join("")}
          {refs.siteName(trip.destinationSiteId)}
        </dd>
        <dt>Planned</dt>
        <dd>
          {fmtDateTime(trip.plannedDeparture)} → {fmtDateTime(trip.plannedArrival)}
        </dd>
        <dt>Actual</dt>
        <dd>
          {fmtDateTime(trip.actualDeparture)} → {fmtDateTime(trip.actualArrival)}
          {trip.etaAt && trip.status === "in_transit" ? ` (ETA ${fmtDateTime(trip.etaAt)})` : ""}
        </dd>
        {trip.notes ? (
          <>
            <dt>Notes</dt>
            <dd>{trip.notes}</dd>
          </>
        ) : null}
        {(trip.podRecipient || trip.podSignature) ? (
          <>
            <dt>Proof of delivery</dt>
            <dd>
              <div>
                <strong>{trip.podRecipient || "Signed"}</strong>
                {trip.podAt ? <span className="muted small"> ({fmtDateTime(trip.podAt)})</span> : null}
              </div>
              {trip.podNotes ? <div className="muted small">{trip.podNotes}</div> : null}
              {trip.podSignature ? (
                <div style={{ marginTop: 6 }}>
                  <img
                    src={trip.podSignature}
                    alt="Proof of delivery signature"
                    style={{ maxHeight: 70, border: "1px solid var(--border)", background: "#ffffff", borderRadius: 4, padding: 4 }}
                  />
                </div>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
      {editable ? (
        <div className="form">
          <AssetSelects refs={refs} value={assets} onChange={setAssets} />
          <div className="form-2">
            <Field label="Planned departure">
              <input className="input" type="datetime-local" value={dep} onChange={(e) => setDep(e.target.value)} />
            </Field>
            <Field label="Planned arrival">
              <input className="input" type="datetime-local" value={arr} onChange={(e) => setArr(e.target.value)} />
            </Field>
          </div>
          <div className="row">
            <button
              className="btn btn-ghost"
              disabled={!dirty || busy}
              onClick={() =>
                run(
                  () =>
                    api.patch<Trip>(`/trips/${trip.id}`, {
                      ...assets,
                      plannedDeparture: fromLocalInput(dep),
                      plannedArrival: fromLocalInput(arr),
                    } satisfies TripPatch),
                  "Trip updated",
                )
              }
            >
              Save changes
            </button>
            {trip.status === "planned" ? (
              <button className="btn btn-primary" disabled={busy || dirty} onClick={() => act("dispatch", "dispatched")}>
                Dispatch
              </button>
            ) : null}
            <button className="btn btn-danger" disabled={busy} onClick={() => act("cancel", "cancelled")}>
              Cancel trip
            </button>
          </div>
        </div>
      ) : (
        <dl className="kv">
          <dt>Vehicle</dt>
          <dd>
            {refs.vehicleLabel(trip.vehicleId)}
            {trip.trailerId ? ` + ${refs.vehicleLabel(trip.trailerId)}` : ""}
          </dd>
          <dt>Driver</dt>
          <dd>{refs.driverName(trip.driverId)}</dd>
        </dl>
      )}
      <div className="row">
        {trip.status === "dispatched" ? (
          <button className="btn btn-ghost" disabled={busy} onClick={() => act("depart", "departed")}>
            Mark departed
          </button>
        ) : null}
        {trip.status === "in_transit" ? (
          <button className="btn btn-ghost" disabled={busy} onClick={() => act("arrive", "arrived")}>
            Mark arrived
          </button>
        ) : null}
        {trip.status === "arrived" ? (
          <button className="btn btn-primary" disabled={busy} onClick={() => act("complete", "completed")}>
            Complete
          </button>
        ) : null}
      </div>
      <div>
        <p className="field-label" style={{ marginBottom: 6 }}>
          Timeline
        </p>
        <EventFeed events={events.data} />
      </div>
    </Modal>
  );
}

function NewTripModal({ refs, onClose, onCreated }: { refs: Refs; onClose: () => void; onCreated: (t: Trip) => void }) {
  const { busy, run } = useAction();
  const sites = refs.sites ?? [];
  const own = sites.filter((s) => s.kind === "depot" || s.kind === "warehouse");
  const [kind, setKind] = useState<TripKind>("outbound");
  const [origin, setOrigin] = useState(own.find((s) => s.kind === "warehouse")?.id ?? "");
  const [dest, setDest] = useState(sites.find((s) => s.kind === "customer")?.id ?? "");
  const [dep, setDep] = useState(toLocalInput(Date.now() + 2 * 3600_000));
  const [arr, setArr] = useState(toLocalInput(Date.now() + 4 * 3600_000));
  const [assets, setAssets] = useState<{ vehicleId: string | null; trailerId: string | null; driverId: string | null }>({
    vehicleId: null,
    trailerId: null,
    driverId: null,
  });
  const [notes, setNotes] = useState("");

  const originOptions = kind === "inbound" ? sites.filter((s) => s.kind === "supplier") : own;
  const destOptions = kind === "outbound" ? sites.filter((s) => s.kind === "customer") : own;

  return (
    <Modal title="New trip" onClose={onClose}>
      <div className="form">
        <Field label="Kind">
          <select
            className="select"
            value={kind}
            onChange={(e) => {
              const k = e.target.value as TripKind;
              setKind(k);
              setOrigin((k === "inbound" ? sites.find((s) => s.kind === "supplier") : own[0])?.id ?? "");
              setDest((k === "outbound" ? sites.find((s) => s.kind === "customer") : own.find((s) => s.kind === "warehouse"))?.id ?? "");
            }}
          >
            {TRIP_KINDS.map((k) => (
              <option key={k} value={k}>
                {humanize(k)}
              </option>
            ))}
          </select>
        </Field>
        <div className="form-2">
          <Field label="From">
            <select className="select" value={origin} onChange={(e) => setOrigin(e.target.value)}>
              {originOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="To">
            <select className="select" value={dest} onChange={(e) => setDest(e.target.value)}>
              {destOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Planned departure">
            <input className="input" type="datetime-local" value={dep} onChange={(e) => setDep(e.target.value)} />
          </Field>
          <Field label="Planned arrival">
            <input className="input" type="datetime-local" value={arr} onChange={(e) => setArr(e.target.value)} />
          </Field>
        </div>
        <AssetSelects refs={refs} value={assets} onChange={setAssets} />
        <Field label="Notes">
          <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <button
          className="btn btn-primary"
          disabled={busy || !origin || !dest}
          onClick={async () => {
            const body: TripInput = {
              kind,
              originSiteId: origin,
              destinationSiteId: dest,
              plannedDeparture: fromLocalInput(dep),
              plannedArrival: fromLocalInput(arr),
              notes,
              ...assets,
            };
            const t = await run(() => api.post<Trip>("/trips", body), (r) => `${r.code} planned`);
            if (t) onCreated(t);
          }}
        >
          Create trip
        </button>
      </div>
    </Modal>
  );
}
