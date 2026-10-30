import {
  deriveLocations,
  SiteInputSchema,
  validateLayout,
  type Location,
  type LocationKind,
  type LocationStatus,
  type Site,
  type SiteBoard,
  type SiteLayout,
} from "@corelogistics/contracts";
import type { z } from "zod";
import { many, newId, nowIso, one, run, toBool, tx, type Row } from "../../db.js";
import { badRequest, conflict, must } from "../../errors.js";
import { emit, type Ctx } from "../../events.js";

export function toSite(r: Row): Site {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    address: r.address,
    lat: r.lat,
    lng: r.lng,
    geofenceM: r.geofence_m,
    hasLayout: toBool(r.has_layout),
  };
}

const SITE_SELECT = `SELECT s.*, EXISTS(SELECT 1 FROM site_layouts l WHERE l.site_id = s.id) AS has_layout FROM sites s`;

export function listSites(): Site[] {
  return many(`${SITE_SELECT} ORDER BY s.kind = 'customer', s.kind = 'supplier', s.code`).map(toSite);
}

export function getSite(id: string): Site {
  return toSite(must(one(`${SITE_SELECT} WHERE s.id = ?`, [id]), "Site"));
}

export function createSite(input: z.output<typeof SiteInputSchema>, ctx: Ctx): Site {
  return tx(() => {
    if (one("SELECT 1 FROM sites WHERE code = ?", [input.code])) {
      throw conflict(`Site code ${input.code} already exists`);
    }
    const id = newId("site");
    run(
      `INSERT INTO sites (id, code, name, kind, address, lat, lng, geofence_m) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.code, input.name, input.kind, input.address, input.lat, input.lng, input.geofenceM],
    );
    emit(ctx, { type: "site.created", siteId: id, entityId: id, message: `Site ${input.code} created` });
    return getSite(id);
  });
}

export function updateSite(id: string, input: Partial<z.output<typeof SiteInputSchema>>): Site {
  const current = getSite(id);
  const next = { ...current, ...input };
  run(`UPDATE sites SET name = ?, kind = ?, address = ?, lat = ?, lng = ?, geofence_m = ? WHERE id = ?`, [
    next.name,
    next.kind,
    next.address,
    next.lat,
    next.lng,
    next.geofenceM,
    id,
  ]);
  return getSite(id);
}

export function toLocation(r: Row): Location {
  return {
    id: r.id,
    siteId: r.site_id,
    kind: r.kind,
    code: r.code,
    x: r.x,
    y: r.y,
    level: r.level,
    zone: r.zone ?? null,
    capacity: r.capacity,
    active: toBool(r.active),
  };
}

export function listLocations(siteId: string, kind?: LocationKind): Location[] {
  const rows = kind
    ? many("SELECT * FROM locations WHERE site_id = ? AND kind = ? AND active = 1 ORDER BY code", [siteId, kind])
    : many("SELECT * FROM locations WHERE site_id = ? AND active = 1 ORDER BY kind, code", [siteId]);
  return rows.map(toLocation);
}

export function getLocation(id: string): Location {
  return toLocation(must(one("SELECT * FROM locations WHERE id = ?", [id]), "Location"));
}

export function findLocationByCode(siteId: string, code: string): Location | undefined {
  const r = one("SELECT * FROM locations WHERE site_id = ? AND code = ? AND active = 1", [siteId, code]);
  return r ? toLocation(r) : undefined;
}

export function getLayout(siteId: string): SiteLayout {
  getSite(siteId);
  const r = one("SELECT * FROM site_layouts WHERE site_id = ?", [siteId]);
  if (!r) return { rows: 12, cols: 20, cells: [] };
  return { rows: r.rows, cols: r.cols, cells: JSON.parse(r.cells) };
}

/** Why a location cannot be removed or repurposed, or null if it is free. */
function locationInUse(locationId: string): string | null {
  if (one("SELECT 1 FROM gate_visits WHERE yard_location_id = ? AND check_out_at IS NULL", [locationId])) {
    return "a truck is parked there";
  }
  if (one("SELECT 1 FROM dock_assignments WHERE location_id = ? AND released_at IS NULL", [locationId])) {
    return "a truck is docked there";
  }
  if (
    one(
      `SELECT 1 FROM handling_units WHERE location_id = ? AND status IN ('received','sorted','stored','picked','staged')`,
      [locationId],
    )
  ) {
    return "it holds handling units";
  }
  if (one("SELECT 1 FROM sort_rules WHERE sort_lane_id = ? AND active = 1", [locationId])) {
    return "an active sort rule targets it";
  }
  return null;
}

export function saveLayout(siteId: string, layout: SiteLayout, ctx: Ctx): SiteLayout {
  const site = getSite(siteId);
  if (site.kind === "customer" || site.kind === "supplier") {
    throw badRequest("Only depots and warehouses have a layout");
  }
  const cells = layout.cells.filter((c) => c.kind !== "empty");
  const clean: SiteLayout = { rows: layout.rows, cols: layout.cols, cells };
  const problem = validateLayout(clean);
  if (problem) throw badRequest(problem);

  return tx(() => {
    const derived = deriveLocations(clean);
    const existing = many("SELECT * FROM locations WHERE site_id = ?", [siteId]);
    const byCell = new Map(existing.map((r) => [`${r.x}:${r.y}:${r.level}`, r]));
    const keep = new Set<string>();

    for (const loc of derived) {
      const key = `${loc.x}:${loc.y}:${loc.level}`;
      const prev = byCell.get(key);
      if (prev) {
        if (prev.kind !== loc.kind && toBool(prev.active)) {
          const why = locationInUse(prev.id);
          if (why) throw conflict(`Cannot change ${prev.code}: ${why}`);
        }
        run(
          `UPDATE locations SET kind = ?, code = ?, zone = ?, capacity = ?, active = 1 WHERE id = ?`,
          [loc.kind, loc.code, loc.zone, loc.capacity, prev.id],
        );
        keep.add(prev.id);
      } else {
        const id = newId("loc");
        run(
          `INSERT INTO locations (id, site_id, kind, code, x, y, level, zone, capacity, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [id, siteId, loc.kind, loc.code, loc.x, loc.y, loc.level, loc.zone, loc.capacity],
        );
        keep.add(id);
      }
    }

    for (const r of existing) {
      if (keep.has(r.id) || !toBool(r.active)) continue;
      const why = locationInUse(r.id);
      if (why) throw conflict(`Cannot remove ${r.code}: ${why}`);
      run("UPDATE locations SET active = 0 WHERE id = ?", [r.id]);
    }

    run(
      `INSERT INTO site_layouts (site_id, rows, cols, cells, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(site_id) DO UPDATE SET rows = excluded.rows, cols = excluded.cols, cells = excluded.cells, updated_at = excluded.updated_at`,
      [siteId, clean.rows, clean.cols, JSON.stringify(clean.cells), nowIso()],
    );
    emit(ctx, {
      type: "layout.saved",
      siteId,
      message: `Layout for ${site.code} saved (${derived.length} locations)`,
      payload: { rows: clean.rows, cols: clean.cols, locations: derived.length },
    });
    return clean;
  });
}

