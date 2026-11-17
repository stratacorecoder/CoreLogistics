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
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

export interface MapCell {
  x: number;
  y: number;
  kind: CellKind;
  label?: string;
  zone?: LayoutCell["zone"];
  levels?: number;
  capacity?: number;
}

export type MapLens = "standard" | "heat" | "flow";

export interface MapFlowArc {
  from: { x: number; y: number };
  to: { x: number; y: number };
  tone: "yard" | "dock" | "warehouse";
}

export interface SiteMapProps {
  layout: SiteLayout;
  locations?: LocationStatus[];
  /** "x:y" of the selected cell */
  selectedKey?: string | null;
  /** Location ids to call out (e.g. suggested bin, assigned dock) */
  highlight?: Iterable<string>;
  design?: boolean;
  lens?: MapLens;
  isometric?: boolean;
  flowArcs?: MapFlowArc[];
  onCellClick?: (cell: MapCell, locations: LocationStatus[]) => void;
  onCellPointerDown?: (cell: MapCell) => void;
  onCellPointerEnter?: (cell: MapCell) => void;
  now?: number;
  cellSize?: number;
  /** Drawn cell width. Defaults to cellSize. */
  cellWidth?: number;
  /** Drawn cell height. Defaults to cellSize. */
  cellHeight?: number;
  showRulers?: boolean;
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
  lens = "standard",
  isometric = false,
  flowArcs,
  onCellClick,
  onCellPointerDown,
  onCellPointerEnter,
  now = Date.now(),
  cellSize = 32,
  cellWidth,
  cellHeight,
  showRulers = true,
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

  const computedArcs = useMemo<MapFlowArc[]>(() => {
    if (lens !== "flow") return [];
    if (flowArcs?.length) return flowArcs;
    const arcs: MapFlowArc[] = [];
    const byKind = (kind: CellKind, onlyOccupied = false) => {
      const out: MapCell[] = [];
      for (const c of layout.cells) {
        if (c.kind !== kind) continue;
        if (onlyOccupied) {
          const locs = locsByCell.get(`${c.x}:${c.y}`) ?? [];
          if (!locs.some((l) => l.occupied > 0)) continue;
        }
        out.push(c);
      }
      return out;
    };
    const nearest = (src: MapCell, targets: MapCell[]) => {
      let best: MapCell | null = null;
      let bestD = Infinity;
      for (const t of targets) {
        const d = Math.hypot(t.x - src.x, t.y - src.y);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      return best;
    };

    const gates = byKind("gate");
    const busyYard = byKind("yard_slot", true);
    const busyDocks = byKind("dock_door", true);
    const allDocks = byKind("dock_door");
    const busyStaging = byKind("staging", true);
    const busySort = byKind("sort_lane", true);
    const busyRacks = byKind("rack", true);

    for (const y of busyYard.slice(0, 6)) {
      const g = gates[0];
      if (g) arcs.push({ from: { x: g.x, y: g.y }, to: { x: y.x, y: y.y }, tone: "yard" });
      const d = nearest(y, busyDocks.length ? busyDocks : allDocks);
      if (d) arcs.push({ from: { x: y.x, y: y.y }, to: { x: d.x, y: d.y }, tone: "dock" });
    }
    for (const d of busyDocks.slice(0, 6)) {
      const mid = nearest(d, busyStaging.length ? busyStaging : busySort);
      if (mid) arcs.push({ from: { x: d.x, y: d.y }, to: { x: mid.x, y: mid.y }, tone: "dock" });
    }
    for (const m of [...busyStaging, ...busySort].slice(0, 6)) {
      const r = nearest(m, busyRacks);
      if (r) arcs.push({ from: { x: m.x, y: m.y }, to: { x: r.x, y: r.y }, tone: "warehouse" });
    }
    return arcs;
  }, [lens, flowArcs, layout.cells, locsByCell]);

  const heatClass = (cell: MapCell, occupied: number, capacity: number, since: string | null) => {
    if (lens !== "heat" || design) return "";
    if (cell.kind === "yard_slot" || cell.kind === "dock_door") {
      if (occupied === 0 || !since) return "heat-idle";
      const mins = minutesBetween(since, now);
      if (mins >= 90) return "heat-crit";
      if (mins >= 45) return "heat-high";
      if (mins >= 15) return "heat-med";
      return "heat-low";
    }
    if (cell.kind === "rack" || cell.kind === "staging" || cell.kind === "sort_lane") {
      if (capacity <= 0 || occupied === 0) return "heat-idle";
      const ratio = occupied / capacity;
      if (ratio >= 0.9) return "heat-crit";
      if (ratio >= 0.7) return "heat-high";
      if (ratio >= 0.35) return "heat-med";
      return "heat-low";
    }
    return "";
  };

  const renderCell = (cell: MapCell) => {
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
    const dwellMin = vehicleCell && occupied > 0 && since ? minutesBetween(since, now) : null;
    const heat = heatClass(cell, occupied, capacity, since);
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
      heat,
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
        style={{
          ...(zone ? { boxShadow: `inset 3px 0 0 ${ZONE_META[zone].color}` } : {}),
          gridColumn: showRulers ? cell.x + 2 : cell.x + 1,
          gridRow: showRulers ? cell.y + 2 : cell.y + 1,
        }}
        onClick={() => onCellClick?.(cell, locs)}
        onPointerDown={(e) => {
          if (!onCellPointerDown) return;
          e.preventDefault();
          onCellPointerDown(cell);
        }}
        onPointerEnter={() => onCellPointerEnter?.(cell)}
      >
        {vehicleCell && occupied > 0 && ref ? (
          <div className="map-occupied-vehicle">
            <span className="map-vehicle-prefix">{ref.split(" ")[0]}</span>
            <span className="map-vehicle-plate">
              {lens === "heat" && dwellMin !== null ? `${dwellMin}m` : ref.length > 7 ? ref.slice(0, 6) + "…" : ref}
            </span>
          </div>
        ) : (
          <>
            {SHOWS_CODE[cell.kind] && code ? <span className="map-code">{code}</span> : null}
            {cell.kind === "office" && cell.label ? <span className="map-code">{cell.label}</span> : null}
            {design && cell.kind === "rack" && !code ? <span className="map-count">×{cell.levels ?? 3}</span> : null}
          </>
        )}
        {!design && (cell.kind === "rack" || cell.kind === "staging" || cell.kind === "sort_lane") && capacity > 0 ? (
          <span className="map-fill" style={{ height: `${Math.min(100, (occupied / capacity) * 100)}%` }} />
        ) : null}
        {!design && lens === "heat" && (cell.kind === "rack" || cell.kind === "staging" || cell.kind === "sort_lane") && capacity > 0 ? (
          <span className="map-count">{Math.round((occupied / capacity) * 100)}%</span>
        ) : !design && (cell.kind === "staging" || cell.kind === "sort_lane") && occupied > 0 ? (
          <span className="map-count">{occupied}</span>
        ) : null}
      </button>
    );
  };

