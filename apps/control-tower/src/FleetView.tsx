import {
  DEVICE_KINDS,
  formatCents,
  formatKg,
  humanize,
  MAINTENANCE_KINDS,
  VEHICLE_KINDS,
  type Device,
  type DeviceKind,
  type Driver,
  type EventRecord,
  type Location,
  type MaintenanceKind,
  type MaintenanceRecord,
  type Vehicle,
  type VehicleKind,
} from "@corelogistics/contracts";
import {
  api,
  API_URL,
  Empty,
  EventFeed,
  Field,
  fmtDateTime,
  fromNow,
  Modal,
  Panel,
  Pill,
  Tabs,
  useAction,
  useApi,
  type Refs,
} from "@corelogistics/ui";
import { useState } from "react";

type Sub = "vehicles" | "drivers" | "maintenance" | "devices";

export function FleetView({ refs }: { refs: Refs }) {
  const [sub, setSub] = useState<Sub>("vehicles");
  const openMaint = useApi<MaintenanceRecord[]>("/maintenance?open=true");
  return (
    <div className="page stack">
      <Tabs<Sub>
        value={sub}
        onChange={setSub}
        options={[
          { id: "vehicles", label: "Vehicles", badge: refs.vehicles?.length },
          { id: "drivers", label: "Drivers", badge: refs.drivers?.length },
          { id: "maintenance", label: "Maintenance", badge: openMaint.data?.length },
          { id: "devices", label: "Devices & automation" },
        ]}
      />
      {sub === "vehicles" ? <Vehicles refs={refs} /> : null}
      {sub === "drivers" ? <Drivers refs={refs} /> : null}
      {sub === "maintenance" ? <Maintenance refs={refs} /> : null}
      {sub === "devices" ? <Devices refs={refs} /> : null}
    </div>
  );
}

