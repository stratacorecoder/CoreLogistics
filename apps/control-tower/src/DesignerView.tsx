import {
  CELL_META,
  deriveLocations,
  freezeLabels,
  validateLayout,
  ZONE_META,
  ZONES,
  type CellKind,
  type LayoutCell,
  type LocationStatus,
  type SiteLayout,
  type Zone,
} from "@corelogistics/contracts";
import {
  api,
  ErrorNote,
  Field,
  MapLegend,
  Panel,
  SiteMap,
  useAction,
  useApi,
  type MapCell,
} from "@corelogistics/ui";
import { useEffect, useMemo, useRef, useState } from "react";

type Tool = CellKind | "select";
const ZONED: CellKind[] = ["rack", "sort_lane", "staging", "dock_door", "yard_slot"];

interface DesignerToolDef {
  id: Tool;
  label: string;
  color?: string;
  isOutline?: boolean;
  description?: string;
}

const DESIGNER_TOOLS: DesignerToolDef[] = [
  { id: "select", label: "Select", color: "#94a3b8" },
  { id: "empty", label: "Empty", isOutline: true },
  { id: "road", label: "Road", color: "var(--bg-subtle)" },
  { id: "gate", label: "Gate", color: "#2563eb" },
  { id: "dock_door", label: "Dock door", color: "#16a34a" },
  { id: "yard_slot", label: "Yard slot", isOutline: true },
  { id: "staging", label: "Staging", color: "#b45309" },
  { id: "sort_lane", label: "Sort lane", color: "#312e81" },
  { id: "rack", label: "Rack", color: "#7c3aed" },
  { id: "aisle", label: "Aisle", color: "var(--panel-3)" },
  { id: "wall", label: "Wall", color: "#1e293b" },
  { id: "office", label: "Office", color: "#312e81" },
];

