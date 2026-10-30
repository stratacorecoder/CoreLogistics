import { formatKg, type HandlingUnit, type Order, type Shipment, type Trip } from "@corelogistics/contracts";
import { api, Empty, Field, fmtTime, Modal, Panel, Pill, Progress, qs, useAction, useApi, type Refs } from "@corelogistics/ui";
import { useEffect, useState } from "react";

const capTone = (used: number, cap: number | null) => (cap == null ? undefined : used > cap * 0.95 ? "danger" : used > cap * 0.8 ? "warn" : "ok");

export function ShipView({ siteId, refs }: { siteId: string; refs: Refs }) {
  const shipments = useApi<Shipment[]>(`/outbound/shipments${qs({ siteId, status: "planning,loading,loaded" })}`);
  const trips = useApi<Trip[]>(`/trips${qs({ siteId, active: "true" })}`);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const shipment = shipments.data?.find((s) => s.id === selectedId) ?? null;
  const outbound = (trips.data ?? []).filter((t) => t.originSiteId === siteId && (t.status === "planned" || t.status === "dispatched"));

  useEffect(() => {
    if (!shipment && shipments.data?.length) setSelectedId(shipments.data[0]!.id);
  }, [shipments.data, shipment]);

  return (
    <div className="split" style={{ gridTemplateColumns: "340px minmax(0, 1fr)" }}>
      <Panel title="Shipments" scroll actions={<button className="btn btn-ghost btn-sm" onClick={() => setCreating(true)}>Build shipment</button>}>
        {shipments.data?.length ? (
          <div className="list">
            {shipments.data.map((s) => (
              <button key={s.id} className={`item${s.id === selectedId ? " is-selected" : ""}`} onClick={() => setSelectedId(s.id)}>
                <div className="row-between">
                  <span className="item-title">{s.code}</span>
                  <Pill value={s.status} />
                </div>
                <div className="item-meta">
                  {s.tripCode ?? "No trip"} · {s.vehicleId ? refs.plate(s.vehicleId) : "no truck"} · {s.dockCode ? `dock ${s.dockCode}` : "not docked"}
                </div>
                <div style={{ marginTop: 6 }}>
                  <Progress value={s.huLoaded} max={s.huTotal} tone={s.huTotal && s.huLoaded >= s.huTotal ? "ok" : undefined} />
                </div>
              </button>
            ))}
          </div>
        ) : (
          <Empty>No shipments in progress</Empty>
        )}
      </Panel>
      {shipment ? (
        <ShipmentPanel key={shipment.id} shipment={shipment} trips={outbound} allTrips={trips.data ?? []} refs={refs} />
      ) : (
        <Panel title="Shipment">
          <Empty>Select or build a shipment</Empty>
        </Panel>
      )}
      {creating ? (
        <NewShipment
          siteId={siteId}
          trips={outbound}
          refs={refs}
          onClose={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            setSelectedId(s.id);
          }}
        />
      ) : null}
    </div>
  );
}

function tripLabel(t: Trip, refs: Refs) {
  return `${t.code} → ${refs.siteCode(t.destinationSiteId)} · ${t.vehicleId ? refs.plate(t.vehicleId) : "no truck"} · ${fmtTime(t.plannedDeparture)}`;
}

