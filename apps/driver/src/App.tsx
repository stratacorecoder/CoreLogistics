import { formatDuration, humanize, ISSUE_KINDS, type Driver, type EventRecord, type IssueKind, type Trip } from "@corelogistics/contracts";
import {
  api,
  Empty,
  EventFeed,
  Field,
  fmtDateTime,
  fmtTime,
  fromNow,
  Panel,
  Pill,
  qs,
  LoginPage,
  setActor,
  useAuth,
  Shell,
  useAction,
  useApi,
  useNow,
  useRefs,
  type Refs,
} from "@corelogistics/ui";
import { useEffect, useState } from "react";

export default function App() {
  const { user, ready, signIn, signOut } = useAuth("driver");
  const refs = useRefs();
  const driver = user?.driverId ? refs.drivers?.find((d) => d.id === user.driverId) ?? null : null;

  useEffect(() => {
    if (driver) setActor(driver.name);
  }, [driver]);

  if (!ready) return null;
  if (!user) return <LoginPage onSubmit={signIn} />;

  return (
    <Shell mark="DR" title="CoreLogistics" role="Driver" tone="floor" onSwitchRole={() => void signOut()}>
      <div className="drv">
        {!user.driverId ? (
          <Panel title="Account not linked">
            <Empty>This login is not tied to a driver record. Ask ops to attach a driver id.</Empty>
          </Panel>
        ) : driver ? (
          <DriverHome driver={driver} refs={refs} />
        ) : (
          <Panel title="Your trip">
            <Empty>Loading…</Empty>
          </Panel>
        )}
      </div>
    </Shell>
  );
}

