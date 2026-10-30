import {
  CELL_META,
  formatDuration,
  minutesBetween,
  ZONE_META,
  type CellKind,
  type LayoutCell,
  type LocationStatus,
  type SiteLayout,
} from "@corelogistics/contracts";
import { useMemo } from "react";

export interface MapCell {
  x: number;
  y: number;
  kind: CellKind;
  label?: string;
  zone?: LayoutCell["zone"];
  levels?: number;
  capacity?: number;
}

export interface SiteMapProps {
  layout: SiteLayout;
  locations?: LocationStatus[];
  /** "x:y" of the selected cell */
  selectedKey?: string | null;
  /** Location ids to call out (e.g. suggested bin, assigned dock) */
  highlight?: Iterable<string>;
  design?: boolean;
  onCellClick?: (cell: MapCell, locations: LocationStatus[]) => void;
  onCellPointerDown?: (cell: MapCell) => void;
  onCellPointerEnter?: (cell: MapCell) => void;
  now?: number;
  cellSize?: number;
}

const SHOWS_CODE: Partial<Record<CellKind, boolean>> = {
  gate: true,
  dock_door: true,
  yard_slot: true,
  staging: true,
  sort_lane: true,
  rack: true,
};

export function SiteMap({
  layout,
  locations = [],
  selectedKey,
  highlight,
  design = false,
  onCellClick,
  onCellPointerDown,
  onCellPointerEnter,
  now = Date.now(),
  cellSize = 34,
}: SiteMapProps) {
  const grid = useMemo(() => {
    const byKey = new Map(layout.cells.map((c) => [`${c.x}:${c.y}`, c]));
    const out: MapCell[] = [];
    for (let y = 0; y < layout.rows; y++) {
      for (let x = 0; x < layout.cols; x++) {
        out.push(byKey.get(`${x}:${y}`) ?? { x, y, kind: "empty" });
      }
    }
    return out;
  }, [layout]);

  const locsByCell = useMemo(() => {
    const m = new Map<string, LocationStatus[]>();
    for (const l of locations) {
      const k = `${l.x}:${l.y}`;
      const list = m.get(k) ?? [];
      list.push(l);
      m.set(k, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.level - b.level);
    return m;
  }, [locations]);

  const hot = useMemo(() => new Set(highlight ?? []), [highlight]);

  return (
    <div
      className={`site-map${design ? " is-design" : ""}`}
      style={{
        gridTemplateColumns: `repeat(${layout.cols}, ${cellSize}px)`,
        gridAutoRows: `${cellSize}px`,
      }}
      onDragStart={(e) => e.preventDefault()}
    >
      {grid.map((cell) => {
        const key = `${cell.x}:${cell.y}`;
        const locs = locsByCell.get(key) ?? [];
        const occupied = locs.reduce((n, l) => n + l.occupied, 0);
        const capacity = locs.reduce((n, l) => n + l.capacity, 0);
        const first = locs[0];
        const since = locs.find((l) => l.since)?.since ?? null;
        const ref = locs.flatMap((l) => l.refs)[0];
        const isHot = locs.some((l) => hot.has(l.id));
        const code =
          cell.kind === "rack" && first ? first.code.replace(/-\d+$/, "") : first?.code ?? cell.label ?? "";
        const zone = cell.zone;
        const full = capacity > 0 && occupied >= capacity;
        const vehicleCell = cell.kind === "yard_slot" || cell.kind === "dock_door";
        const title = [
          CELL_META[cell.kind].label,
          code,
          zone ? `zone ${zone} ${ZONE_META[zone].label}` : "",
          vehicleCell && ref ? `${ref}${since ? ` · ${formatDuration(minutesBetween(since, now))}` : ""}` : "",
          !vehicleCell && capacity ? `${occupied}/${capacity} used` : "",
          !vehicleCell && locs.length ? locs.flatMap((l) => l.refs).slice(0, 6).join(", ") : "",
        ]
          .filter(Boolean)
          .join(" — ");

        const classes = [
          "map-cell",
          `k-${cell.kind}`,
          occupied > 0 ? "is-busy" : "",
          full ? "is-full" : "",
          selectedKey === key ? "is-selected" : "",
          isHot ? "is-hot" : "",
          onCellClick || design ? "is-clickable" : "",
        ]
          .filter(Boolean)
          .join(" ");

        if (!design && cell.kind === "empty") return <div key={key} className="map-cell k-empty" />;

        return (
          <button
            key={key}
            type="button"
            className={classes}
            title={title}
            style={zone ? { boxShadow: `inset 3px 0 0 ${ZONE_META[zone].color}` } : undefined}
            onClick={() => onCellClick?.(cell, locs)}
            onPointerDown={(e) => {
              if (!onCellPointerDown) return;
              e.preventDefault();
              onCellPointerDown(cell);
            }}
            onPointerEnter={() => onCellPointerEnter?.(cell)}
          >
            {SHOWS_CODE[cell.kind] && code ? <span className="map-code">{code}</span> : null}
            {cell.kind === "office" && cell.label ? <span className="map-code">{cell.label}</span> : null}
            {!design && vehicleCell && ref ? <span className="map-ref">{ref}</span> : null}
            {!design && (cell.kind === "rack" || cell.kind === "staging" || cell.kind === "sort_lane") && capacity > 0 ? (
              <span className="map-fill" style={{ height: `${Math.min(100, (occupied / capacity) * 100)}%` }} />
            ) : null}
            {!design && (cell.kind === "staging" || cell.kind === "sort_lane") && occupied > 0 ? (
              <span className="map-count">{occupied}</span>
            ) : null}
            {design && cell.kind === "rack" ? <span className="map-count">×{cell.levels ?? 3}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function MapLegend({ kinds }: { kinds?: CellKind[] }) {
  const list = kinds ?? (["gate", "dock_door", "yard_slot", "sort_lane", "staging", "rack"] as CellKind[]);
  return (
    <div className="map-legend">
      {list.map((k) => (
        <span key={k}>
          <i className={`legend-swatch k-${k}`} />
          {CELL_META[k].label}
        </span>
      ))}
      <span>
        <i className="legend-swatch is-busy-swatch" />
        Occupied
      </span>
    </div>
  );
}
