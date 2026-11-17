import {
  formatDuration,
  humanize,
  type GateVisit,
  type Site,
} from "@corelogistics/contracts";
import { BarcodeSvg, fmtDateTime, Modal, Pill } from "@corelogistics/ui";
import { FileText, Printer, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect } from "react";

export function GatePassModal({
  visit,
  site,
  onClose,
  onOpenWaybill,
}: {
  visit: GateVisit;
  site?: Site | null;
  onClose: () => void;
  onOpenWaybill?: (tripId: string) => void;
}) {
  useEffect(() => {
    document.body.classList.add("printing-waybill-modal");
    return () => document.body.classList.remove("printing-waybill-modal");
  }, []);

  const detentionFee = visit.dwellMinutes > 120 ? Math.min(20_000, Math.round((visit.dwellMinutes - 120) * 25)) : 0;

  return (
    <Modal title={`Gate Pass · ${visit.plate}`} onClose={onClose}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row-between waybill-no-print">
          <div className="row" style={{ gap: 8 }}>
            {visit.tripId && onOpenWaybill ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => onOpenWaybill(visit.tripId!)}
              >
                <FileText size={14} /> View Trip Waybill
              </button>
            ) : null}
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => window.print()}>
            <Printer size={14} /> Print / Save Yard Slip
          </button>
        </div>

        <div id="waybill-print-sheet" className="waybill-sheet">
          <header className="waybill-header">
            <div>
              <div className="waybill-brand">CORELOGISTICS GATE & YARD PASS</div>
              <div className="waybill-code mono">{visit.plate}</div>
              <div className="row" style={{ marginTop: 4, gap: 6, flexWrap: "wrap" }}>
                <Pill value={visit.status} />
                <Pill tone={visit.inspectionStatus === "hold" ? "danger" : "ok"}>
                  {visit.inspectionStatus === "hold" ? (
                    <>
                      <ShieldAlert size={11} /> SECURITY HOLD
                    </>
                  ) : (
                    <>
                      <ShieldCheck size={11} /> GATE CLEARED
                    </>
                  )}
                </Pill>
                <Pill tone="muted">{humanize(visit.vehicleKind)}</Pill>
              </div>
            </div>
            <BarcodeSvg code={visit.id.toUpperCase()} />
          </header>

          <section className="waybill-grid">
            <div className="waybill-box">
              <div className="waybill-box-title">Facility & Assignment</div>
              <div className="strong">{site ? `${site.code} · ${site.name}` : visit.siteId}</div>
              <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>
                {visit.dock
                  ? `Dock ${visit.dock.code} (${visit.dock.purpose})`
                  : visit.yardCode
                    ? `Yard Stall ${visit.yardCode}`
                    : "Open Staging / Unassigned"}
              </div>
              <div className="small muted">Trip Ref: {visit.tripCode ?? "Local / Unlinked"}</div>
            </div>

            <div className="waybill-box">
              <div className="waybill-box-title">Security Seals & Timing</div>
              <div className="waybill-kv-row">
                <span>
                  Seal In: <strong className="mono">{visit.sealIn || "None recorded"}</strong>
                </span>
                <span>
                  Seal Out: <strong className="mono">{visit.sealOut || "Pending"}</strong>
                </span>
              </div>
              <div className="small muted">Check-In: {fmtDateTime(visit.checkInAt)}</div>
              <div className="small muted">
                Check-Out: {visit.checkOutAt ? fmtDateTime(visit.checkOutAt) : "Still on site"} · Dwell{" "}
                <strong>{formatDuration(visit.dwellMinutes)}</strong>
                {detentionFee > 0 ? ` (Detention risk ₱${detentionFee.toLocaleString("en-US")})` : ""}
              </div>
            </div>
          </section>

          {visit.notes ? (
            <section className="waybill-box">
              <div className="waybill-box-title">Gatehouse Notes & Remarks</div>
              <div className="small">{visit.notes}</div>
            </section>
          ) : null}

          {visit.proofPhotoIn || visit.proofPhotoOut ? (
            <section className="waybill-box">
              <div className="waybill-box-title">Captured Seal & Condition Proofs</div>
              <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                {visit.proofPhotoIn ? (
                  <div className="stack" style={{ gap: 4 }}>
                    <span className="small muted">Gate-In Photo</span>
                    <img
                      src={visit.proofPhotoIn}
                      alt="Gate check-in proof"
                      style={{ width: 150, height: 96, objectFit: "cover", borderRadius: 8, border: "1px solid #cbd5e1" }}
                    />
                  </div>
                ) : null}
                {visit.proofPhotoOut ? (
                  <div className="stack" style={{ gap: 4 }}>
                    <span className="small muted">Gate-Out Photo</span>
                    <img
                      src={visit.proofPhotoOut}
                      alt="Gate check-out proof"
                      style={{ width: 150, height: 96, objectFit: "cover", borderRadius: 8, border: "1px solid #cbd5e1" }}
                    />
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          <section className="waybill-box">
            <div className="waybill-box-title">Driver & Security Release Verification</div>
            <div className="waybill-grid">
              <div className="waybill-sig-line">Driver acknowledgement</div>
              <div className="waybill-sig-line">Gatehouse security sign-off</div>
            </div>
          </section>
        </div>
      </div>
    </Modal>
  );
}