function DriverHome({ driver, refs }: { driver: Driver; refs: Refs }) {
  const now = useNow(30_000);
  const active = useApi<Trip[]>(`/trips${qs({ driverId: driver.id, active: "true" })}`);
  const done = useApi<Trip[]>(`/trips${qs({ driverId: driver.id, status: "completed", limit: 5 })}`);
  const list = [...(active.data ?? [])].sort((a, b) => rank(a) - rank(b) || Date.parse(a.plannedDeparture) - Date.parse(b.plannedDeparture));
  const current = list[0];
  const later = list.slice(1);

  return (
    <>
      <div className="drv-head">
        <span className="drv-hello">Hi, {driver.name.split(" ")[0]}</span>
        <Pill value={driver.status} />
      </div>
      {current ? <CurrentTrip key={current.id} trip={current} refs={refs} now={now} /> : <Panel title="No active trip"><Empty>Nothing assigned right now. Dispatch will send your next run here.</Empty></Panel>}
      {later.length ? (
        <Panel title="Up next">
          <div className="list">
            {later.map((t) => (
              <div key={t.id} className="item">
                <div className="row-between">
                  <span className="item-title">{t.code}</span>
                  <Pill value={t.status} />
                </div>
                <div className="item-meta">
                  {refs.siteName(t.originSiteId)} → {refs.siteName(t.destinationSiteId)}
                </div>
                <div className="item-meta">
                  Departs {fmtDateTime(t.plannedDeparture)} ({fromNow(t.plannedDeparture, now)})
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}
      {done.data?.length ? (
        <details className="drv-fold">
          <summary>Earlier trips</summary>
          <div className="list">
            {done.data.map((t) => (
              <div key={t.id} className="item">
                <div className="row-between">
                  <span className="strong">{t.code}</span>
                  <span className="muted small">{fmtDateTime(t.completedAt)}</span>
                </div>
                <div className="item-meta">
                  {refs.siteCode(t.originSiteId)} → {refs.siteCode(t.destinationSiteId)}
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
}

const rank = (t: Trip) => ({ in_transit: 0, arrived: 1, dispatched: 2, planned: 3 })[t.status as "planned"] ?? 9;

function CurrentTrip({ trip, refs, now }: { trip: Trip; refs: Refs; now: number }) {
  const { busy, run } = useAction();
  const events = useApi<EventRecord[]>(`/trips/${trip.id}/events`, { live: (e) => e.tripId === trip.id });
  const [reporting, setReporting] = useState(false);
  const act = (path: string, msg: string) => run(() => api.post<Trip>(`/trips/${trip.id}/${path}`), msg);
  const nextStop = trip.status === "in_transit" ? trip.stops.find((s) => !s.departedAt) : undefined;
  const waypoint = nextStop && nextStop.siteId !== trip.destinationSiteId ? nextStop : undefined;
  const nextName =
    trip.status === "arrived"
      ? refs.siteName(trip.destinationSiteId)
      : waypoint
        ? refs.siteName(waypoint.siteId)
        : refs.siteName(trip.destinationSiteId);

  const points = [
    { key: "o", name: refs.siteName(trip.originSiteId), meta: trip.actualDeparture ? `Left ${fmtTime(trip.actualDeparture)}` : `Planned ${fmtTime(trip.plannedDeparture)}`, done: Boolean(trip.actualDeparture), here: !trip.actualDeparture },
    ...trip.stops.map((s) => ({
      key: s.id,
      name: refs.siteName(s.siteId),
      meta: s.departedAt ? `Left ${fmtTime(s.departedAt)}` : s.arrivedAt ? `Arrived ${fmtTime(s.arrivedAt)}` : s.plannedAt ? `Planned ${fmtTime(s.plannedAt)}` : "Stop",
      done: Boolean(s.departedAt),
      here: Boolean(s.arrivedAt && !s.departedAt),
    })),
    {
      key: "d",
      name: refs.siteName(trip.destinationSiteId),
      meta: trip.actualArrival
        ? `Arrived ${fmtTime(trip.actualArrival)}`
        : trip.etaAt && trip.status === "in_transit"
          ? `ETA ${fmtTime(trip.etaAt)} (${fromNow(trip.etaAt, now)})`
          : `Planned ${fmtTime(trip.plannedArrival)}`,
      done: Boolean(trip.actualArrival),
      here: trip.status === "arrived",
    },
  ];

  return (
    <>
      <section className="trip-sheet">
        <h2 className="trip-next">{nextName}</h2>
        <p className="trip-meta-line">
          {trip.code} · {humanize(trip.kind)}
          {trip.delayed ? (
            <>
              {" · "}
              <span className="trip-late">{formatDuration(trip.delayMinutes)} late</span>
            </>
          ) : null}
        </p>
        <div className="route">
          {points.map((p) => (
            <div key={p.key} className="route-stop">
              <span className={`route-dot${p.done ? " is-done" : ""}${p.here ? " is-here" : ""}`} />
              <div>
                <div className="route-name">{p.name}</div>
                <div className="route-meta">{p.meta}</div>
              </div>
            </div>
          ))}
        </div>
        <p className="trip-truck mono">
          {refs.vehicleLabel(trip.vehicleId)}
          {trip.trailerId ? ` + ${refs.vehicleById.get(trip.trailerId)?.code ?? ""}` : ""}
        </p>
        {trip.notes ? <p className="trip-notes">{trip.notes}</p> : null}

        {trip.status === "dispatched" ? (
          <button className="btn btn-primary btn-block" disabled={busy} onClick={() => act("depart", "Departure confirmed")}>
            Confirm departure
          </button>
        ) : null}
        {trip.status === "planned" ? (
          <>
            <p className="muted small">Not yet dispatched. Departs {fromNow(trip.plannedDeparture, now)}.</p>
            <button className="btn btn-ghost btn-block" disabled={busy} onClick={() => act("depart", "Departure confirmed")}>
              I'm leaving now
            </button>
          </>
        ) : null}
        {waypoint ? (
          waypoint.arrivedAt ? (
            <button className="btn btn-primary btn-block" disabled={busy} onClick={() => run(() => api.post(`/trips/${trip.id}/stops/${waypoint.id}/depart`), "Left stop")}>
              Leaving {refs.siteName(waypoint.siteId)}
            </button>
          ) : (
            <button className="btn btn-primary btn-block" disabled={busy} onClick={() => run(() => api.post(`/trips/${trip.id}/stops/${waypoint.id}/arrive`), "Arrived at stop")}>
              Arrived at {refs.siteName(waypoint.siteId)}
            </button>
          )
        ) : null}
        {trip.status === "in_transit" && !waypoint ? (
          <button className="btn btn-primary btn-block" disabled={busy} onClick={() => act("arrive", "Arrival confirmed")}>
            Arrived at {refs.siteName(trip.destinationSiteId)}
          </button>
        ) : null}
        {trip.status === "arrived" ? (
          <button className="btn btn-primary btn-block" disabled={busy} onClick={() => act("complete", "Trip completed")}>
            Delivered, finish trip
          </button>
        ) : null}
        <button className="btn btn-ghost btn-block" onClick={() => setReporting((v) => !v)}>
          {reporting ? "Cancel report" : "Report a problem"}
        </button>
      </section>
      {reporting ? <IssueForm trip={trip} onDone={() => setReporting(false)} /> : null}
      <details className="drv-fold">
        <summary>Trip log</summary>
        <EventFeed events={events.data} />
      </details>
    </>
  );
}

function IssueForm({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  const { busy, run } = useAction();
  const [kind, setKind] = useState<IssueKind>("delay");
  const [message, setMessage] = useState("");
  const [shareLocation, setShareLocation] = useState(true);

  const position = () =>
    new Promise<{ lat?: number; lng?: number }>((resolve) => {
      if (!shareLocation || !navigator.geolocation) return resolve({});
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve({}),
        { timeout: 4000 },
      );
    });

  return (
    <Panel title="Report a problem">
      <div className="form">
        <div className="issue-grid">
          {ISSUE_KINDS.map((k) => (
            <button key={k} className={`issue-btn${kind === k ? " is-on" : ""}`} onClick={() => setKind(k)}>
              {humanize(k)}
            </button>
          ))}
        </div>
        {kind === "breakdown" ? <p className="warn-text small">A breakdown sends the truck to maintenance and alerts dispatch.</p> : null}
        <Field label="What happened?">
          <textarea className="textarea" value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <label className="row small">
          <input type="checkbox" checked={shareLocation} onChange={(e) => setShareLocation(e.target.checked)} />
          Share my location
        </label>
        <button
          className="btn btn-danger btn-block"
          disabled={busy || !message}
          onClick={async () => {
            const ok = await run(async () => api.post(`/trips/${trip.id}/issues`, { kind, message, ...(await position()) }), "Dispatch has been notified");
            if (ok) onDone();
          }}
        >
          Send to dispatch
        </button>
      </div>
    </Panel>
  );
}