export function getBoard(siteId: string): SiteBoard {
  const site = getSite(siteId);
  const layout = getLayout(siteId);
  const locations = listLocations(siteId);
  const status = new Map<string, { occupied: number; refs: string[]; since: string | null }>();
  const bump = (id: string, ref: string, since: string | null) => {
    const s = status.get(id) ?? { occupied: 0, refs: [], since: null };
    s.occupied += 1;
    if (!s.refs.includes(ref)) s.refs.push(ref);
    if (since && (!s.since || since < s.since)) s.since = since;
    status.set(id, s);
  };

  for (const r of many(
    `SELECT yard_location_id, plate, check_in_at FROM gate_visits
     WHERE site_id = ? AND check_out_at IS NULL AND status = 'in_yard' AND yard_location_id IS NOT NULL`,
    [siteId],
  )) {
    bump(r.yard_location_id, r.plate, r.check_in_at);
  }
  for (const r of many(
    `SELECT d.location_id, v.plate, d.assigned_at FROM dock_assignments d
     JOIN gate_visits v ON v.id = d.visit_id
     WHERE v.site_id = ? AND d.released_at IS NULL`,
    [siteId],
  )) {
    bump(r.location_id, r.plate, r.assigned_at);
  }
  for (const r of many(
    `SELECT h.location_id, s.code AS sku_code FROM handling_units h JOIN skus s ON s.id = h.sku_id
     WHERE h.site_id = ? AND h.location_id IS NOT NULL AND h.status IN ('received','sorted','stored','picked','staged')`,
    [siteId],
  )) {
    bump(r.location_id, r.sku_code, null);
  }

  const withStatus: LocationStatus[] = locations.map((l) => ({
    ...l,
    ...(status.get(l.id) ?? { occupied: 0, refs: [], since: null }),
  }));
  return { site, layout, locations: withStatus };
}

/** Straight-line distance in km between two sites (haversine). */
export function siteDistanceKm(a: Site, b: Site): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return (
    siteDistanceKm(
      { lat: lat1, lng: lng1 } as Site,
      { lat: lat2, lng: lng2 } as Site,
    ) * 1000
  );
}
