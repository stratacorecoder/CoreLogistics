import type { Location, Order, PickTask, ReleaseResult } from "@corelogistics/contracts";
import {
  api,
  Empty,
  Field,
  fmtDateTime,
  fromLocalInput,
  fromNow,
  Modal,
  Panel,
  Pill,
  Progress,
  qs,
  toLocalInput,
  useAction,
  useApi,
  type Refs,
} from "@corelogistics/ui";
import { useEffect, useState } from "react";

export function PickView({ siteId, refs }: { siteId: string; refs: Refs }) {
  const orders = useApi<Order[]>(`/outbound/orders${qs({ siteId, status: "open,picking,picked,staged" })}`);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const order = orders.data?.find((o) => o.id === selectedId) ?? null;

  useEffect(() => {
    if (!order && orders.data?.length) setSelectedId((orders.data.find((o) => o.status !== "staged") ?? orders.data[0]!).id);
  }, [orders.data, order]);

  return (
    <div className="split" style={{ gridTemplateColumns: "340px minmax(0, 1fr)" }}>
      <Panel title="Orders" scroll actions={<button className="btn btn-ghost btn-sm" onClick={() => setCreating(true)}>New order</button>}>
        {orders.data?.length ? (
          <div className="list">
            {orders.data.map((o) => {
              const total = o.lines.reduce((n, l) => n + l.qty, 0);
              const picked = o.lines.reduce((n, l) => n + l.pickedQty, 0);
              const late = Date.parse(o.dueAt) < Date.now() && o.status !== "staged";
              return (
                <button key={o.id} className={`item${o.id === selectedId ? " is-selected" : ""}${late ? " is-alert" : ""}`} onClick={() => setSelectedId(o.id)}>
                  <div className="row-between">
                    <span className="item-title">{o.code}</span>
                    <Pill value={o.status} />
                  </div>
                  <div className="item-meta">
                    {refs.siteName(o.customerSiteId)} · due {fromNow(o.dueAt)}
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <Progress value={picked} max={total} tone={picked >= total ? "ok" : undefined} />
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <Empty>No orders to work</Empty>
        )}
      </Panel>
      {order ? <OrderPanel key={order.id} order={order} refs={refs} /> : <Panel title="Order"><Empty>Select an order</Empty></Panel>}
      {creating ? (
        <NewOrder
          siteId={siteId}
          refs={refs}
          onClose={() => setCreating(false)}
          onCreated={(o) => {
            setCreating(false);
            setSelectedId(o.id);
          }}
        />
      ) : null}
    </div>
  );
}

function OrderPanel({ order, refs }: { order: Order; refs: Refs }) {
  const picks = useApi<PickTask[]>(`/outbound/picks${qs({ orderId: order.id })}`);
  const staging = useApi<Location[]>(`/sites/${order.siteId}/locations${qs({ kind: "staging" })}`, { live: false });
  const { busy, run } = useAction();
  const [shortages, setShortages] = useState<ReleaseResult["shortages"]>([]);
  const [stageAt, setStageAt] = useState("");
  const open = (picks.data ?? []).filter((p) => p.status === "open");
  const done = (picks.data ?? []).filter((p) => p.status === "done");

  return (
    <div className="stack" style={{ overflow: "auto" }}>
      <Panel title={`${order.code} → ${refs.siteName(order.customerSiteId)}`} actions={<Pill value={order.status} />}>
        <div className="stack">
          <p className="muted small">Due {fmtDateTime(order.dueAt)}</p>
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th>
                <th className="right">Ordered</th>
                <th className="right">Picked</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <span className="strong">{l.skuCode}</span> <span className="muted small">{l.skuName}</span>
                  </td>
                  <td className="right">{l.qty}</td>
                  <td className={`right ${l.pickedQty >= l.qty ? "" : "warn-text"}`}>{l.pickedQty}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shortages.length ? (
            <div className="callout tone-warn">
              Short on stock: {shortages.map((s) => `${s.skuCode} (${s.missing} missing)`).join(", ")}. Picks were created for what is available.
            </div>
          ) : null}
          {order.status === "open" ? (
            <button
              className="btn btn-primary btn-lg"
              disabled={busy}
              onClick={async () => {
                const r = await run(() => api.post<ReleaseResult>(`/outbound/orders/${order.id}/release`), (x) => `${x.tasks.length} pick tasks created`);
                if (r) setShortages(r.shortages);
              }}
            >
              Release to floor (allocate FEFO / FIFO)
            </button>
          ) : null}
          {order.status === "picked" ? (
            <div className="row">
              <select className="select grow" value={stageAt} onChange={(e) => setStageAt(e.target.value)}>
                <option value="">First free staging lane</option>
                {(staging.data ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-primary btn-lg"
                disabled={busy}
                onClick={() => run(() => api.post<Order>(`/outbound/orders/${order.id}/stage`, { locationId: stageAt || undefined }), `${order.code} staged`)}
              >
                Stage {order.huCount} units
              </button>
            </div>
          ) : null}
          {order.status === "staged" ? <p className="small">Staged and waiting for a shipment. Build one on the Load tab.</p> : null}
        </div>
      </Panel>

      {open.length ? (
        <Panel title={`Pick list (${open.length})`}>
          <div className="list">
            {open.map((p) => (
              <div key={p.id} className="item">
                <div className="row-between">
                  <div>
                    <span className="mono strong" style={{ fontSize: 22 }}>{p.fromLocationCode}</span>
                    <div className="item-meta">
                      Take <strong>{p.qty}</strong> × {p.skuCode} {p.skuName} from <span className="mono">{p.fromHuCode}</span>
                    </div>
                    {(p.lotNumber || p.expiryDate) ? (
                      <div className="row gap-sm" style={{ marginTop: 4 }}>
                        {p.lotNumber ? <span className="pill">Lot: {p.lotNumber}</span> : null}
                        {p.expiryDate ? <span className="pill tone-warn">Exp: {p.expiryDate}</span> : null}
                      </div>
                    ) : null}
                  </div>
                  <button
                    className="btn btn-primary btn-lg"
                    disabled={busy}
                    onClick={() => run(() => api.post(`/outbound/picks/${p.id}/confirm`), `Picked ${p.qty} × ${p.skuCode}`)}
                  >
                    Picked
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      {done.length ? (
        <Panel title={`Done (${done.length})`}>
          <table className="table">
            <tbody>
              {done.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.fromLocationCode}</td>
                  <td>
                    {p.qty} × {p.skuCode}
                  </td>
                  <td className="muted small">
                    {p.actor ?? ""} {fromNow(p.completedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}
    </div>
  );
}

function NewOrder({ siteId, refs, onClose, onCreated }: { siteId: string; refs: Refs; onClose: () => void; onCreated: (o: Order) => void }) {
  const { busy, run } = useAction();
  const customers = (refs.sites ?? []).filter((s) => s.kind === "customer");
  const [customer, setCustomer] = useState(customers[0]?.id ?? "");
  const [due, setDue] = useState(toLocalInput(Date.now() + 6 * 3600_000));
  const [lines, setLines] = useState<Array<{ skuId: string; qty: number }>>([{ skuId: refs.skus?.[0]?.id ?? "", qty: 1 }]);

  return (
    <Modal title="New order" onClose={onClose}>
      <div className="form">
        <div className="form-2">
          <Field label="Customer">
            <select className="select" value={customer} onChange={(e) => setCustomer(e.target.value)}>
              {customers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due">
            <input className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="row">
            <select className="select grow" value={l.skuId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, skuId: e.target.value } : x)))}>
              {(refs.skus ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </select>
            <input
              className="input"
              style={{ width: 90 }}
              type="number"
              min={1}
              value={l.qty}
              onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: Math.max(1, Number(e.target.value)) } : x)))}
            />
            <button className="btn btn-ghost btn-sm" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <button className="btn btn-ghost btn-sm" onClick={() => setLines([...lines, { skuId: refs.skus?.[0]?.id ?? "", qty: 1 }])}>
          Add line
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || !customer || lines.some((l) => !l.skuId)}
          onClick={async () => {
            const o = await run(
              () => api.post<Order>("/outbound/orders", { siteId, customerSiteId: customer, dueAt: fromLocalInput(due), lines }),
              (x) => `${x.code} created`,
            );
            if (o) onCreated(o);
          }}
        >
          Create order
        </button>
      </div>
    </Modal>
  );
}
