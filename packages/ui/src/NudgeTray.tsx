import type { NudgePriority, NudgeTargetRole, OpsNudge } from "@corelogistics/contracts";
import { BellRing, Camera, CheckCircle2, Send, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, qs } from "./api.js";
import { Field, Modal } from "./components.js";
import { fromNow } from "./format.js";
import { useAction, useApi, useLiveEvents } from "./live.js";

function playNudgeChime(urgent: boolean) {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const playTone = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
      gain.gain.setValueAtTime(0.12, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    };
    playTone(urgent ? 880 : 660, 0, 0.12);
    playTone(urgent ? 1174 : 880, 0.13, 0.16);
    setTimeout(() => ctx.close().catch(() => {}), 500);
  } catch {
    // Ignore audio restrictions before user gesture
  }
}

export function NudgeBanner({
  role,
  siteId,
  driverId,
}: {
  role: NudgeTargetRole;
  siteId?: string | null;
  driverId?: string | null;
}) {
  const { busy, run } = useAction();
  const [replyingId, setReplyingId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState("");
  const lastSeenRef = useRef<number>(0);

  const query = qs({
    targetRole: role,
    siteId: siteId || undefined,
    driverId: driverId || undefined,
    openOnly: "true",
    limit: 10,
  });
  const nudges = useApi<OpsNudge[]>(`/ops/nudges${query}`, {
    live: (e) => e.type === "ops.nudge" || e.type === "ops.nudge_ack",
  });

  useLiveEvents((e) => {
    if (e.type !== "ops.nudge") return;
    const target = e.payload?.targetRole;
    if (target !== role) return;
    if (siteId && e.siteId && e.siteId !== siteId) return;
    if (driverId && e.driverId && e.driverId !== driverId) return;
    if (e.id > lastSeenRef.current) {
      lastSeenRef.current = e.id;
      playNudgeChime(e.payload?.priority === "urgent");
    }
  });

  useEffect(() => {
    const top = nudges.data?.[0];
    if (top && top.id > lastSeenRef.current) lastSeenRef.current = top.id;
  }, [nudges.data]);

  if (!nudges.data?.length) return null;

  const ack = (nudge: OpsNudge, withDetails = false) =>
    run(async () => {
      await api.post(`/ops/nudges/${nudge.id}/ack`, {
        note: withDetails && note.trim() ? note.trim() : undefined,
        proofPhoto: withDetails && photo ? photo : undefined,
      });
      setReplyingId(null);
      setNote("");
      setPhoto("");
      nudges.reload();
    }, "Nudge acknowledged");

  return (
    <div className="nudge-banner-stack" role="status" aria-live="polite">
      {nudges.data.map((n) => (
        <div key={n.id} className={`nudge-banner${n.priority === "urgent" ? " is-urgent" : ""}`}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0, flex: 1 }}>
            <BellRing size={18} style={{ flexShrink: 0, marginTop: 2, color: n.priority === "urgent" ? "var(--danger)" : "var(--accent)" }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text-heading)" }}>
                {n.priority === "urgent" ? "URGENT · " : ""}
                {n.locationCode ? `${n.locationCode} · ` : ""}
                {n.message}
              </div>
              <div className="muted small">
                From {n.sender ?? "Control Tower"} · {fromNow(n.createdAt)}
              </div>
              {replyingId === n.id ? (
                <div className="stack" style={{ marginTop: 8, gap: 6 }}>
                  <input
                    className="input"
                    placeholder="Quick reply (optional)..."
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <PhotoProofPicker value={photo} onChange={setPhoto} label="Attach photo proof" />
                </div>
              ) : null}
            </div>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {replyingId === n.id ? (
              <>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void ack(n, true)}>
                  Send & acknowledge
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReplyingId(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReplyingId(n.id)}>
                  Reply / Photo
                </button>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void ack(n, false)}>
                  <CheckCircle2 size={14} /> Got it — On it
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const PRESET_NUDGES: Record<NudgeTargetRole, string[]> = {
  warehouse: ["Expedite unload at dock", "Priority pick — truck waiting", "Verify pallet seal & photo"],
  gate: ["Hold truck in yard pending dock", "Call next waiting truck to dock", "Confirm departure seal check"],
  driver: ["Priority delivery — expedite route", "Proceed to assigned dock door", "Upload seal/condition photo"],
};

export function SendNudgeModal({
  targetRole: initialRole = "warehouse",
  siteId,
  driverId,
  tripId,
  locationCode,
  onClose,
}: {
  targetRole?: NudgeTargetRole;
  siteId?: string | null;
  driverId?: string | null;
  tripId?: string | null;
  locationCode?: string | null;
  onClose: () => void;
}) {
  const { busy, run } = useAction();
  const [targetRole, setTargetRole] = useState<NudgeTargetRole>(initialRole);
  const [priority, setPriority] = useState<NudgePriority>("urgent");
  const [message, setMessage] = useState("");

  const submit = async () => {
    if (!message.trim()) return;
    await run(
      () =>
        api.post("/ops/nudges", {
          targetRole,
          siteId: siteId || undefined,
          driverId: targetRole === "driver" ? driverId || undefined : undefined,
          tripId: tripId || undefined,
          locationCode: locationCode || undefined,
          priority,
          message: message.trim(),
        }),
      `Nudge sent to ${targetRole}`,
    );
    onClose();
  };

  return (
    <Modal title={`Tap & Nudge${locationCode ? ` · ${locationCode}` : ""}`} onClose={onClose}>
      <div className="form">
        <div className="form-2">
          <Field label="Target station">
            <select className="select" value={targetRole} onChange={(e) => setTargetRole(e.target.value as NudgeTargetRole)}>
              <option value="warehouse">Warehouse floor</option>
              <option value="gate">Gate & Yard</option>
              <option value="driver">Driver cab</option>
            </select>
          </Field>
          <Field label="Urgency">
            <select className="select" value={priority} onChange={(e) => setPriority(e.target.value as NudgePriority)}>
              <option value="urgent">Urgent (pulsing alert + chime)</option>
              <option value="normal">Normal</option>
            </select>
          </Field>
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {PRESET_NUDGES[targetRole].map((preset) => (
            <button key={preset} type="button" className="btn btn-ghost btn-sm" onClick={() => setMessage(preset)}>
              {preset}
            </button>
          ))}
        </div>
        <Field label="Instruction">
          <textarea
            className="textarea"
            rows={3}
            placeholder="Write a clear, actionable instruction..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </Field>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || message.trim().length < 2} onClick={() => void submit()}>
            <Send size={14} /> Send nudge
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Compresses a captured or selected image file into a lightweight JPEG data URL. */
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read image"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Invalid image file"));
      img.onload = () => {
        const maxDim = 960;
        const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas unavailable"));
        ctx.drawImage(img, 0, 0, canvas.width, h);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function PhotoProofPicker({
  value,
  onChange,
  label = "Condition / seal photo",
}: {
  value: string;
  onChange: (dataUrl: string) => void;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      try {
        setErr(null);
        const compressed = await compressImage(file);
        onChange(compressed);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not attach photo");
      }
    },
    [onChange],
  );

  return (
    <div className="stack" style={{ gap: 6 }}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => inputRef.current?.click()}>
          <Camera size={14} /> {value ? "Retake photo" : label}
        </button>
        {value ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange("")}>
            <X size={14} /> Remove
          </button>
        ) : null}
      </div>
      {err ? <span className="danger-text small">{err}</span> : null}
      {value ? (
        <img
          src={value}
          alt="Proof attachment"
          style={{
            maxWidth: 180,
            maxHeight: 110,
            objectFit: "cover",
            borderRadius: 10,
            border: "1px solid var(--line)",
          }}
        />
      ) : null}
    </div>
  );
}
