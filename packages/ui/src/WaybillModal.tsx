import { humanize, type Waybill } from "@corelogistics/contracts";
import { Printer } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Empty, ErrorNote, Modal, Pill } from "./components.js";
import { fmtDateTime } from "./format.js";
import { useApi } from "./live.js";

export function BarcodeSvg({ code }: { code: string }) {
  const bars = useMemo(() => {
    const out: Array<{ x: number; w: number }> = [];
    let x = 4;
    for (let i = 0; i < code.length; i++) {
      const ch = code.charCodeAt(i);
      for (let b = 0; b < 4; b++) {
        const w = ((ch >> b) & 1) === 1 ? 3 : 1.5;
        out.push({ x, w });
        x += w + (((ch >> (b + 2)) & 1) === 1 ? 2.5 : 1.5);
      }
    }
    return { items: out, width: Math.max(120, x + 4) };
  }, [code]);

  return (
    <svg width={bars.width} height={38} viewBox={`0 0 ${bars.width} 38`} aria-label={`Barcode ${code}`}>
      <rect width={bars.width} height={38} fill="#ffffff" rx={4} />
      {bars.items.map((bar, idx) => (
        <rect key={idx} x={bar.x} y={4} width={bar.w} height={24} fill="#0f172a" />
      ))}
      <text
        x={bars.width / 2}
        y={35}
        textAnchor="middle"
        fontSize={8.5}
        fontFamily="JetBrains Mono, ui-monospace, monospace"
        fontWeight={700}
        fill="#0f172a"
      >
        {code}
      </text>
    </svg>
  );
}

export function WaybillModal({ tripId, onClose }: { tripId: string; onClose: () => void }) {
  const { data, error, loading } = useApi<Waybill>(`/trips/${tripId}/waybill`, { live: false });

  useEffect(() => {
    document.body.classList.add("printing-waybill-modal");
    return () => document.body.classList.remove("printing-waybill-modal");
  }, []);

  return (
    <Modal title={data ? `Waybill · ${data.trip.code}` : "Dispatch Waybill & e-POD"} onClose={onClose}>
      <ErrorNote error={error} />
      {loading && !data ? <Empty>Loading waybill…</Empty> : null}
      {data ? (
        <div className="stack" style={{ gap: 12 }}>
          <div className="row-between waybill-no-print">
            <span className="muted small">Generated {fmtDateTime(data.generatedAt)}</span>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => window.print()}>
              <Printer size={14} /> Print / Save PDF
            </button>
          </div>

          <div id="waybill-print-sheet" className="waybill-sheet">
            <header className="waybill-header">
              <div>
                <div className="waybill-brand">CORELOGISTICS DISPATCH WAYBILL</div>
                <div className="waybill-code mono">{data.trip.code}</div>
                <div className="row" style={{ marginTop: 4, gap: 6 }}>
                  <Pill value={data.trip.status} />
                  <Pill tone="muted">{humanize(data.trip.kind)}</Pill>
                </div>
              </div>
              <BarcodeSvg code={data.trip.code} />
            </header>

            <section className="waybill-grid">
              <div className="waybill-box">
                <div className="waybill-box-title">Shipper / Origin</div>
                <div className="strong">
                  {data.origin.code} · {data.origin.name}
                </div>
                <div className="small muted">{data.origin.address || "Address on file"}</div>
                <div className="mono small muted">
                  Dep: {fmtDateTime(data.trip.actualDeparture ?? data.trip.plannedDeparture)}
                </div>
              </div>

              <div className="waybill-box">
                <div className="waybill-box-title">Consignee / Destination</div>
                <div className="strong">
                  {data.destination.code} · {data.destination.name}
                </div>
                <div className="small muted">{data.destination.address || "Address on file"}</div>
                <div className="mono small muted">
                  Arr: {fmtDateTime(data.trip.actualArrival ?? data.trip.plannedArrival)}
                </div>
              </div>
            </section>

            <section className="waybill-box">
              <div className="waybill-box-title">Carrier & Asset Assignment</div>
              <div className="waybill-kv-row">
                <span>
                  Vehicle: <strong className="mono">{data.vehiclePlate ?? "Unassigned"}</strong>
                  {data.trailerCode ? ` (+ ${data.trailerCode})` : ""}
                </span>
                <span>
                  Driver: <strong>{data.driverName ?? "Unassigned"}</strong>
                  {data.driverPhone ? ` · ${data.driverPhone}` : ""}
                </span>
                <span>
                  Total Cargo: <strong>{data.totalUnits} units</strong> ({data.totalWeightKg.toLocaleString()} kg)
                </span>
              </div>
            </section>

            <section className="waybill-box">
              <div className="waybill-box-title">
                Cargo Manifest {data.shipments.length ? `(${data.shipments.map((s) => s.code).join(", ")})` : ""}
              </div>
              {data.lines.length ? (
                <table className="table waybill-table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>SKU</th>
                      <th className="right">Ordered</th>
                      <th className="right">Picked</th>
                      <th className="right">Weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((l, i) => (
                      <tr key={`${l.orderCode}-${l.skuCode}-${i}`}>
                        <td className="mono">{l.orderCode}</td>
                        <td>
                          <strong>{l.skuCode}</strong> <span className="muted small">{l.skuName}</span>
                        </td>
                        <td className="right">{l.qty}</td>
                        <td className="right">{l.pickedQty}</td>
                        <td className="right">{Math.round(l.qty * l.unitWeightKg)} kg</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="small muted" style={{ margin: 0 }}>
                  No outbound order lines linked to this trip{data.trip.notes ? ` — Notes: ${data.trip.notes}` : "."}
                </p>
              )}

              {data.handlingUnits.length ? (
                <div style={{ marginTop: 10 }}>
                  <div className="waybill-box-title">Handling Units & FEFO Lots</div>
                  <table className="table waybill-table">
                    <thead>
                      <tr>
                        <th>HU Code</th>
                        <th>SKU</th>
                        <th>Lot #</th>
                        <th>Expiry</th>
                        <th className="right">Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.handlingUnits.map((h) => (
                        <tr key={h.code}>
                          <td className="mono">{h.code}</td>
                          <td>{h.skuCode}</td>
                          <td className="mono">{h.lotNumber ?? "—"}</td>
                          <td className="mono">{h.expiryDate ? h.expiryDate.slice(0, 10) : "—"}</td>
                          <td className="right">{h.qty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>

            <section className="waybill-box">
              <div className="waybill-box-title">Electronic Proof of Delivery (e-POD)</div>
              <div className="waybill-grid">
                <div>
                  <div className="small">
                    Recipient: <strong>{data.trip.podRecipient || "Pending signature"}</strong>
                  </div>
                  <div className="small muted">
                    Signed at: {data.trip.podAt ? fmtDateTime(data.trip.podAt) : "—"}
                  </div>
                  {data.trip.podNotes ? <div className="small" style={{ marginTop: 4 }}>{data.trip.podNotes}</div> : null}
                </div>
                <div>
                  {data.trip.podSignature ? (
                    <img
                      src={data.trip.podSignature}
                      alt="Recipient signature"
                      style={{ maxHeight: 62, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 6, padding: 4 }}
                    />
                  ) : (
                    <div className="waybill-sig-line">Receiver signature</div>
                  )}
                </div>
              </div>
              {data.proofPhotos.length ? (
                <div className="row" style={{ flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                  {data.proofPhotos.map((p, idx) => (
                    <img
                      key={idx}
                      src={p.dataUrl}
                      alt={p.label}
                      style={{ width: 110, height: 74, objectFit: "cover", borderRadius: 6, border: "1px solid #cbd5e1" }}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