function ShipmentPanel({ shipment, trips, allTrips, refs }: { shipment: Shipment; trips: Trip[]; allTrips: Trip[]; refs: Refs }) {
  const hus = useApi<HandlingUnit[]>(`/warehouse/hus${qs({ siteId: shipment.siteId, status: "picked,staged,loaded" })}`);
  const crossDock = useApi<HandlingUnit[]>(`/outbound/cross-dock${qs({ siteId: shipment.siteId })}`);
  const { busy, run } = useAction();
  const [pick, setPick] = useState<Set<string>>(new Set());
  const trip = allTrips.find((t) => t.id === shipment.tripId);
  const mine = (hus.data ?? []).filter((h) => h.shipmentId === shipment.id || (h.orderId && shipment.orderIds.includes(h.orderId)));
  const xd = (crossDock.data ?? []).filter((h) => trip && h.destinationSiteId === trip.destinationSiteId);
  const staged = mine.filter((h) => h.status === "staged");

  return (
    <div className="stack" style={{ overflow: "auto" }}>
      <Panel title={`${shipment.code}`} actions={<Pill value={shipment.status} />}>
        <div className="stack">
          {shipment.status === "planning" ? (
            <Field label="Trip">
              <select
                className="select"
                value={shipment.tripId ?? ""}
                disabled={busy}
                onChange={(e) => run(() => api.patch(`/outbound/shipments/${shipment.id}`, { tripId: e.target.value || null }), "Trip attached")}
              >
                <option value="">— choose a trip —</option>
                {trips.map((t) => (
                  <option key={t.id} value={t.id}>
                    {tripLabel(t, refs)}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <p>
              Trip <strong>{shipment.tripCode}</strong> → {refs.siteName(trip?.destinationSiteId)}
            </p>
          )}
          {shipment.tripId && !shipment.dockLocationId ? (
            <div className="callout tone-warn">
              {shipment.vehicleId ? `${refs.plate(shipment.vehicleId)} is not at a dock yet.` : "The trip has no truck yet."} The gate assigns a dock door when it
              arrives.
            </div>
          ) : null}
          {shipment.dockLocationId ? (
            <div className="big-target">
              <span className="sub">Load at</span>
              <span className="code">{shipment.dockCode}</span>
              <span className="sub">{refs.vehicleLabel(shipment.vehicleId)}</span>
            </div>
          ) : null}
          <div className="form-2">
            <div>
              <div className="row-between small">
                <span>Weight</span>
                <span className="muted">
                  {formatKg(shipment.loadedWeightKg)} / {shipment.capacityKg != null ? formatKg(shipment.capacityKg) : "—"}
                </span>
              </div>
              <Progress value={shipment.loadedWeightKg} max={shipment.capacityKg ?? 0} tone={capTone(shipment.loadedWeightKg, shipment.capacityKg)} />
            </div>
            <div>
              <div className="row-between small">
                <span>Volume</span>
                <span className="muted">
                  {shipment.loadedVolumeM3.toFixed(1)} / {shipment.capacityM3 ?? "—"} m³
                </span>
              </div>
              <Progress value={shipment.loadedVolumeM3} max={shipment.capacityM3 ?? 0} tone={capTone(shipment.loadedVolumeM3, shipment.capacityM3)} />
            </div>
          </div>
          <div className="row">
            <button
              className="btn btn-primary btn-lg grow"
              disabled={busy || !staged.length || !shipment.dockLocationId}
              onClick={() => run(() => api.post(`/outbound/shipments/${shipment.id}/load`, {}), `${staged.length} units loaded`)}
            >
              Load all staged ({staged.length})
            </button>
            <button
              className="btn btn-warn btn-lg"
              disabled={busy || shipment.huLoaded === 0}
              onClick={() => run(() => api.post(`/outbound/shipments/${shipment.id}/depart`), `${shipment.code} closed`)}
            >
              Close & release truck
            </button>
          </div>
        </div>
      </Panel>

      <Panel title={`Units (${shipment.huLoaded}/${shipment.huTotal} loaded)`}>
        {mine.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Unit</th>
                <th>Contents</th>
                <th>Where</th>
                <th className="right">Weight</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((h) => (
                <tr key={h.id}>
                  <td className="mono strong">{h.code}</td>
                  <td>
                    {h.qty} × {h.skuCode}
                  </td>
                  <td className="mono">{h.locationCode ?? "—"}</td>
                  <td className="right">{formatKg(h.weightKg)}</td>
                  <td>
                    <Pill value={h.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No units yet. Pick and stage the orders first.</Empty>
        )}
      </Panel>

      {xd.length ? (
        <Panel
          title={`Cross-dock freight for ${refs.siteCode(trip?.destinationSiteId)} (${xd.length})`}
          actions={
            <button
              className="btn btn-primary btn-sm"
              disabled={busy || !pick.size || !shipment.dockLocationId}
              onClick={async () => {
                const r = await run(() => api.post(`/outbound/shipments/${shipment.id}/load`, { huIds: [...pick] }), `${pick.size} cross-dock units loaded`);
                if (r) setPick(new Set());
              }}
            >
              Load selected ({pick.size})
            </button>
          }
        >
          <div className="list">
            {xd.map((h) => (
              <label key={h.id} className={`item row${pick.has(h.id) ? " is-selected" : ""}`} style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={pick.has(h.id)}
                  onChange={(e) => {
                    const next = new Set(pick);
                    if (e.target.checked) next.add(h.id);
                    else next.delete(h.id);
                    setPick(next);
                  }}
                />
                <span className="mono strong">{h.code}</span>
                <span className="muted small">
                  {h.qty} × {h.skuCode} · at {h.locationCode} · {formatKg(h.weightKg)}
                </span>
              </label>
            ))}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function NewShipment({
  siteId,
  trips,
  refs,
  onClose,
  onCreated,
}: {
  siteId: string;
  trips: Trip[];
  refs: Refs;
  onClose: () => void;
  onCreated: (s: Shipment) => void;
}) {
  const orders = useApi<Order[]>(`/outbound/orders${qs({ siteId, status: "picked,staged" })}`, { live: false });
  const { busy, run } = useAction();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [tripId, setTripId] = useState("");
  const free = (orders.data ?? []).filter((o) => !o.shipmentId);

  return (
    <Modal title="Build shipment" onClose={onClose}>
      <div className="form">
        <Field label="Orders ready to ship">
          {free.length ? (
            <div className="list">
              {free.map((o) => (
                <label key={o.id} className={`item row${chosen.has(o.id) ? " is-selected" : ""}`} style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={chosen.has(o.id)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(o.id);
                      else next.delete(o.id);
                      setChosen(next);
                    }}
                  />
                  <span className="strong">{o.code}</span>
                  <span className="muted small">
                    → {refs.siteCode(o.customerSiteId)} · {o.huCount} HU
                  </span>
                  <Pill value={o.status} />
                </label>
              ))}
            </div>
          ) : (
            <Empty>No picked orders without a shipment</Empty>
          )}
        </Field>
        <Field label="Trip" hint="Optional now; required before loading">
          <select className="select" value={tripId} onChange={(e) => setTripId(e.target.value)}>
            <option value="">Decide later</option>
            {trips.map((t) => (
              <option key={t.id} value={t.id}>
                {tripLabel(t, refs)}
              </option>
            ))}
          </select>
        </Field>
        <button
          className="btn btn-primary"
          disabled={busy || !chosen.size}
          onClick={async () => {
            const s = await run(
              () => api.post<Shipment>("/outbound/shipments", { siteId, orderIds: [...chosen], tripId: tripId || null }),
              (x) => `${x.code} created`,
            );
            if (s) onCreated(s);
          }}
        >
          Create shipment
        </button>
      </div>
    </Modal>
  );
}