  const rulerColWidth = 26;
  const col = cellWidth ?? cellSize;
  const row = cellHeight ?? cellSize;
  const gap = 2;
  const gridWidth = layout.cols * col + Math.max(0, layout.cols - 1) * gap;
  const gridHeight = layout.rows * row + Math.max(0, layout.rows - 1) * gap;

  const frame = (
    <div
      className={`site-map-frame${design ? " is-design" : ""}${isometric ? " is-isometric" : ""}${lens !== "standard" ? ` lens-${lens}` : ""}`}
      style={{
        display: "grid",
        gridTemplateColumns: showRulers
          ? `${rulerColWidth}px repeat(${layout.cols}, ${col}px)`
          : `repeat(${layout.cols}, ${col}px)`,
        gridTemplateRows: showRulers
          ? `22px repeat(${layout.rows}, ${row}px) 22px`
          : `repeat(${layout.rows}, ${row}px)`,
        gap: `${gap}px`,
        width: "max-content",
        margin: "0 auto",
      }}
      onDragStart={(e) => e.preventDefault()}
    >
      {showRulers ? (
        <>
          <div key="corner-top" className="map-ruler-corner" style={{ gridColumn: 1, gridRow: 1 }} />
          {Array.from({ length: layout.cols }).map((_, x) => (
            <div key={`ruler-top-${x}`} className="map-ruler-col" style={{ gridColumn: x + 2, gridRow: 1 }}>
              {String(x + 1).padStart(2, "0")}
            </div>
          ))}
        </>
      ) : null}

      {Array.from({ length: layout.rows }).map((_, y) => {
        const rowCells = grid.slice(y * layout.cols, (y + 1) * layout.cols);
        return (
          <Fragment key={`row-wrap-${y}`}>
            {showRulers ? (
              <div key={`ruler-row-${y}`} className="map-ruler-row" style={{ gridColumn: 1, gridRow: y + 2 }}>
                {String.fromCharCode(65 + (y % 26))}
              </div>
            ) : null}
            {rowCells.map((cell) => {
              if (!design && cell.kind === "empty") {
                return (
                  <div
                    key={`${cell.x}:${cell.y}`}
                    className="map-cell k-empty"
                    style={{
                      gridColumn: showRulers ? cell.x + 2 : cell.x + 1,
                      gridRow: showRulers ? cell.y + 2 : cell.y + 1,
                    }}
                  />
                );
              }
              return renderCell(cell);
            })}
          </Fragment>
        );
      })}

      {lens === "flow" && computedArcs.length > 0 ? (
        <svg
          className="site-map-flow-svg"
          width={gridWidth}
          height={gridHeight}
          viewBox={`0 0 ${gridWidth} ${gridHeight}`}
          style={{
            gridColumn: showRulers ? `2 / ${layout.cols + 2}` : `1 / ${layout.cols + 1}`,
            gridRow: showRulers ? `2 / ${layout.rows + 2}` : `1 / ${layout.rows + 1}`,
            pointerEvents: "none",
            zIndex: 12,
          }}
        >
          {computedArcs.map((arc, i) => {
            const x1 = arc.from.x * (col + gap) + col / 2;
            const y1 = arc.from.y * (row + gap) + row / 2;
            const x2 = arc.to.x * (col + gap) + col / 2;
            const y2 = arc.to.y * (row + gap) + row / 2;
            const mx = (x1 + x2) / 2;
            const my = (y1 + y2) / 2 - Math.min(28, Math.hypot(x2 - x1, y2 - y1) * 0.2);
            const stroke =
              arc.tone === "yard" ? "#ff9500" : arc.tone === "dock" ? "#34c759" : "#38bdf8";
            return (
              <g key={`${arc.from.x}:${arc.from.y}-${arc.to.x}:${arc.to.y}-${i}`}>
                <path
                  d={`M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={2}
                  strokeOpacity={0.85}
                  className="flow-arc-path"
                />
                <circle cx={x2} cy={y2} r={3} fill={stroke} />
              </g>
            );
          })}
        </svg>
      ) : null}

      {showRulers ? (
        <>
          <div key="corner-bottom" className="map-ruler-corner" style={{ gridColumn: 1, gridRow: layout.rows + 2 }} />
          {Array.from({ length: layout.cols }).map((_, x) => (
            <div key={`ruler-bottom-${x}`} className="map-ruler-col" style={{ gridColumn: x + 2, gridRow: layout.rows + 2 }}>
              {String(x + 1).padStart(2, "0")}
            </div>
          ))}
        </>
      ) : null}
    </div>
  );

  return isometric ? <div className="site-map-iso-stage">{frame}</div> : frame;
}

export function MapLegend({ kinds }: { kinds?: CellKind[] }) {
  const list = kinds ?? (["gate", "dock_door", "yard_slot", "sort_lane", "staging", "rack"] as CellKind[]);
  return (
    <div className="map-legend">
      {list.map((k) => (
        <span key={k} className="legend-item">
          <i className={`legend-swatch k-${k}`} />
          {CELL_META[k].label}
        </span>
      ))}
      <span className="legend-item">
        <i className="legend-swatch is-busy-swatch" />
        Occupied
      </span>
    </div>
  );
}

/** Grow a live map to its panel. Cells stay square when the column is too narrow to read. */
export function useFitMapCells(cols: number, rows: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState({ w: 36, h: 36 });

  useEffect(() => {
    const el = ref.current;
    if (!el || cols < 1 || rows < 1) return;
    const fit = () => {
      const frame = el.querySelector<HTMLElement>(".site-map-frame");
      const frameStyle = frame ? getComputedStyle(frame) : null;
      const padX = frameStyle ? parseFloat(frameStyle.paddingLeft) + parseFloat(frameStyle.paddingRight) : 24;
      const padY = frameStyle ? parseFloat(frameStyle.paddingTop) + parseFloat(frameStyle.paddingBottom) : 20;
      const borderX = frameStyle ? parseFloat(frameStyle.borderLeftWidth) + parseFloat(frameStyle.borderRightWidth) : 2;
      const borderY = frameStyle ? parseFloat(frameStyle.borderTopWidth) + parseFloat(frameStyle.borderBottomWidth) : 2;
      const gap = 2;
      const availW = el.clientWidth - padX - borderX - 26 - gap * cols;
      const availH = el.clientHeight - padY - borderY - 44 - gap * (rows + 1);
      const rawW = Math.floor(availW / cols);
      const rawH = Math.floor(availH / rows);
      if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW < 8 || rawH < 8) return;
      const w = Math.min(rawW, 72);
      const h = Math.min(rawW >= 28 ? rawH : rawW, 88);
      setCell({ w, h });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [cols, rows]);

  return { ref, cell };
}