export function DesignerView({ siteId }: { siteId: string }) {
  const remote = useApi<SiteLayout>(`/sites/${siteId}/layout`, { live: false });
  const [draft, setDraft] = useState<SiteLayout | null>(null);
  const [tool, setTool] = useState<Tool>("rack");
  const [zone, setZone] = useState<Zone | null>("A");
  const [levels, setLevels] = useState(3);
  const [defaultCapacity, setDefaultCapacity] = useState(10);
  const [cellSize, setCellSize] = useState(32);
  const [selected, setSelected] = useState<string | null>(null);
  const painting = useRef(false);
  const { busy, run } = useAction();

  const base = useMemo(() => (remote.data ? freezeLabels(remote.data) : null), [remote.data]);
  useEffect(() => {
    if (base) setDraft(structuredClone(base));
  }, [base]);

  useEffect(() => {
    const up = () => (painting.current = false);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  const problem = useMemo(() => (draft ? validateLayout(draft) : null), [draft]);
  const derived = useMemo(() => (draft ? deriveLocations(draft) : []), [draft]);
  const preview = useMemo<LocationStatus[]>(
    () =>
      derived.map((l) => ({
        ...l,
        id: `${l.x}:${l.y}:${l.level}`,
        siteId,
        active: true,
        occupied: 0,
        refs: [],
        since: null,
      })),
    [derived, siteId],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const l of derived) c[l.kind] = (c[l.kind] ?? 0) + 1;
    return c;
  }, [derived]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);

  if (!draft)
    return (
      <div className="page">
        <ErrorNote error={remote.error} />
      </div>
    );

  const paint = (cell: MapCell) => {
    if (tool === "select") {
      setSelected(`${cell.x}:${cell.y}`);
      return;
    }
    setDraft((d) => {
      if (!d) return d;
      const prev = d.cells.find((c) => c.x === cell.x && c.y === cell.y);
      const cells = d.cells.filter((c) => c !== prev);
      if (tool !== "empty") {
        const next: LayoutCell = { x: cell.x, y: cell.y, kind: tool };
        if (prev?.kind === tool && prev.label) next.label = prev.label;
        if (zone && ZONED.includes(tool)) next.zone = zone;
        if (tool === "rack") next.levels = levels;
        if (["rack", "staging", "sort_lane"].includes(tool) && defaultCapacity) {
          next.capacity = defaultCapacity;
        }
        cells.push(next);
      }
      return { ...d, cells };
    });
  };

  const selectedCell = selected ? draft.cells.find((c) => `${c.x}:${c.y}` === selected) : undefined;
  const updateSelected = (patch: Partial<LayoutCell>) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            cells: d.cells.map((c) => {
              if (`${c.x}:${c.y}` !== selected) return c;
              const next = { ...c, ...patch };
              for (const k of Object.keys(next) as (keyof LayoutCell)[])
                if (next[k] === undefined || next[k] === "") delete next[k];
              return next;
            }),
          }
        : d,
    );

  const resize = (cols: number, rows: number) =>
    setDraft((d) =>
      d ? { cols, rows, cells: d.cells.filter((c) => c.x < cols && c.y < rows) } : d,
    );

  const clearGrid = () => {
    if (confirm("Are you sure you want to clear all cells in the layout?")) {
      setDraft((d) => (d ? { ...d, cells: [] } : d));
      setSelected(null);
    }
  };

  const toggleZoom = () => {
    setCellSize((size) => (size === 32 ? 38 : size === 38 ? 44 : 32));
  };

  return (
    <div className="split" style={{ gridTemplateColumns: "250px minmax(0, 1fr) 250px" }}>
      <Panel title="Palette" scroll>
        <div className="designer-sidebar-section">
          <div className="designer-section-title">Brush & Placement Tools</div>
          <div className="designer-tools-grid">
            {DESIGNER_TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`designer-tool-btn${tool === t.id ? " is-active" : ""}`}
                onClick={() => setTool(t.id)}
                title={t.description}
              >
                <span
                  className={`designer-tool-swatch${t.isOutline ? " is-outline" : ""}`}
                  style={t.color ? { backgroundColor: t.color } : undefined}
                />
                <span className="designer-tool-label">{t.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="designer-sidebar-section" style={{ marginTop: 20 }}>
          <div className="designer-section-title">Grid Configurations</div>

          <Field label="Edit cell properties">
            <input
              className="input"
              type="number"
              min={1}
              max={100}
              value={defaultCapacity}
              onChange={(e) => setDefaultCapacity(Number(e.target.value))}
            />
          </Field>

          <Field label="Rack levels (bins per rack)">
            <input
              className="input"
              type="number"
              min={1}
              max={8}
              value={levels}
              onChange={(e) => setLevels(Math.max(1, Math.min(8, Number(e.target.value))))}
            />
          </Field>

          <Field label="Zone">
            <div className="designer-zone-pills">
              {ZONES.map((z) => (
                <button
                  key={z}
                  type="button"
                  className={`designer-zone-pill z-${z.toLowerCase()}${zone === z ? " is-active" : ""}`}
                  onClick={() => setZone(zone === z ? null : z)}
                >
                  {z} {ZONE_META[z].label}
                </button>
              ))}
            </div>
          </Field>

          <div className="form-2" style={{ marginTop: 8 }}>
            <Field label="Columns">
              <input
                className="input"
                type="number"
                min={4}
                max={60}
                value={draft.cols}
                onChange={(e) => resize(Number(e.target.value), draft.rows)}
              />
            </Field>
            <Field label="Rows">
              <input
                className="input"
                type="number"
                min={4}
                max={40}
                value={draft.rows}
                onChange={(e) => resize(draft.cols, Number(e.target.value))}
              />
            </Field>
          </div>

          <p className="muted small" style={{ marginTop: 14, lineHeight: 1.45 }}>
            Click or drag on the grid to paint. Use Select to rename a cell or change its zone, levels or capacity.
          </p>
        </div>
      </Panel>

      <Panel
        title="Layout"
        actions={
          <div className="row" style={{ gap: 10 }}>
            <MapLegend />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!dirty || busy}
              onClick={() => base && setDraft(structuredClone(base))}
            >
              Discard
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!dirty || busy || Boolean(problem)}
              onClick={async () => {
                const saved = await run(
                  () => api.put<SiteLayout>(`/sites/${siteId}/layout`, draft),
                  "Layout saved; locations updated",
                );
                if (saved) remote.reload();
              }}
            >
              Save Layout
            </button>
          </div>
        }
      >
        <ErrorNote error={problem} />
        <div className="map-wrap" style={{ maxHeight: "calc(100vh - 175px)" }}>
          <SiteMap
            layout={draft}
            locations={preview}
            design
            cellSize={cellSize}
            selectedKey={selected}
            onCellPointerDown={(c) => {
              painting.current = tool !== "select";
              paint(c);
            }}
            onCellPointerEnter={(c) => painting.current && paint(c)}
          />
        </div>

        <div className="designer-bottom-actions">
          <button
            type="button"
            className="btn btn-outline btn-sm designer-pill-btn"
            onClick={toggleZoom}
          >
            Zoom In/Out
          </button>
          <button
            type="button"
            className="btn btn-outline btn-sm designer-pill-btn"
            onClick={clearGrid}
          >
            Clear Grid
          </button>
        </div>
      </Panel>

      <div className="stack">
        <Panel title="Derived locations">
          <div className="derived-locations-list">
            {Object.entries(counts).map(([k, n]) => (
              <div key={k} className="derived-location-row">
                <span className="derived-location-label">
                  {CELL_META[(k === "bin" ? "rack" : k) as CellKind]?.label ?? k}
                  {k === "bin" ? " bins" : ""}
                </span>
                <span className="derived-location-count">{n}</span>
              </div>
            ))}
          </div>
          <p className="muted small" style={{ marginTop: 12, lineHeight: 1.45 }}>
            Saving so derives addressable locations. A location that holds stock or a truck cannot be removed.
          </p>
        </Panel>

        <Panel title="Selected Cell Properties">
          {selectedCell ? (
            <div className="form">
              <Field label="Location name">
                <input
                  className="input"
                  value={selectedCell.label ?? ""}
                  placeholder="Location name"
                  maxLength={16}
                  onChange={(e) => updateSelected({ label: e.target.value || undefined })}
                />
              </Field>
              {ZONED.includes(selectedCell.kind) ? (
                <Field label="Zone">
                  <select
                    className="select"
                    value={selectedCell.zone ?? ""}
                    onChange={(e) =>
                      updateSelected({ zone: (e.target.value || undefined) as Zone | undefined })
                    }
                  >
                    <option value="">None</option>
                    {ZONES.map((z) => (
                      <option key={z} value={z}>
                        {z} {ZONE_META[z].label}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {["rack", "staging", "sort_lane"].includes(selectedCell.kind) ? (
                <Field label="Capacity">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={selectedCell.capacity ?? ""}
                    placeholder="10"
                    onChange={(e) =>
                      updateSelected({
                        capacity: e.target.value ? Number(e.target.value) : undefined,
                      })
                    }
                  />
                </Field>
              ) : null}
              {selectedCell.kind === "rack" ? (
                <Field label="Rack levels (bins per rack)">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={8}
                    value={selectedCell.levels ?? 3}
                    onChange={(e) => updateSelected({ levels: Number(e.target.value) })}
                  />
                </Field>
              ) : null}
            </div>
          ) : (
            <div className="form is-disabled">
              <p className="muted small" style={{ marginBottom: 12 }}>
                Only edit a cell and active when a cell is selected.
              </p>
              <Field label="Location name">
                <input className="input" placeholder="Location name" disabled />
              </Field>
              <Field label="Zone">
                <select className="select" disabled>
                  <option>A Ambient</option>
                </select>
              </Field>
              <Field label="Capacity">
                <input className="input" type="number" placeholder="10" disabled />
              </Field>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
