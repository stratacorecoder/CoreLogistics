import { SITE_KINDS, type Site, type SiteInput, type SiteKind } from "@corelogistics/contracts";
import { api, Field, Modal, useAction } from "@corelogistics/ui";
import { useState } from "react";

const KIND_LABELS: Record<SiteKind, string> = {
  customer: "Customer (route destination)",
  supplier: "Supplier (inbound origin)",
  warehouse: "Warehouse (blank-slate floorplan)",
  depot: "Depot (blank-slate yard & dock)",
};

export function NewSiteModal({
  initialKind = "customer",
  initialCoords,
  allowDesignRedirect = true,
  onClose,
  onCreated,
}: {
  initialKind?: SiteKind;
  initialCoords?: { lat: number; lng: number } | null;
  allowDesignRedirect?: boolean;
  onClose: () => void;
  onCreated: (site: Site, openInDesigner: boolean) => void;
}) {
  const { busy, run } = useAction();
  const [kind, setKind] = useState<SiteKind>(initialKind);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [lat, setLat] = useState(initialCoords ? initialCoords.lat.toFixed(5) : "14.55470");
  const [lng, setLng] = useState(initialCoords ? initialCoords.lng.toFixed(5) : "121.02440");
  const [geofenceM, setGeofenceM] = useState("400");

  const isFacility = kind === "warehouse" || kind === "depot";
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  const parsedGeo = Number(geofenceM);
  const valid =
    code.trim().length >= 1 &&
    code.trim().length <= 16 &&
    name.trim().length >= 1 &&
    Number.isFinite(parsedLat) &&
    parsedLat >= -90 &&
    parsedLat <= 90 &&
    Number.isFinite(parsedLng) &&
    parsedLng >= -180 &&
    parsedLng <= 180 &&
    Number.isFinite(parsedGeo) &&
    parsedGeo > 0;

  const submit = async (openInDesigner: boolean) => {
    if (!valid) return;
    const payload: SiteInput = {
      code: code.trim().toUpperCase(),
      name: name.trim(),
      kind,
      address: address.trim(),
      lat: parsedLat,
      lng: parsedLng,
      geofenceM: parsedGeo,
    };
    const created = await run(() => api.post<Site>("/sites", payload), `${payload.code} created`);
    if (created) onCreated(created, openInDesigner);
  };

  return (
    <Modal title="Add new site or destination" onClose={onClose}>
      <div className="form">
        <Field label="Site type">
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as SiteKind)}>
            {SITE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <div className="form-2">
          <Field label="Short code">
            <input
              className="input mono"
              maxLength={16}
              placeholder={kind === "customer" ? "CUS-LAG" : kind === "supplier" ? "SUP-NORTH" : "WH-SOUTH"}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Geofence radius (m)">
            <input
              className="input mono"
              type="number"
              min={50}
              step={50}
              value={geofenceM}
              onChange={(e) => setGeofenceM(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Site name">
          <input
            className="input"
            placeholder={kind === "customer" ? "Laguna Retail Hub" : "South Hub Distribution Center"}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Address">
          <input
            className="input"
            placeholder="Street, City / Province"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
        <div className="form-2">
          <Field label="Latitude">
            <input className="input mono" type="number" step="0.0001" value={lat} onChange={(e) => setLat(e.target.value)} />
          </Field>
          <Field label="Longitude">
            <input className="input mono" type="number" step="0.0001" value={lng} onChange={(e) => setLng(e.target.value)} />
          </Field>
        </div>
        {isFacility ? (
          <div className="callout">
            New {kind}s start as a <strong>blank 12×20 slate</strong> so you can paint gates, yard slots, dock doors, and racks in Site designer.
          </div>
        ) : (
          <p className="muted small">
            New {kind}s appear immediately on the Network map and in Dispatch route dropdowns.
          </p>
        )}
        <div className="row" style={{ justifyContent: "flex-end", flexWrap: "wrap", gap: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          {isFacility && allowDesignRedirect ? (
            <>
              <button type="button" className="btn btn-ghost" disabled={busy || !valid} onClick={() => void submit(false)}>
                Create site
              </button>
              <button type="button" className="btn btn-primary" disabled={busy || !valid} onClick={() => void submit(true)}>
                Create & open Site designer
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy || !valid} onClick={() => void submit(false)}>
              Add {kind}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
