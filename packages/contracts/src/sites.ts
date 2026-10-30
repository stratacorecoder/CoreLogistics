import { z } from "zod";
import { IdSchema, ZoneSchema, type Zone } from "./common.js";

export const SITE_KINDS = ["depot", "warehouse", "customer", "supplier"] as const;
export const SiteKindSchema = z.enum(SITE_KINDS);
export type SiteKind = z.infer<typeof SiteKindSchema>;

export const SiteSchema = z.object({
  id: IdSchema,
  code: z.string(),
  name: z.string(),
  kind: SiteKindSchema,
  address: z.string(),
  lat: z.number(),
  lng: z.number(),
  geofenceM: z.number(),
  hasLayout: z.boolean(),
});
export type Site = z.infer<typeof SiteSchema>;

export const SiteInputSchema = z.object({
  code: z.string().min(1).max(16),
  name: z.string().min(1),
  kind: SiteKindSchema,
  address: z.string().default(""),
  lat: z.number().min(-90).max(90).default(0),
  lng: z.number().min(-180).max(180).default(0),
  geofenceM: z.number().positive().default(300),
});
export type SiteInput = z.input<typeof SiteInputSchema>;

/** Grid widgets a site designer can paint. */
export const CELL_KINDS = [
  "empty",
  "road",
  "gate",
  "dock_door",
  "yard_slot",
  "staging",
  "sort_lane",
  "rack",
  "aisle",
  "wall",
  "office",
] as const;
export const CellKindSchema = z.enum(CELL_KINDS);
export type CellKind = z.infer<typeof CellKindSchema>;

export const CELL_META: Record<CellKind, { label: string; short: string; description: string }> = {
  empty: { label: "Empty", short: "", description: "Clear the cell" },
  road: { label: "Road", short: "", description: "Truck circulation" },
  gate: { label: "Gate", short: "GATE", description: "Site entry / exit checkpoint" },
  dock_door: { label: "Dock door", short: "DOCK", description: "Load / unload door" },
  yard_slot: { label: "Yard slot", short: "YARD", description: "Truck or trailer parking" },
  staging: { label: "Staging", short: "STG", description: "Outbound staging area" },
  sort_lane: { label: "Sort lane", short: "SORT", description: "Inbound sortation lane" },
  rack: { label: "Rack", short: "RACK", description: "Storage rack, one bin per level" },
  aisle: { label: "Aisle", short: "", description: "Forklift / picker walkway" },
  wall: { label: "Wall", short: "", description: "Building wall" },
  office: { label: "Office", short: "OFF", description: "Office or amenity" },
};

export const LayoutCellSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  kind: CellKindSchema,
  label: z.string().max(16).optional(),
  zone: ZoneSchema.optional(),
  levels: z.number().int().min(1).max(8).optional(),
  capacity: z.number().int().min(1).max(500).optional(),
});
export type LayoutCell = z.infer<typeof LayoutCellSchema>;

/** Sparse grid: cells not listed are `empty`. */
export const SiteLayoutSchema = z.object({
  rows: z.number().int().min(4).max(60),
  cols: z.number().int().min(4).max(80),
  cells: z.array(LayoutCellSchema),
});
export type SiteLayout = z.infer<typeof SiteLayoutSchema>;

export const LOCATION_KINDS = [
  "gate",
  "dock_door",
  "yard_slot",
  "staging",
  "sort_lane",
  "aisle",
  "rack",
  "bin",
] as const;
export const LocationKindSchema = z.enum(LOCATION_KINDS);
export type LocationKind = z.infer<typeof LocationKindSchema>;

export const LocationSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  kind: LocationKindSchema,
  code: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  level: z.number().int(),
  zone: ZoneSchema.nullable(),
  capacity: z.number().int(),
  active: z.boolean(),
});
export type Location = z.infer<typeof LocationSchema>;

export const LocationStatusSchema = LocationSchema.extend({
  occupied: z.number().int(),
  refs: z.array(z.string()),
  since: z.string().nullable(),
});
export type LocationStatus = z.infer<typeof LocationStatusSchema>;

