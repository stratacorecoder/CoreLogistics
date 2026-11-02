import { HU_KINDS, humanize, type HandlingUnit, type HuKind, type Receipt } from "@corelogistics/contracts";
import { api, Empty, Field, fmtDateTime, Modal, Panel, Pill, qs, useAction, useApi, type Refs } from "@corelogistics/ui";
import { useEffect, useState } from "react";

export function ReceiveView({ siteId, refs, onSort }: { siteId: string; refs: Refs; onSort: () => void }) {
  const receipts = useApi<Receipt[]>(`/warehouse/receipts${qs({ siteId, status: "open" })}`);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const selected = receipts.data?.find((r) => r.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId && receipts.data?.length) setSelectedId(receipts.data[0]!.id);
  }, [receipts.data, selectedId]);

  return (
    <div className="split" style={{ gridTemplateColumns: "320px minmax(0, 1fr)" }}>
      <Panel title="Open receipts" scroll actions={<button className="btn btn-ghost btn-sm" onClick={() => setCreating(true)}>New</button>}>
        {receipts.data?.length ? (
          <div className="list">
            {receipts.data.map((r) => {
              const expected = r.lines.reduce((n, l) => n + l.expectedQty, 0);
              const received = r.lines.reduce((n, l) => n + l.receivedQty, 0);
              const isComplete = expected > 0 && received >= expected;
              const pct = expected ? Math.min(100, Math.round((received / expected) * 100)) : 0;
              return (
                <button
                  key={r.id}
                  className={`wh-receipt-card${r.id === selectedId ? " is-selected" : ""}`}
                  onClick={() => setSelectedId(r.id)}
                >
                  <div className="wh-rc-top">
                    <span className="wh-rc-code">{r.code}</span>
                    <span className={`wh-rc-hu-badge${isComplete ? " is-complete" : ""}`}>
                      {r.huCount} HU
                    </span>
                  </div>
                  <div className="wh-rc-supplier">{r.supplier || "Walk-in delivery"}</div>
                  <div className="wh-rc-date">Opened {fmtDateTime(r.createdAt)}</div>
                  {expected ? (
                    <div className="wh-rc-progress-wrap">
                      <div className="wh-rc-progress-bar">
                        <div
                          className={`wh-rc-progress-fill ${isComplete ? "is-ok" : ""}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="wh-rc-progress-meta">
                        <span>{received} / {expected} units</span>
                        <span>{pct}%</span>
                      </div>
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : (
          <Empty>No open receipts. Docking an inbound truck opens one automatically.</Empty>
        )}
      </Panel>
      {selected ? (
        <ReceiptPanel key={selected.id} receipt={selected} refs={refs} onSort={onSort} />
      ) : (
        <Panel title="Receipt">
          <Empty>Select a receipt to view details and receive freight</Empty>
        </Panel>
      )}
      {creating ? (
        <NewReceipt
          siteId={siteId}
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            setSelectedId(r.id);
          }}
        />
      ) : null}
    </div>
  );
}

function ReceiptPanel({ receipt, refs, onSort }: { receipt: Receipt; refs: Refs; onSort: () => void }) {
  const hus = useApi<HandlingUnit[]>(`/warehouse/hus${qs({ receiptId: receipt.id })}`);
  const { busy, run } = useAction();
  const firstOpen = receipt.lines.find((l) => l.receivedQty < l.expectedQty) ?? receipt.lines[0];
  const [skuId, setSkuId] = useState(firstOpen?.skuId ?? refs.skus?.[0]?.id ?? "");
  const [qty, setQty] = useState(1);
  const [kind, setKind] = useState<HuKind>("pallet");
  const [code, setCode] = useState("");
  const [lotNumber, setLotNumber] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [dest, setDest] = useState("");
  const customers = (refs.sites ?? []).filter((s) => s.id !== receipt.siteId && s.kind !== "supplier");
  const pending = (hus.data ?? []).filter((h) => h.status === "received");
  const lineSkus = new Set(receipt.lines.map((l) => l.skuId));
  const otherSkus = (refs.skus ?? []).filter((s) => !lineSkus.has(s.id));

  const totalExpected = receipt.lines.reduce((n, l) => n + l.expectedQty, 0);
  const totalReceived = receipt.lines.reduce((n, l) => n + l.receivedQty, 0);
  const overallPct = totalExpected ? Math.min(100, Math.round((totalReceived / totalExpected) * 100)) : 0;
  const activeLine = receipt.lines.find((l) => l.skuId === skuId);

  useEffect(() => {
    const line = receipt.lines.find((l) => l.skuId === skuId);
    if (line && line.expectedQty > line.receivedQty) setQty(Math.min(line.expectedQty - line.receivedQty, 40));
  }, [skuId, receipt.lines]);

  return (
    <div className="wh-receive-scroll stack">
      <Panel
        title={`${receipt.code} · ${receipt.supplier || "Walk-in receipt"}`}
        actions={
          <div className="row" style={{ gap: 8 }}>
            {pending.length ? (
              <button className="btn btn-primary btn-sm" onClick={onSort}>
                Sort {pending.length} waiting
              </button>
            ) : null}
            <button
              className="btn btn-ghost btn-sm"
              disabled={busy || pending.length > 0}
              title={pending.length ? "Sort every received unit before closing" : ""}
              onClick={() => run(() => api.post(`/warehouse/receipts/${receipt.id}/close`), `${receipt.code} closed`)}
            >
              Close receipt
            </button>
          </div>
        }
      >
        <div className="wh-kpi-strip">
          <div className="wh-kpi-item">
            <span className="wh-kpi-label">Expected</span>
            <span className="wh-kpi-val">{totalExpected} <small style={{ fontSize: 11, fontWeight: 500, color: "var(--muted)" }}>units</small></span>
          </div>
          <div className="wh-kpi-item">
            <span className="wh-kpi-label">Received</span>
            <span className="wh-kpi-val" style={{ color: totalReceived >= totalExpected && totalExpected > 0 ? "var(--ok)" : "var(--text-heading)" }}>
              {totalReceived} <small style={{ fontSize: 11, fontWeight: 500, color: "var(--muted)" }}>units</small>
            </span>
          </div>
          <div className="wh-kpi-item">
            <span className="wh-kpi-label">Handled</span>
            <span className="wh-kpi-val">{hus.data?.length ?? 0} <small style={{ fontSize: 11, fontWeight: 500, color: "var(--muted)" }}>HUs</small></span>
          </div>
          <div className="wh-kpi-item">
            <span className="wh-kpi-label">Progress</span>
            <span className="wh-kpi-val">{overallPct}%</span>
          </div>
        </div>

        <table className="table wh-sku-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th className="right">Expected</th>
              <th className="right">Received</th>
              <th style={{ width: "35%" }}>Progress</th>
            </tr>
          </thead>
          <tbody>
            {receipt.lines.map((l) => {
              const linePct = l.expectedQty ? Math.min(100, Math.round((l.receivedQty / l.expectedQty) * 100)) : 0;
              const isSelected = l.skuId === skuId;
              const isDone = l.expectedQty > 0 && l.receivedQty >= l.expectedQty;
              return (
                <tr
                  key={l.id}
                  className={`is-clickable${isSelected ? " is-selected" : ""}`}
                  onClick={() => setSkuId(l.skuId)}
                >
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      <span className="mono strong">{l.skuCode}</span>
                      {isSelected ? <span className="pill tone-accent small">Selected</span> : null}
                    </div>
                    <div className="muted small">{l.skuName}</div>
                  </td>
                  <td className="right mono">{l.expectedQty}</td>
                  <td className={`right mono ${l.receivedQty > l.expectedQty && l.expectedQty ? "warn-text" : isDone ? "ok-text" : ""}`}>
                    {l.receivedQty}
                  </td>
                  <td>
                    <div className="wh-table-progress-cell">
                      <div className="wh-mini-bar">
                        <div
                          className={`wh-mini-bar-fill ${isDone ? "is-ok" : l.receivedQty > 0 ? "is-accent" : ""}`}
                          style={{ width: `${linePct}%` }}
                        />
                      </div>
                      <span className="wh-mini-bar-label mono">
                        {linePct}%
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      <Panel
        title="Receive a unit"
        actions={
          activeLine ? (
            <span className="muted small mono">
              Target: <strong style={{ color: "var(--text-heading)" }}>{activeLine.skuCode}</strong>
            </span>
          ) : null
        }
      >
        <div className="form">
          <div className="wh-form-grid-3">
            <Field label="SKU">
              <select className="select" value={skuId} onChange={(e) => setSkuId(e.target.value)}>
                <optgroup label="On this receipt">
                  {receipt.lines.map((l) => (
                    <option key={l.skuId} value={l.skuId}>
                      {l.skuCode} · {l.skuName}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Other SKUs">
                  {otherSkus.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} · {s.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </Field>
            <Field label="Quantity">
              <input className="input mono" type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} />
            </Field>
            <Field label="Unit type">
              <select className="select" value={kind} onChange={(e) => setKind(e.target.value as HuKind)}>
                {HU_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="wh-form-grid-3">
            <Field label="Barcode" hint="Scan existing label, or leave blank to auto-generate">
              <input
                className="input scan-input"
                placeholder="AUTO PRINT"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Lot / Batch #" hint="Optional manufacturer lot">
              <input
                className="input mono"
                placeholder="e.g. LOT-2026-A"
                value={lotNumber}
                onChange={(e) => setLotNumber(e.target.value)}
              />
            </Field>
            <Field label="Expiry date" hint="FEFO rotation date (YYYY-MM-DD)">
              <input
                className="input mono"
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
              />
            </Field>
          </div>

          <div className="wh-form-grid-bottom">
            <Field label="Cross-dock routing" hint="Route straight out without storage">
              <select className="select" value={dest} onChange={(e) => setDest(e.target.value)}>
                <option value="">Store in this warehouse</option>
                {customers.map((s) => (
                  <option key={s.id} value={s.id}>
                    Cross-dock to {s.code} · {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <button
              className="btn btn-primary btn-lg"
              style={{ minWidth: 160, height: 44 }}
              disabled={busy || !skuId}
              onClick={async () => {
                const hu = await run(
                  () =>
                    api.post<HandlingUnit>(`/warehouse/receipts/${receipt.id}/receive`, {
                      skuId,
                      qty,
                      kind,
                      code: code || undefined,
                      lotNumber: lotNumber || undefined,
                      expiryDate: expiryDate || undefined,
                      destinationSiteId: dest || null,
                    }),
                  (h) => `${h.code} received`,
                );
                if (hu) {
                  setCode("");
                  setLotNumber("");
                  setExpiryDate("");
                }
              }}
            >
              Receive Unit
            </button>
          </div>
        </div>
      </Panel>

      <Panel
        title={`Units on this receipt (${hus.data?.length ?? 0})`}
        actions={
          pending.length ? (
            <button className="btn btn-primary btn-sm" onClick={onSort}>
              Sort {pending.length} waiting
            </button>
          ) : null
        }
      >
        {hus.data?.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Unit</th>
                <th>SKU</th>
                <th>Lot / Expiry</th>
                <th className="right">Qty</th>
                <th>Status</th>
                <th>Where</th>
              </tr>
            </thead>
            <tbody>
              {hus.data.map((h) => (
                <tr key={h.id}>
                  <td className="mono strong">{h.code}</td>
                  <td>
                    <span className="mono">{h.skuCode}</span>{" "}
                    <span className="muted small">zone {h.zone}</span>
                  </td>
                  <td>
                    {h.lotNumber ? <span className="pill" style={{ marginRight: 4 }}>Lot: {h.lotNumber}</span> : null}
                    {h.expiryDate ? <span className="muted small">Exp: {h.expiryDate}</span> : (!h.lotNumber ? <span className="muted">—</span> : null)}
                  </td>
                  <td className="right mono">{h.qty}</td>
                  <td>
                    <Pill value={h.status} />
                    {h.destinationSiteId ? <Pill tone="violet">→ {refs.siteCode(h.destinationSiteId)}</Pill> : null}
                  </td>
                  <td className="mono">{h.locationCode ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Nothing received yet for this receipt.</Empty>
        )}
      </Panel>
    </div>
  );
}

function NewReceipt({ siteId, onClose, onCreated }: { siteId: string; onClose: () => void; onCreated: (r: Receipt) => void }) {
  const { busy, run } = useAction();
  const [supplier, setSupplier] = useState("");
  return (
    <Modal title="New receipt" onClose={onClose}>
      <div className="form">
        <Field label="Supplier / reference">
          <input className="input" placeholder="e.g. Cavite Manufacturing Co." value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        </Field>
        <p className="muted small">Receipts for trucks at a dock are created automatically. Use this for walk-in deliveries or returns.</p>
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            const r = await run(() => api.post<Receipt>("/warehouse/receipts", { siteId, supplier }), (x) => `${x.code} opened`);
            if (r) onCreated(r);
          }}
        >
          Open receipt
        </button>
      </div>
    </Modal>
  );
}
