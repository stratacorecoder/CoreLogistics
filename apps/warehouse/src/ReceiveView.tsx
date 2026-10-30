import { HU_KINDS, humanize, type HandlingUnit, type HuKind, type Receipt } from "@corelogistics/contracts";
import { api, Empty, Field, fmtDateTime, Modal, Panel, Pill, Progress, qs, useAction, useApi, type Refs } from "@corelogistics/ui";
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
              return (
                <button key={r.id} className={`item${r.id === selectedId ? " is-selected" : ""}`} onClick={() => setSelectedId(r.id)}>
                  <div className="row-between">
                    <span className="item-title">{r.code}</span>
                    <span className="muted small">{r.huCount} HU</span>
                  </div>
                  <div className="item-meta">{r.supplier || "Unknown supplier"}</div>
                  <div className="item-meta">Opened {fmtDateTime(r.createdAt)}</div>
                  {expected ? (
                    <div style={{ marginTop: 6 }}>
                      <Progress value={received} max={expected} tone={received >= expected ? "ok" : undefined} />
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
      {selected ? <ReceiptPanel key={selected.id} receipt={selected} refs={refs} onSort={onSort} /> : <Panel title="Receipt"><Empty>Select a receipt</Empty></Panel>}
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
  const [dest, setDest] = useState("");
  const customers = (refs.sites ?? []).filter((s) => s.id !== receipt.siteId && s.kind !== "supplier");
  const pending = (hus.data ?? []).filter((h) => h.status === "received");
  const lineSkus = new Set(receipt.lines.map((l) => l.skuId));
  const otherSkus = (refs.skus ?? []).filter((s) => !lineSkus.has(s.id));

  useEffect(() => {
    const line = receipt.lines.find((l) => l.skuId === skuId);
    if (line && line.expectedQty > line.receivedQty) setQty(Math.min(line.expectedQty - line.receivedQty, 40));
  }, [skuId, receipt.lines]);

  return (
    <div className="stack" style={{ overflow: "auto" }}>
      <Panel
        title={`${receipt.code} · ${receipt.supplier || "Receipt"}`}
        actions={
          <button
            className="btn btn-ghost btn-sm"
            disabled={busy || pending.length > 0}
            title={pending.length ? "Sort every received unit first" : ""}
            onClick={() => run(() => api.post(`/warehouse/receipts/${receipt.id}/close`), `${receipt.code} closed`)}
          >
            Close receipt
          </button>
        }
      >
        <table className="table">
          <thead>
            <tr>
              <th>SKU</th>
              <th className="right">Expected</th>
              <th className="right">Received</th>
              <th style={{ width: "30%" }} />
            </tr>
          </thead>
          <tbody>
            {receipt.lines.map((l) => (
              <tr key={l.id} className={`is-clickable${l.skuId === skuId ? " is-selected" : ""}`} onClick={() => setSkuId(l.skuId)}>
                <td>
                  <div className="strong">{l.skuCode}</div>
                  <div className="muted small">{l.skuName}</div>
                </td>
                <td className="right">{l.expectedQty}</td>
                <td className={`right ${l.receivedQty > l.expectedQty && l.expectedQty ? "warn-text" : ""}`}>{l.receivedQty}</td>
                <td>
                  <Progress value={l.receivedQty} max={l.expectedQty || l.receivedQty} tone={l.receivedQty >= l.expectedQty ? "ok" : undefined} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Receive a unit">
        <div className="form">
          <div className="form-2">
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
              <input className="input" type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} />
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
            <Field label="Barcode" hint="Scan the label, or leave blank to print a new one">
              <input className="input scan-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
            </Field>
          </div>
          <Field label="Cross-dock to" hint="Set for freight that goes straight out without storage">
            <select className="select" value={dest} onChange={(e) => setDest(e.target.value)}>
              <option value="">Store in this warehouse</option>
              {customers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </select>
          </Field>
          <button
            className="btn btn-primary btn-lg"
            disabled={busy || !skuId}
            onClick={async () => {
              const hu = await run(
                () =>
                  api.post<HandlingUnit>(`/warehouse/receipts/${receipt.id}/receive`, {
                    skuId,
                    qty,
                    kind,
                    code: code || undefined,
                    destinationSiteId: dest || null,
                  }),
                (h) => `${h.code} received`,
              );
              if (hu) setCode("");
            }}
          >
            Receive
          </button>
        </div>
      </Panel>

      <Panel
        title={`Units on this receipt (${hus.data?.length ?? 0})`}
        actions={pending.length ? <button className="btn btn-primary btn-sm" onClick={onSort}>Sort {pending.length} waiting</button> : null}
      >
        {hus.data?.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Unit</th>
                <th>SKU</th>
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
                    {h.skuCode} <span className="muted small">zone {h.zone}</span>
                  </td>
                  <td className="right">{h.qty}</td>
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
          <Empty>Nothing received yet</Empty>
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
          <input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
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
