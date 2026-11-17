import { formatDuration, humanize, type Site, type Trip } from "@corelogistics/contracts";
import { Empty, ErrorNote, fmtDateTime, fromNow, Panel, Pill, SendNudgeModal, useApi, useNow, WaybillModal, type Refs } from "@corelogistics/ui";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { BellRing, FileText, MapPinPlus, Maximize2, Navigation, Plus, Radio } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NewSiteModal } from "./NewSiteModal";

const SITE_COLOR: Record<Site["kind"], string> = {
  warehouse: "#0066cc",
  depot: "#5856d6",
  customer: "#157a34",
  supplier: "#c2410c",
};

const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function useDarkTheme(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.getAttribute("data-theme") === "dark");
  useEffect(() => {
    const node = document.documentElement;
    const sync = () => setDark(node.getAttribute("data-theme") === "dark");
    const obs = new MutationObserver(sync);
    obs.observe(node, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

/** Smoothly curve a 2-point leg slightly so overlapping corridors remain distinct. */
function curvedLeg(a: [number, number], b: [number, number], offsetFactor = 0.12): [number, number][] {
  const dLat = b[0] - a[0];
  const dLng = b[1] - a[1];
  const midLat = (a[0] + b[0]) / 2 - dLng * offsetFactor;
  const midLng = (a[1] + b[1]) / 2 + dLat * offsetFactor;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const u = 1 - t;
    pts.push([
      u * u * a[0] + 2 * u * t * midLat + t * t * b[0],
      u * u * a[1] + 2 * u * t * midLng + t * t * b[1],
    ]);
  }
  return pts;
}

export function NetworkMapView({
  refs,
  onOpenSite,
  onOpenDesigner,
  onOpenTrip,
}: {
  refs: Refs;
  onOpenSite?: (siteId: string) => void;
  onOpenDesigner?: (siteId: string) => void;
  onOpenTrip?: (code: string) => void;
}) {
  const now = useNow(30_000);
  const dark = useDarkTheme();
  const trips = useApi<Trip[]>("/trips?active=true&limit=200", {
    live: (e) => e.type.startsWith("trip.") || e.type.startsWith("gate.") || e.type === "vehicle.position",
  });
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [nudgeTrip, setNudgeTrip] = useState<Trip | null>(null);
  const [waybillTripId, setWaybillTripId] = useState<string | null>(null);
  const [pickingPin, setPickingPin] = useState(false);
  const [addingSite, setAddingSite] = useState<{ lat: number; lng: number } | null | false>(false);

  const mapHostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false);

  const sites = useMemo(
    () => (refs.sites ?? []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng)),
    [refs.sites],
  );
  const vehicles = refs.vehicles ?? [];
  const siteById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);
  const activeTrips = trips.data ?? [];
  const selectedSite = selectedSiteId ? siteById.get(selectedSiteId) ?? null : null;
  const selectedTrip = selectedTripId ? activeTrips.find((t) => t.id === selectedTripId) ?? null : null;

  const siteTrips = useMemo(() => {
    if (!selectedSite) return [];
    return activeTrips.filter(
      (t) =>
        t.originSiteId === selectedSite.id ||
        t.destinationSiteId === selectedSite.id ||
        t.stops.some((s) => s.siteId === selectedSite.id),
    );
  }, [activeTrips, selectedSite]);

  const fitNetwork = useCallback(() => {
    const map = mapRef.current;
    if (!map || !sites.length) return;
    const bounds = L.latLngBounds(sites.map((s) => [s.lat, s.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [44, 44], maxZoom: 12 });
  }, [sites]);

  const flyToTrip = useCallback(
    (trip: Trip) => {
      const map = mapRef.current;
      if (!map) return;
      const pts: [number, number][] = [];
      const orig = siteById.get(trip.originSiteId);
      const dest = siteById.get(trip.destinationSiteId);
      if (orig) pts.push([orig.lat, orig.lng]);
      for (const s of trip.stops) {
        const stopSite = siteById.get(s.siteId);
        if (stopSite) pts.push([stopSite.lat, stopSite.lng]);
      }
      if (dest) pts.push([dest.lat, dest.lng]);
      if (pts.length >= 2) {
        map.flyToBounds(L.latLngBounds(pts), { padding: [64, 64], maxZoom: 12, duration: 0.55 });
      }
    },
    [siteById],
  );

  // Initialize Leaflet map instance
  useEffect(() => {
    const host = mapHostRef.current;
    if (!host || mapRef.current) return;
    const map = L.map(host, {
      center: [14.55, 121.02],
      zoom: 10,
      zoomControl: true,
      attributionControl: true,
    });
    L.tileLayer(OSM_TILES, {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);
    const group = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerRef.current = group;

    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(host);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      fittedRef.current = false;
    };
  }, []);

  // Allow Control Tower planner to click the map to drop a new site/destination pin
  useEffect(() => {
    const map = mapRef.current;
    const host = mapHostRef.current;
    if (!map || !host) return;
    host.style.cursor = pickingPin ? "crosshair" : "";
    if (!pickingPin) return;
    const onClick = (ev: L.LeafletMouseEvent) => {
      setPickingPin(false);
      setAddingSite({ lat: ev.latlng.lat, lng: ev.latlng.lng });
    };
    map.on("click", onClick);
    return () => {
      host.style.cursor = "";
      map.off("click", onClick);
    };
  }, [pickingPin]);

  // Fit bounds once sites load
  useEffect(() => {
    if (!fittedRef.current && sites.length && mapRef.current) {
      fittedRef.current = true;
      fitNetwork();
    }
  }, [sites, fitNetwork]);

  // Render site markers, geofences, active routes, and live trucks
  useEffect(() => {
    const group = layerRef.current;
    if (!group) return;
    group.clearLayers();

    // 1. Routes + Trucks
    activeTrips.forEach((t, idx) => {
      const orig = siteById.get(t.originSiteId);
      const dest = siteById.get(t.destinationSiteId);
      if (!orig || !dest) return;

      const isSelected = t.id === selectedTripId;
      const stroke = t.delayed ? "#ff3b30" : t.status === "in_transit" ? "#007aff" : "#157a34";
      const curveOffset = ((idx % 3) - 1) * 0.08 + 0.06;
      const pathPts = curvedLeg([orig.lat, orig.lng], [dest.lat, dest.lng], curveOffset);

      const line = L.polyline(pathPts, {
        color: stroke,
        weight: isSelected ? 4.5 : t.delayed ? 3 : 2.5,
        opacity: isSelected ? 0.95 : 0.72,
        dashArray: t.status === "planned" ? "6 6" : undefined,
      }).addTo(group);

      line.on("click", () => {
        setSelectedTripId(t.id);
        setSelectedSiteId(null);
        flyToTrip(t);
      });

      // Plot live GPS or interpolated truck badge for in-transit / delayed trips
      const veh = t.vehicleId ? vehicles.find((v) => v.id === t.vehicleId) : undefined;
      let truckPos: [number, number] | null = null;
      if (veh?.lastLat != null && veh?.lastLng != null) {
        truckPos = [veh.lastLat, veh.lastLng];
      } else if (t.status === "in_transit") {
        const start = Date.parse(t.actualDeparture ?? t.plannedDeparture);
        const end = Date.parse(t.etaAt ?? t.plannedArrival);
        const u = end > start ? Math.max(0.15, Math.min(0.85, (now - start) / (end - start))) : 0.5;
        const idxPt = Math.min(pathPts.length - 1, Math.max(0, Math.round(u * (pathPts.length - 1))));
        truckPos = pathPts[idxPt] ?? null;
      }

      if (truckPos) {
        const plateText = escapeHtml(veh?.plate ?? t.code);
        const badgeText = t.delayed ? `+${t.delayMinutes}m` : escapeHtml(t.code);
        const marker = L.marker(truckPos, {
          icon: L.divIcon({
            className: "leaflet-cl-reset",
            html: `<div class="net-truck-pin${t.delayed ? " is-delayed" : ""}${isSelected ? " is-selected" : ""}">
              <span class="net-truck-dot"></span>
              <span class="net-truck-plate">${plateText}</span>
              <span class="net-truck-tag">${badgeText}</span>
            </div>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          }),
          zIndexOffset: isSelected ? 900 : 500,
        }).addTo(group);

        marker.on("click", () => {
          setSelectedTripId(t.id);
          setSelectedSiteId(null);
          flyToTrip(t);
        });
      }
    });

    // 2. Site nodes & geofence circles
    for (const site of sites) {
      const color = SITE_COLOR[site.kind];
      const isSelected = site.id === selectedSiteId;

      L.circle([site.lat, site.lng], {
        radius: site.geofenceM,
        color,
        weight: isSelected ? 2 : 1.2,
        opacity: 0.55,
        fillColor: color,
        fillOpacity: isSelected ? 0.2 : 0.1,
        dashArray: "4 4",
      }).addTo(group);

      const pin = L.marker([site.lat, site.lng], {
        icon: L.divIcon({
          className: "leaflet-cl-reset",
          html: `<div class="net-site-pin${isSelected ? " is-selected" : ""}" style="--pin-color: ${color}">
            <span class="net-site-dot"></span>
            <span class="net-site-code">${escapeHtml(site.code)}</span>
          </div>`,
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        }),
        zIndexOffset: isSelected ? 800 : 300,
      }).addTo(group);

      pin.on("click", () => {
        setSelectedSiteId(site.id);
        setSelectedTripId(null);
        mapRef.current?.flyTo([site.lat, site.lng], Math.max(mapRef.current.getZoom(), 12), { duration: 0.45 });
      });
    }
  }, [activeTrips, flyToTrip, now, selectedSiteId, selectedTripId, siteById, sites, vehicles]);

  return (
    <div className="three live-board" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 360px)" }}>
      <Panel
        title="Network Corridor Map"
        className="grow live-map-panel"
        actions={
          <div className="map-toolbar">
            <div className="map-legend">
              {(["warehouse", "depot", "customer", "supplier"] as const).map((k) => (
                <span key={k} className="legend-item">
                  <i className="legend-swatch" style={{ background: SITE_COLOR[k] }} />
                  {humanize(k)}
                </span>
              ))}
            </div>
            <button
              type="button"
              className={`btn btn-sm ${pickingPin ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setPickingPin((v) => !v)}
              title="Click anywhere on the map to place a new destination or site"
            >
              <MapPinPlus size={13} /> {pickingPin ? "Click map to drop pin…" : "Drop pin"}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setPickingPin(false);
                setAddingSite(null);
              }}
            >
              <Plus size={13} /> Add new site
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setSelectedSiteId(null);
                setSelectedTripId(null);
                fitNetwork();
              }}
              title="Reset zoom to entire network"
            >
              <Maximize2 size={13} /> Fit network
            </button>
          </div>
        }
      >
        <ErrorNote error={trips.error} />
        {!sites.length ? (
          <Empty>No sites with coordinates available</Empty>
        ) : (
          <div className="network-map-stage">
            <div ref={mapHostRef} className={`network-leaflet-host${dark ? " is-dark" : ""}`} />
          </div>
        )}
      </Panel>

      <div className="stack live-rail">
        {selectedTrip ? (
          <Panel
            title={`${selectedTrip.code} · ${refs.siteCode(selectedTrip.originSiteId)} → ${refs.siteCode(selectedTrip.destinationSiteId)}`}
            actions={<Pill value={selectedTrip.status} />}
          >
            <div className="stack">
              <dl className="kv">
                <dt>Vehicle</dt>
                <dd className="mono">{refs.plate(selectedTrip.vehicleId)}</dd>
                <dt>Driver</dt>
                <dd>{refs.driverName(selectedTrip.driverId)}</dd>
                <dt>ETA / Planned</dt>
                <dd>
                  {fmtDateTime(selectedTrip.etaAt ?? selectedTrip.plannedArrival)} (
                  {fromNow(selectedTrip.etaAt ?? selectedTrip.plannedArrival, now)})
                </dd>
                <dt>Delay</dt>
                <dd className={selectedTrip.delayed ? "danger-text" : ""}>
                  {selectedTrip.delayed ? `+${formatDuration(selectedTrip.delayMinutes)}` : "On schedule"}
                </dd>
              </dl>
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                {onOpenTrip ? (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenTrip(selectedTrip.code)}>
                    <Navigation size={14} /> Open in Dispatch
                  </button>
                ) : null}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setWaybillTripId(selectedTrip.id)}>
                  <FileText size={14} /> Waybill
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNudgeTrip(selectedTrip)}>
                  <BellRing size={14} /> Nudge driver
                </button>
              </div>
            </div>
          </Panel>
        ) : selectedSite ? (
          <Panel title={`${selectedSite.code} · ${selectedSite.name}`} actions={<Pill value={selectedSite.kind} />}>
            <div className="stack">
              <p className="muted small">{selectedSite.address}</p>
              <dl className="kv">
                <dt>Coordinates</dt>
                <dd className="mono">
                  {selectedSite.lat.toFixed(4)}, {selectedSite.lng.toFixed(4)}
                </dd>
                <dt>Geofence</dt>
                <dd>{selectedSite.geofenceM} m</dd>
                <dt>Active trips</dt>
                <dd>{siteTrips.length}</dd>
              </dl>
              {(selectedSite.kind === "warehouse" || selectedSite.kind === "depot") && (onOpenSite || onOpenDesigner) ? (
                <div className="row">
                  {onOpenSite ? (
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenSite(selectedSite.id)}>
                      <Radio size={14} /> Open Live site
                    </button>
                  ) : null}
                  {onOpenDesigner ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenDesigner(selectedSite.id)}>
                      Edit in Site designer
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Panel>
        ) : null}

        <Panel title={`Active corridors (${activeTrips.length})`} scroll className="grow">
          {activeTrips.length ? (
            <div className="live-trips-list">
              {activeTrips.map((t) => (
                <div
                  key={t.id}
                  className={`item${t.id === selectedTripId ? " is-selected" : ""}${t.delayed ? " is-alert" : ""}`}
                  style={{ cursor: "pointer" }}
                  onClick={() => {
                    setSelectedTripId(t.id);
                    setSelectedSiteId(null);
                    flyToTrip(t);
                  }}
                >
                  <div className="row-between">
                    <span className="item-title mono">{t.code}</span>
                    <Pill value={t.delayed ? "delayed" : t.status} tone={t.delayed ? "danger" : undefined} />
                  </div>
                  <div className="row-between" style={{ marginTop: 4, gap: 6 }}>
                    <span className="item-meta" style={{ marginTop: 0 }}>
                      {refs.siteCode(t.originSiteId)} → {refs.siteCode(t.destinationSiteId)} · {refs.plate(t.vehicleId)}
                    </span>
                    <div className="row" style={{ gap: 4 }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setWaybillTripId(t.id);
                        }}
                      >
                        <FileText size={12} /> Waybill
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setNudgeTrip(t);
                        }}
                      >
                        <BellRing size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>No active trips on the network</Empty>
          )}
        </Panel>
      </div>

      {nudgeTrip ? (
        <SendNudgeModal
          targetRole="driver"
          siteId={nudgeTrip.destinationSiteId}
          driverId={nudgeTrip.driverId}
          tripId={nudgeTrip.id}
          locationCode={nudgeTrip.code}
          onClose={() => setNudgeTrip(null)}
        />
      ) : null}
      {addingSite !== false ? (
        <NewSiteModal
          initialKind="customer"
          initialCoords={addingSite}
          onClose={() => setAddingSite(false)}
          onCreated={(site, openInDesigner) => {
            setAddingSite(false);
            setSelectedSiteId(site.id);
            setSelectedTripId(null);
            mapRef.current?.flyTo([site.lat, site.lng], 12, { duration: 0.5 });
            if (openInDesigner && onOpenDesigner) onOpenDesigner(site.id);
          }}
        />
      ) : null}
      {waybillTripId ? <WaybillModal tripId={waybillTripId} onClose={() => setWaybillTripId(null)} /> : null}
    </div>
  );
}