function Vehicles({ refs }: { refs: Refs }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const vehicle = refs.vehicles?.find((v) => v.id === selected) ?? null;
  return (
    <div className="split" style={{ padding: 0, overflow: "visible" }}>
      <Panel title="Fleet" actions={<button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>Add vehicle</button>}>
        <table className="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Plate</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Where</th>
              <th className="right">Capacity</th>
              <th className="right">Odometer</th>
              <th>Last GPS</th>
            </tr>
          </thead>
          <tbody>
            {(refs.vehicles ?? []).map((v) => (
              <tr key={v.id} className={`is-clickable${v.id === selected ? " is-selected" : ""}`} onClick={() => setSelected(v.id)}>
                <td className="strong">{v.code}</td>
                <td className="mono">{v.plate}</td>
                <td>{humanize(v.kind)}</td>
                <td>
                  <Pill value={v.status} />
                </td>
                <td>{v.currentSiteId ? refs.siteCode(v.currentSiteId) : "—"}</td>
                <td className="right nowrap">
                  {formatKg(v.capacityKg)} · {v.capacityM3} m³
                </td>
                <td className="right">{v.odometerKm.toLocaleString()} km</td>
                <td className="muted small">{v.lastSeenAt ? fromNow(v.lastSeenAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      {vehicle ? <VehiclePanel vehicle={vehicle} refs={refs} /> : <Panel title="Vehicle"><Empty>Select a vehicle to see its timeline</Empty></Panel>}
      {adding ? <AddVehicle refs={refs} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function VehiclePanel({ vehicle, refs }: { vehicle: Vehicle; refs: Refs }) {
  const events = useApi<EventRecord[]>(`/vehicles/${vehicle.id}/events?limit=60`, { live: (e) => e.vehicleId === vehicle.id });
  const maint = useApi<MaintenanceRecord[]>(`/maintenance?vehicleId=${vehicle.id}`);
  const { busy, run } = useAction();
  const [kind, setKind] = useState<MaintenanceKind>("service");
  const [desc, setDesc] = useState("");
  const open = maint.data?.filter((m) => !m.closedAt) ?? [];
  return (
    <Panel title={`${vehicle.code} · ${vehicle.plate}`} scroll actions={<Pill value={vehicle.status} />}>
      <div className="stack">
        <dl className="kv">
          <dt>Model</dt>
          <dd>{vehicle.model || "—"}</dd>
          <dt>Home</dt>
          <dd>{refs.siteName(vehicle.homeSiteId)}</dd>
          <dt>RFID tag</dt>
          <dd className="mono">{vehicle.rfidTag ?? "—"}</dd>
          <dt>Last position</dt>
          <dd>{vehicle.lastLat != null ? `${vehicle.lastLat.toFixed(4)}, ${vehicle.lastLng?.toFixed(4)} · ${fromNow(vehicle.lastSeenAt)}` : "—"}</dd>
        </dl>
        {open.map((m) => (
          <div key={m.id} className="callout tone-danger">
            <div className="strong">{humanize(m.kind)}: {m.description}</div>
            <div className="small muted">Opened {fmtDateTime(m.openedAt)}</div>
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} disabled={busy} onClick={() => run(() => api.post(`/maintenance/${m.id}/close`, { costCents: 0 }), "Back in service")}>
              Close and return to service
            </button>
          </div>
        ))}
        <div className="form">
          <div className="row">
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value as MaintenanceKind)}>
              {MAINTENANCE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </select>
            <input className="input grow" placeholder="What needs doing?" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
          <div className="row">
            <button
              className="btn btn-warn btn-sm"
              disabled={busy || !desc}
              onClick={async () => {
                const ok = await run(() => api.post("/maintenance", { vehicleId: vehicle.id, kind, description: desc }), "Sent to workshop");
                if (ok) setDesc("");
              }}
            >
              Open work order
            </button>
            <button
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() =>
                run(
                  () => api.patch(`/vehicles/${vehicle.id}`, { status: vehicle.status === "inactive" ? "available" : "inactive" }),
                  vehicle.status === "inactive" ? "Reactivated" : "Deactivated",
                )
              }
            >
              {vehicle.status === "inactive" ? "Reactivate" : "Deactivate"}
            </button>
          </div>
        </div>
        <p className="field-label">Timeline</p>
        <EventFeed events={events.data} />
      </div>
    </Panel>
  );
}

function AddVehicle({ refs, onClose }: { refs: Refs; onClose: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ code: "", plate: "", kind: "truck" as VehicleKind, model: "", capacityKg: 10000, capacityM3: 40, rfidTag: "" });
  const depot = refs.sites?.find((s) => s.kind === "depot");
  return (
    <Modal title="Add vehicle" onClose={onClose}>
      <div className="form-2">
        <Field label="Code"><input className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Plate"><input className="input" value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value })} /></Field>
        <Field label="Kind">
          <select className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as VehicleKind })}>
            {VEHICLE_KINDS.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}
          </select>
        </Field>
        <Field label="Model"><input className="input" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
        <Field label="Capacity kg"><input className="input" type="number" value={f.capacityKg} onChange={(e) => setF({ ...f, capacityKg: Number(e.target.value) })} /></Field>
        <Field label="Capacity m³"><input className="input" type="number" value={f.capacityM3} onChange={(e) => setF({ ...f, capacityM3: Number(e.target.value) })} /></Field>
        <Field label="RFID tag (optional)"><input className="input" value={f.rfidTag} onChange={(e) => setF({ ...f, rfidTag: e.target.value })} /></Field>
      </div>
      <button
        className="btn btn-primary"
        disabled={busy || !f.code || !f.plate}
        onClick={async () => {
          const ok = await run(() => api.post("/vehicles", { ...f, rfidTag: f.rfidTag || null, homeSiteId: depot?.id ?? null }), `${f.code} added`);
          if (ok) onClose();
        }}
      >
        Add
      </button>
    </Modal>
  );
}

function Drivers({ refs }: { refs: Refs }) {
  const { busy, run } = useAction();
  const trips = useApi<{ driverId: string | null; code: string; status: string }[]>("/trips?active=true&limit=300");
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ code: "", name: "", phone: "", licenseClass: "C", licenseExpiry: "2028-12-31" });
  const soon = Date.now() + 90 * 86_400_000;
  return (
    <Panel title="Drivers" actions={<button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>Add driver</button>}>
      <table className="table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Phone</th>
            <th>License</th>
            <th>Status</th>
            <th>Current trip</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(refs.drivers ?? []).map((d: Driver) => {
            const trip = trips.data?.find((t) => t.driverId === d.id && t.status !== "planned");
            const expiring = Date.parse(d.licenseExpiry) < soon;
            return (
              <tr key={d.id}>
                <td className="strong">{d.code}</td>
                <td>{d.name}</td>
                <td className="muted">{d.phone}</td>
                <td className={expiring ? "danger-text" : ""}>
                  {d.licenseClass} · exp {d.licenseExpiry}
                </td>
                <td><Pill value={d.status} /></td>
                <td>{trip ? `${trip.code} (${humanize(trip.status)})` : "—"}</td>
                <td className="right">
                  {d.status !== "on_trip" ? (
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => run(() => api.patch(`/drivers/${d.id}`, { status: d.status === "off_duty" ? "available" : "off_duty" }), "Driver updated")}
                    >
                      {d.status === "off_duty" ? "Set on duty" : "Set off duty"}
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {adding ? (
        <Modal title="Add driver" onClose={() => setAdding(false)}>
          <div className="form-2">
            <Field label="Code"><input className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
            <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Phone"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
            <Field label="License class"><input className="input" value={f.licenseClass} onChange={(e) => setF({ ...f, licenseClass: e.target.value })} /></Field>
            <Field label="License expiry"><input className="input" type="date" value={f.licenseExpiry} onChange={(e) => setF({ ...f, licenseExpiry: e.target.value })} /></Field>
          </div>
          <button
            className="btn btn-primary"
            disabled={busy || !f.code || !f.name}
            onClick={async () => {
              const ok = await run(() => api.post("/drivers", { ...f, homeSiteId: refs.sites?.find((s) => s.kind === "depot")?.id ?? null }), `${f.name} added`);
              if (ok) setAdding(false);
            }}
          >
            Add
          </button>
        </Modal>
      ) : null}
    </Panel>
  );
}

function Maintenance({ refs }: { refs: Refs }) {
  const list = useApi<MaintenanceRecord[]>("/maintenance");
  const { busy, run } = useAction();
  const [cost, setCost] = useState<Record<string, string>>({});
  return (
    <Panel title="Work orders">
      <table className="table">
        <thead>
          <tr>
            <th>Vehicle</th>
            <th>Kind</th>
            <th>Description</th>
            <th>Opened</th>
            <th>Closed</th>
            <th className="right">Cost</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(list.data ?? []).map((m) => (
            <tr key={m.id}>
              <td className="strong">{refs.vehicleLabel(m.vehicleId)}</td>
              <td><Pill tone={m.closedAt ? "muted" : "danger"}>{humanize(m.kind)}</Pill></td>
              <td>{m.description}</td>
              <td>{fmtDateTime(m.openedAt)}</td>
              <td>{fmtDateTime(m.closedAt)}</td>
              <td className="right">{m.closedAt ? formatCents(m.costCents) : null}</td>
              <td className="right">
                {!m.closedAt ? (
                  <span className="row" style={{ justifyContent: "flex-end" }}>
                    <input className="input" style={{ width: 90 }} placeholder="Cost $" value={cost[m.id] ?? ""} onChange={(e) => setCost({ ...cost, [m.id]: e.target.value })} />
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={busy}
                      onClick={() => run(() => api.post(`/maintenance/${m.id}/close`, { costCents: Math.round(Number(cost[m.id] || 0) * 100) }), "Work order closed")}
                    >
                      Close
                    </button>
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function Devices({ refs }: { refs: Refs }) {
  const devices = useApi<Device[]>("/devices", { live: (e) => e.type.startsWith("device.") });
  const { busy, run } = useAction();
  const [form, setForm] = useState({ code: "", name: "", kind: "camera" as DeviceKind, siteId: "", locationId: "", vehicleId: "" });
  const locations = useApi<Location[]>(form.siteId ? `/sites/${form.siteId}/locations` : null, { live: false });
  const [created, setCreated] = useState<{ device: Device; apiKey: string } | null>(null);
  const ownSites = (refs.sites ?? []).filter((s) => s.kind === "depot" || s.kind === "warehouse");
  const readable = (locations.data ?? []).filter((l) => ["gate", "dock_door", "yard_slot", "bin"].includes(l.kind));

  return (
    <div className="split" style={{ padding: 0, overflow: "visible" }}>
      <Panel title="Registered devices">
        <table className="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Kind</th>
              <th>Bound to</th>
              <th>Last seen</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {(devices.data ?? []).map((d) => (
              <tr key={d.id}>
                <td>
                  <div className="strong">{d.code}</div>
                  <div className="muted small">{d.name}</div>
                </td>
                <td>{humanize(d.kind)}</td>
                <td>{d.vehicleId ? refs.vehicleLabel(d.vehicleId) : `${refs.siteCode(d.siteId)} location`}</td>
                <td className="muted">{d.lastSeenAt ? fromNow(d.lastSeenAt) : "never"}</td>
                <td>
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api.patch(`/devices/${d.id}`, { active: !d.active }), "Device updated")}>
                    {d.active ? "Disable" : "Enable"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 14 }}>
          <p className="field-label" style={{ marginBottom: 6 }}>Ingest API</p>
          <pre className="snippet">{`POST ${API_URL}/ingest/events
x-device-key: <key>

{ "type": "plate_read", "plate": "NBE 4174", "direction": "in" }
{ "type": "rfid_read",  "tag": "HU-100123" }
{ "type": "gps_ping",   "lat": 14.21, "lng": 121.16, "speedKph": 40 }`}</pre>
          <p className="muted small" style={{ marginTop: 6 }}>
            Full schema at <a href={`${API_URL}/docs`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{API_URL}/docs</a>
          </p>
        </div>
      </Panel>
      <Panel title="Register device">
        <div className="form">
          <div className="form-2">
            <Field label="Code"><input className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
            <Field label="Kind">
              <select className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as DeviceKind })}>
                {DEVICE_KINDS.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          {form.kind === "gps" ? (
            <Field label="Vehicle">
              <select className="select" value={form.vehicleId} onChange={(e) => setForm({ ...form, vehicleId: e.target.value })}>
                <option value="">Choose…</option>
                {(refs.vehicles ?? []).map((v) => <option key={v.id} value={v.id}>{v.code} · {v.plate}</option>)}
              </select>
            </Field>
          ) : (
            <div className="form-2">
              <Field label="Site">
                <select className="select" value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value, locationId: "" })}>
                  <option value="">Choose…</option>
                  {ownSites.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
                </select>
              </Field>
              <Field label="Location">
                <select className="select" value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
                  <option value="">Choose…</option>
                  {readable.map((l) => <option key={l.id} value={l.id}>{l.code} ({humanize(l.kind)})</option>)}
                </select>
              </Field>
            </div>
          )}
          <button
            className="btn btn-primary"
            disabled={busy || !form.code || !form.name}
            onClick={async () => {
              const r = await run(
                () =>
                  api.post<{ device: Device; apiKey: string }>("/devices", {
                    code: form.code,
                    name: form.name,
                    kind: form.kind,
                    locationId: form.kind === "gps" ? null : form.locationId || null,
                    vehicleId: form.kind === "gps" ? form.vehicleId || null : null,
                  }),
                "Device registered",
              );
              if (r) setCreated(r);
            }}
          >
            Register
          </button>
          {created ? (
            <div className="callout">
              <div className="strong">API key for {created.device.code}</div>
              <p className="small muted">Shown once. Configure the device to send it as x-device-key.</p>
              <div className="key-box mono">{created.apiKey}</div>
            </div>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