export const SiteBoardSchema = z.object({
  site: SiteSchema,
  layout: SiteLayoutSchema,
  locations: z.array(LocationStatusSchema),
});
export type SiteBoard = z.infer<typeof SiteBoardSchema>;

export interface DerivedLocation {
  kind: LocationKind;
  code: string;
  x: number;
  y: number;
  level: number;
  zone: Zone | null;
  capacity: number;
}

const DEFAULT_CAPACITY: Partial<Record<LocationKind, number>> = {
  gate: 1,
  dock_door: 1,
  yard_slot: 1,
  staging: 24,
  sort_lane: 40,
  bin: 2,
};

const CODE_PREFIX: Partial<Record<CellKind, string>> = {
  gate: "G",
  dock_door: "D",
  yard_slot: "Y",
  staging: "S",
  sort_lane: "L",
  rack: "R",
};

/** Location code of each coded cell (racks without the level suffix), keyed "x:y". */
function cellCodes(layout: SiteLayout): Map<string, string> {
  const sorted = [...layout.cells].sort((a, b) => a.y - b.y || a.x - b.x);
  const taken = new Set(sorted.map((c) => c.label?.trim()).filter(Boolean));
  const counters = new Map<CellKind, number>();
  const out = new Map<string, string>();
  for (const cell of sorted) {
    const prefix = CODE_PREFIX[cell.kind];
    if (!prefix) continue;
    let code = cell.label?.trim();
    if (!code) {
      let n = counters.get(cell.kind) ?? 0;
      do code = `${prefix}${String(++n).padStart(2, "0")}`;
      while (taken.has(code));
      counters.set(cell.kind, n);
    }
    out.set(`${cell.x}:${cell.y}`, code);
  }
  return out;
}

/**
 * Pins every coded cell to its current code, so cells added later are
 * numbered after the existing ones instead of renumbering them.
 */
export function freezeLabels(layout: SiteLayout): SiteLayout {
  const codes = cellCodes(layout);
  return {
    ...layout,
    cells: layout.cells.map((c) => {
      const code = codes.get(`${c.x}:${c.y}`);
      return code && !c.label ? { ...c, label: code } : c;
    }),
  };
}

/**
 * Turns a painted grid into addressable locations. Racks expand into one
 * `bin` per level. Unlabelled cells are numbered row-major, skipping codes
 * already claimed by a label.
 */
export function deriveLocations(layout: SiteLayout): DerivedLocation[] {
  const sorted = [...layout.cells].sort((a, b) => a.y - b.y || a.x - b.x);
  const codes = cellCodes(layout);
  const out: DerivedLocation[] = [];
  for (const cell of sorted) {
    const base = codes.get(`${cell.x}:${cell.y}`);
    if (!base) continue;
    const zone = cell.zone ?? null;
    if (cell.kind === "rack") {
      const levels = cell.levels ?? 3;
      for (let level = 1; level <= levels; level++) {
        out.push({
          kind: "bin",
          code: `${base}-${level}`,
          x: cell.x,
          y: cell.y,
          level,
          zone,
          capacity: cell.capacity ?? DEFAULT_CAPACITY.bin!,
        });
      }
      continue;
    }
    const kind = cell.kind as LocationKind;
    out.push({
      kind,
      code: base,
      x: cell.x,
      y: cell.y,
      level: 0,
      zone,
      capacity: cell.capacity ?? DEFAULT_CAPACITY[kind] ?? 1,
    });
  }
  return out;
}

export function validateLayout(layout: SiteLayout): string | null {
  const seen = new Set<string>();
  for (const cell of layout.cells) {
    if (cell.x >= layout.cols || cell.y >= layout.rows) {
      return `Cell ${cell.x},${cell.y} is outside the ${layout.cols}x${layout.rows} grid`;
    }
    const key = `${cell.x}:${cell.y}`;
    if (seen.has(key)) return `Cell ${key} is defined twice`;
    seen.add(key);
  }
  const codes = new Set<string>();
  for (const loc of deriveLocations(layout)) {
    if (codes.has(loc.code)) return `Location code ${loc.code} is used twice`;
    codes.add(loc.code);
  }
  return null;
}
