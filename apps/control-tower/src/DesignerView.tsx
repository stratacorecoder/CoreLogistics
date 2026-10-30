import {
  CELL_KINDS,
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
import { api, Empty, ErrorNote, Field, MapLegend, Panel, SiteMap, useAction, useApi, type MapCell } from "@corelogistics/ui";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

type Tool = CellKind | "select";
const ZONED: CellKind[] = ["rack", "sort_lane", "staging", "dock_door", "yard_slot"];

export function DesignerView({ siteId }: { siteId: string }) {
  const remote = useApi<SiteLayout>(`/sites/${siteId}/layout`, { live: false });
  const [draft, setDraft] = useState<SiteLayout | null>(null);
  const [tool, setTool] = useState<Tool>("rack");
  const [zone, setZone] = useState<Zone | null>("A");
  const [levels, setLevels] = useState(3);
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

  if (!draft) return <div className="page"><ErrorNote error={remote.error} /></div>;

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
              for (const k of Object.keys(next) as (keyof LayoutCell)[]) if (next[k] === undefined || next[k] === "") delete next[k];
              return next;
            }),
          }
        : d,
    );

  const resize = (cols: number, rows: number) =>
    setDraft((d) => (d ? { cols, rows, cells: d.cells.filter((c) => c.x < cols && c.y < rows) } : d));

  return (
    <div className="split" style={{ gridTemplateColumns: "280px minmax(0, 1fr) 280px" }}>
      <Panel title="Palette" scroll>
        <div className="stack">
          <div className="palette">
            <button className={`palette-item${tool === "select" ? " is-on" : ""}`} onClick={() => setTool("select")}>
              <span className="palette-swatch" style={{ background: "#8d97a5" }} />
              Select
            </button>
            {CELL_KINDS.map((k) => (
              <button key={k} className={`palette-item${tool === k ? " is-on" : ""}`} onClick={() => setTool(k)} title={CELL_META[k].description}>
                <span className={`palette-swatch k-${k}`} />
                {CELL_META[k].label}
              </button>
            ))}
          </div>
          <Field label="Zone for racks, lanes, docks">
            <div className="row">
              <button className={`zone-chip${zone === null ? " is-on" : ""}`} onClick={() => setZone(null)}>None</button>
              {ZONES.map((z) => (
                <button key={z} className={`zone-chip${zone === z ? " is-on" : ""}`} style={{ color: ZONE_META[z].color }} onClick={() => setZone(z)} title={ZONE_META[z].description}>
                  {z} {ZONE_META[z].label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Rack levels (bins per rack)">
            <input className="input" type="number" min={1} max={8} value={levels} onChange={(e) => setLevels(Math.max(1, Math.min(8, Number(e.target.value))))} />
          </Field>
          <div className="form-2">
            <Field label="Columns">
              <input className="input" type="number" min={4} max={80} value={draft.cols} onChange={(e) => resize(Number(e.target.value), draft.rows)} />
            </Field>
            <Field label="Rows">
              <input className="input" type="number" min={4} max={60} value={draft.rows} onChange={(e) => resize(draft.cols, Number(e.target.value))} />
            </Field>
          </div>
          <p className="muted small">Click or drag on the grid to paint. Use Select to rename a cell or change its zone, levels or capacity.</p>
        </div>
      </Panel>

      <Panel
        title="Layout"
        actions={
          <>
            <MapLegend />
            <button className="btn btn-ghost btn-sm" disabled={!dirty || busy} onClick={() => base && setDraft(structuredClone(base))}>
              Discard
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={!dirty || busy || Boolean(problem)}
              onClick={async () => {
                const saved = await run(() => api.put<SiteLayout>(`/sites/${siteId}/layout`, draft), "Layout saved; locations updated");
                if (saved) remote.reload();
              }}
            >
              Save layout
            </button>
          </>
        }
      >
        <ErrorNote error={problem} />
        <div className="map-wrap" style={{ maxHeight: "calc(100vh - 150px)" }}>
          <SiteMap
            layout={draft}
            locations={preview}
            design
            cellSize={30}
            selectedKey={selected}
            onCellPointerDown={(c) => {
              painting.current = tool !== "select";
              paint(c);
            }}
            onCellPointerEnter={(c) => painting.current && paint(c)}
          />
        </div>
      </Panel>

      <div className="stack">
        <Panel title="Derived locations">
          <dl className="kv">
            {Object.entries(counts).map(([k, n]) => (
              <Fragment key={k}>
                <dt>{CELL_META[(k === "bin" ? "rack" : k) as CellKind]?.label ?? k}{k === "bin" ? " bins" : ""}</dt>
                <dd>{n}</dd>
              </Fragment>
            ))}
          </dl>
          <p className="muted small" style={{ marginTop: 8 }}>
            Saving re-derives addressable locations. A location that holds stock or a truck cannot be removed.
          </p>
        </Panel>
        <Panel title="Selected cell">
          {selectedCell ? (
            <div className="form">
              <p className="strong">
                {CELL_META[selectedCell.kind].label} at {selectedCell.x},{selectedCell.y}
              </p>
              <Field label="Label / code" hint="Printed on floor labels; clear it to auto-number">
                <input className="input" value={selectedCell.label ?? ""} maxLength={16} onChange={(e) => updateSelected({ label: e.target.value || undefined })} />
              </Field>
              {ZONED.includes(selectedCell.kind) ? (
                <Field label="Zone">
                  <select className="select" value={selectedCell.zone ?? ""} onChange={(e) => updateSelected({ zone: (e.target.value || undefined) as Zone | undefined })}>
                    <option value="">None</option>
                    {ZONES.map((z) => <option key={z} value={z}>{z} · {ZONE_META[z].label}</option>)}
                  </select>
                </Field>
              ) : null}
              {selectedCell.kind === "rack" ? (
                <Field label="Levels">
                  <input className="input" type="number" min={1} max={8} value={selectedCell.levels ?? 3} onChange={(e) => updateSelected({ levels: Number(e.target.value) })} />
                </Field>
              ) : null}
              {["rack", "staging", "sort_lane"].includes(selectedCell.kind) ? (
                <Field label={selectedCell.kind === "rack" ? "Capacity per bin (HU)" : "Capacity (HU)"}>
                  <input className="input" type="number" min={1} value={selectedCell.capacity ?? ""} placeholder="default" onChange={(e) => updateSelected({ capacity: e.target.value ? Number(e.target.value) : undefined })} />
                </Field>
              ) : null}
            </div>
          ) : (
            <Empty>Pick the Select tool and click a cell.</Empty>
          )}
        </Panel>
      </div>
    </div>
  );
}
