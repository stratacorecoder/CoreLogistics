import { Camera, Flashlight, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { fallbackFormatValues, ScanSession, shouldReleaseCamera, type ScanSessionHost } from "./scanSession.js";

type CaptureMethod = "camera" | "manual";

function playBeep() {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1046.5, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1318.5, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.onended = () => {
      ctx.close().catch(() => {});
    };
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  } catch {
    // Audio context may be restricted before a user gesture.
  }
}

function triggerHaptic() {
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([40, 20, 60]);
  } catch {
    // Ignore devices without vibration support.
  }
}

interface CameraScannerProps {
  onScan: (code: string, method?: CaptureMethod) => void;
  onClose: () => void;
  title?: string;
}

export function CameraScanner({ onScan, onClose, title = "Scan Barcode or QR" }: CameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onScanRef = useRef(onScan);
  const startRef = useRef<() => void>(() => {});
  const sessionRef = useRef<ScanSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [usingFallback, setUsingFallback] = useState(false);

  onScanRef.current = onScan;

  useEffect(() => {
    const detector = (window as unknown as { BarcodeDetector?: ScanSessionHost["detector"] }).BarcodeDetector;
    const session = new ScanSession({
      getUserMedia: navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices),
      detector,
      schedule: (run, intervalMs) => {
        const id = window.setInterval(() => void run(), intervalMs);
        return { cancel: () => window.clearInterval(id) };
      },
      loadFallback: async (video, onText) => {
        const { BrowserMultiFormatReader, BarcodeFormat } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        reader.possibleFormats = fallbackFormatValues(BarcodeFormat);
        return reader.decodeFromVideoElement(video as HTMLVideoElement, (result) => {
          const text = result?.getText();
          if (text) onText(text);
        });
      },
      onCode: (code, method) => {
        playBeep();
        triggerHaptic();
        onScanRef.current(code, method);
      },
      onChange: (state) => {
        setError(state.error);
        setPaused(state.paused);
        setUsingFallback(state.usingFallback);
        setHasTorch(state.hasTorch);
        setTorchOn(state.torchOn);
      },
    });
    sessionRef.current = session;
    startRef.current = () => {
      void session.start(videoRef.current);
    };
    void session.start(videoRef.current);
    const onVisibility = () => {
      if (shouldReleaseCamera(document.hidden)) session.background();
    };
    const onPageHide = () => session.background();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      session.dispose();
      sessionRef.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  const toggleTorch = async () => {
    const track = sessionRef.current?.currentStream()?.getVideoTracks()[0];
    if (!track || typeof track.applyConstraints !== "function") return;
    try {
      const next = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setHasTorch(false);
    }
  };

  const handleManualSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!manualCode.trim()) return;
    sessionRef.current?.deliver(manualCode, "manual");
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(10, 15, 29, 0.85)",
        backdropFilter: "blur(12px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 440,
          background: "var(--panel-2, rgba(255, 255, 255, 0.85))",
          borderRadius: 20,
          border: "1px solid var(--border, rgba(255, 255, 255, 0.2))",
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.3)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "14px 18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--border-subtle, rgba(0, 0, 0, 0.08))",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Camera size={18} color="var(--accent, #0066cc)" aria-hidden="true" />
            <span id="scan-title" style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {hasTorch ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void toggleTorch()} aria-pressed={torchOn} aria-label="Toggle flashlight" style={{ padding: "4px 8px" }}>
                <Flashlight size={16} color={torchOn ? "#ff9500" : "currentColor"} aria-hidden="true" />
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close scanner" style={{ padding: "4px 8px" }}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div style={{ position: "relative", width: "100%", height: 280, background: "#000000", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <video ref={videoRef} playsInline autoPlay muted aria-label="Rear camera preview" style={{ width: "100%", height: "100%", objectFit: "cover", display: error || paused ? "none" : "block" }} />
          {paused ? (
            <div style={{ padding: 20, textAlign: "center" }}>
              <p style={{ color: "#e2e8f0", fontSize: 13 }}>Camera paused while the app was in the background.</p>
              <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={() => startRef.current()}>
                Resume camera
              </button>
            </div>
          ) : null}
          {error ? (
            <div style={{ padding: 20, color: "#f87171", textAlign: "center", fontSize: 13 }}>
              <p>{error}</p>
              <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={() => startRef.current()}>
                Allow camera
              </button>
            </div>
          ) : null}
          {!error && !paused ? (
            <div aria-hidden="true" style={{ position: "absolute", width: 220, height: 140, border: "2px solid rgba(0, 122, 255, 0.8)", borderRadius: 14, boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.45)", pointerEvents: "none" }} />
          ) : null}
        </div>

        {usingFallback ? (
          <div style={{ padding: "8px 14px", background: "rgba(255, 149, 0, 0.12)", color: "var(--warn, #b45309)", fontSize: 11, borderTop: "1px solid var(--border)" }}>
            This browser has no built-in barcode detector. A backup decoder is reading the rear camera.
          </div>
        ) : null}

        <form onSubmit={handleManualSubmit} style={{ padding: 14, display: "flex", gap: 8, borderTop: "1px solid var(--border-subtle, rgba(0, 0, 0, 0.08))" }}>
          <label htmlFor="scan-manual" className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>
            Manual entry
          </label>
          <input id="scan-manual" className="input" style={{ flex: 1, fontSize: 13 }} placeholder="Manual entry" value={manualCode} onChange={(event) => setManualCode(event.target.value)} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!manualCode.trim()}>
            Use code
          </button>
        </form>
      </div>
    </div>
  );
}

interface ScanButtonProps {
  onScan: (code: string, method?: CaptureMethod) => void;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function ScanButton({ onScan, title = "Scan barcode", className = "btn btn-ghost btn-sm", style }: ScanButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={className}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "6px 9px", gap: 4, ...style }}
        onClick={() => setOpen(true)}
        aria-label={title}
      >
        <Camera size={15} aria-hidden="true" />
        <span style={{ fontSize: 12 }}>Scan</span>
      </button>
      {open ? (
        <CameraScanner
          title={title}
          onClose={() => setOpen(false)}
          onScan={(code, method) => {
            setOpen(false);
            onScan(code, method ?? "camera");
          }}
        />
      ) : null}
    </>
  );
}
