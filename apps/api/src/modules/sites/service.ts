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
    const byCode = new Map<string, Row>();
    for (const r of existing) {
      const prev = byCode.get(r.code);
      if (!prev || toBool(r.active)) byCode.set(r.code, r);
    }
    const derivedByCode = new Map(derived.map((l) => [l.code, l]));
    const keepIds = new Set<string>();

    for (const loc of derived) {
      const prev = byCode.get(loc.code);
      if (prev) {
        if (prev.kind !== loc.kind && toBool(prev.active)) {
          const why = locationInUse(prev.id);
          if (why) throw conflict(`Cannot change ${prev.code}: ${why}`);
        }
        keepIds.add(prev.id);
      }
    }

    for (const r of existing) {
      if (keepIds.has(r.id) || !toBool(r.active)) continue;
      const why = locationInUse(r.id);
      if (why) throw conflict(`Cannot remove ${r.code}: ${why}`);
    }

    // Park existing rows whose grid cell changes or is reclaimed so UNIQUE (site_id, x, y, level) never collides mid-update.
    const claimedCells = new Set(derived.map((l) => `${l.x}:${l.y}:${l.level}`));
    let parkOffset = Math.min(0, ...existing.map((r) => Number(r.x)), ...existing.map((r) => Number(r.y))) - 1;
    for (const r of existing) {
      const target = keepIds.has(r.id) ? derivedByCode.get(r.code) : undefined;
      const staysPut = target && r.x === target.x && r.y === target.y && r.level === target.level;
      if (staysPut) continue;
      if (target || claimedCells.has(`${r.x}:${r.y}:${r.level}`)) {
        run("UPDATE locations SET x = ?, y = ? WHERE id = ?", [parkOffset, parkOffset, r.id]);
        parkOffset -= 1;
      }
    }

    for (const r of existing) {
      if (!keepIds.has(r.id) && toBool(r.active)) {
        run("UPDATE locations SET active = 0 WHERE id = ?", [r.id]);
      }
    }

    for (const loc of derived) {
      const prev = byCode.get(loc.code);
      if (prev) {
        run(
          `UPDATE locations SET kind = ?, x = ?, y = ?, level = ?, zone = ?, capacity = ?, active = 1 WHERE id = ?`,
          [loc.kind, loc.x, loc.y, loc.level, loc.zone, loc.capacity, prev.id],
        );
      } else {
        const id = newId("loc");
        run(
          `INSERT INTO locations (id, site_id, kind, code, x, y, level, zone, capacity, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [id, siteId, loc.kind, loc.code, loc.x, loc.y, loc.level, loc.zone, loc.capacity],
        );
      }
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
