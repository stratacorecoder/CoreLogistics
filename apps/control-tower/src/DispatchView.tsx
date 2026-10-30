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
  Empty,
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
import { useMemo, useState } from "react";

const COLUMNS: Array<{ status: TripStatus; label: string }> = [
  { status: "planned", label: "Planned" },
  { status: "dispatched", label: "Dispatched" },
  { status: "in_transit", label: "In transit" },
  { status: "arrived", label: "Arrived" },
  { status: "completed", label: "Completed" },
];

export function DispatchView({ refs }: { refs: Refs }) {
  const now = useNow(30_000);
  const active = useApi<Trip[]>("/trips?active=true&limit=300");
  const recent = useApi<Trip[]>("/trips?status=completed,cancelled&active=false&limit=20");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");

  const all = useMemo(() => [...(active.data ?? []), ...(recent.data ?? [])], [active.data, recent.data]);
  const visible = all.filter((t) => {
    if (!filter) return true;
    const hay = `${t.code} ${refs.siteCode(t.originSiteId)} ${refs.siteCode(t.destinationSiteId)} ${refs.plate(t.vehicleId)} ${refs.driverName(t.driverId)}`;
    return hay.toLowerCase().includes(filter.toLowerCase());
  });
  const open = all.find((t) => t.id === openId) ?? null;

  return (
    <div className="page stack" style={{ display: "flex", overflow: "hidden" }}>
      <div className="row-between">
        <div className="row">
          <input className="input" style={{ width: 280 }} placeholder="Filter by trip, site, plate, driver" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <span className="muted small">
            {active.data?.filter((t) => t.delayed).length ?? 0} delayed · {active.data?.filter((t) => !t.vehicleId || !t.driverId).length ?? 0} need assets
          </span>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          New trip
        </button>
      </div>
      <div className="board">
        {COLUMNS.map((col) => {
          const trips = visible.filter((t) => t.status === col.status);
          return (
            <section key={col.status} className="board-col">
              <header className="board-col-head">
                <span>{col.label}</span>
                <Pill value={col.status}>{trips.length}</Pill>
              </header>
              <div className="board-col-body">
                {trips.length ? (
                  trips.map((t) => (
                    <button key={t.id} className={`item trip-card${t.delayed ? " is-alert" : ""}`} onClick={() => setOpenId(t.id)}>
                      <div className="row-between">
                        <span className="item-title">{t.code}</span>
                        <span className="row">
                          {t.delayed ? <Pill tone="danger">+{t.delayMinutes}m</Pill> : null}
                          <Pill tone="muted">{humanize(t.kind)}</Pill>
                        </span>
                      </div>
                      <span className="trip-route">
                        {refs.siteCode(t.originSiteId)} → {t.stops.map((s) => `${refs.siteCode(s.siteId)} → `).join("")}
                        {refs.siteCode(t.destinationSiteId)}
                      </span>
                      <span className="item-meta">
                        {t.vehicleId ? refs.vehicleLabel(t.vehicleId) : <span className="warn-text">No vehicle</span>}
                        {t.trailerId ? ` + ${refs.vehicleById.get(t.trailerId)?.code}` : ""}
                      </span>
                      <span className="item-meta">{t.driverId ? refs.driverName(t.driverId) : <span className="warn-text">No driver</span>}</span>
                      <span className="item-meta">
                        {t.status === "in_transit"
                          ? `ETA ${fmtDateTime(t.etaAt)} · ${fromNow(t.etaAt, now)}`
                          : t.status === "completed"
                            ? `Done ${fmtDateTime(t.completedAt)}`
                            : t.status === "arrived"
                              ? `Arrived ${fmtDateTime(t.actualArrival)}`
                              : `Departs ${fmtDateTime(t.plannedDeparture)} · ${fromNow(t.plannedDeparture, now)}`}
                      </span>
                    </button>
                  ))
                ) : (
                  <Empty>None</Empty>
                )}
              </div>
            </section>
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
