import { ZONE_META, type HandlingUnit, type InventoryRow, type SiteBoard } from "@corelogistics/contracts";
import { api, Empty, MapLegend, Panel, Pill, qs, SiteMap, useApi } from "@corelogistics/ui";
import { useMemo, useState } from "react";

export function StockView({ siteId }: { siteId: string }) {
  const inventory = useApi<InventoryRow[]>(`/warehouse/inventory${qs({ siteId })}`);
  const board = useApi<SiteBoard>(`/sites/${siteId}/board`);
  const [filter, setFilter] = useState("");
  const [scan, setScan] = useState("");
  const [found, setFound] = useState<HandlingUnit | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const totals = useMemo(() => {
    const m = new Map<string, { skuCode: string; skuName: string; zone: InventoryRow["zone"]; qty: number; bins: number }>();
    for (const r of inventory.data ?? []) {
      const t = m.get(r.skuId) ?? { skuCode: r.skuCode, skuName: r.skuName, zone: r.zone, qty: 0, bins: 0 };
      t.qty += r.qty;
      t.bins += 1;
      m.set(r.skuId, t);
    }
    return [...m.values()].sort((a, b) => a.skuCode.localeCompare(b.skuCode));
  }, [inventory.data]);

  const f = filter.toLowerCase();
  const rows = (inventory.data ?? []).filter((r) => !f || `${r.skuCode} ${r.skuName} ${r.locationCode}`.toLowerCase().includes(f));
  const highlight = useMemo(() => (f ? rows.map((r) => r.locationId) : found?.locationId ? [found.locationId] : []), [f, rows, found]);

  return (
    <div className="three" style={{ gridTemplateColumns: "360px minmax(0, 1fr) 380px" }}>
      <div className="stack">
        <Panel title="Find a unit">
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                setFound(await api.get<HandlingUnit>(`/warehouse/scan/${encodeURIComponent(scan)}`));
                setScanError(null);
              } catch (err) {
                setFound(null);
                setScanError((err as Error).message);
              }
            }}
          >
            <input className="input scan-input" placeholder="HU-…" value={scan} onChange={(e) => setScan(e.target.value.toUpperCase())} />
          </form>
          {scanError ? <p className="error-note">{scanError}</p> : null}
          {found ? (
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>Unit</dt>
              <dd className="mono">{found.code}</dd>
              <dt>Contents</dt>
              <dd>
                {found.qty} × {found.skuCode} {found.skuName}
              </dd>
              <dt>Status</dt>
              <dd>
                <Pill value={found.status} />
              </dd>
              <dt>Location</dt>
              <dd className="mono">{found.locationCode ?? "—"}</dd>
            </dl>
          ) : null}
        </Panel>
        <Panel title="Stock by SKU" scroll className="grow">
          <table className="table">
            <tbody>
              {totals.map((t) => (
                <tr key={t.skuCode} className="is-clickable" onClick={() => setFilter(t.skuCode)}>
                  <td>
                    {t.zone ? <span className="zone-dot" style={{ background: ZONE_META[t.zone].color }} /> : null}
                    <span className="strong">{t.skuCode}</span>
                    <div className="muted small">{t.skuName}</div>
                  </td>
                  <td className="right strong">{t.qty}</td>
                  <td className="right muted small">{t.bins} {t.bins === 1 ? "bin" : "bins"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title="Occupancy" actions={<MapLegend kinds={["sort_lane", "staging", "rack"]} />}>
        {board.data ? (
          <div className="map-wrap" style={{ maxHeight: "calc(100vh - 150px)" }}>
            <SiteMap
              layout={board.data.layout}
              locations={board.data.locations}
              highlight={highlight}
              cellSize={30}
              onCellClick={(_, locs) => {
                const code = locs[0]?.code.replace(/-\d+$/, "");
                if (code) setFilter(code);
              }}
            />
          </div>
        ) : null}
      </Panel>

      <Panel
        title="Bin contents"
        scroll
        actions={
          <input className="input" style={{ width: 170, minHeight: 34 }} placeholder="Filter SKU or bin" value={filter} onChange={(e) => setFilter(e.target.value)} />
        }
      >
        {rows.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Bin</th>
                <th>SKU</th>
                <th className="right">Qty</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.locationId}-${r.skuId}`}>
                  <td className="mono strong">{r.locationCode}</td>
                  <td>
                    {r.skuCode} <span className="muted small">{r.skuName}</span>
                  </td>
                  <td className="right">{r.qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No stock matches</Empty>
        )}
      </Panel>
    </div>
  );
}
