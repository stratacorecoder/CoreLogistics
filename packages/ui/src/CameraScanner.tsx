import { Camera, Flashlight, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";

function playBeep() {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1046.5, ctx.currentTime); // C6
    osc.frequency.exponentialRampToValueAtTime(1318.5, ctx.currentTime + 0.08); // E6
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
    // Audio context may be restricted before user gesture
  }
}

function triggerHaptic() {
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate([40, 20, 60]);
    }
  } catch {
    // Ignore devices without vibration support
  }
}

interface CameraScannerProps {
  onScan: (code: string) => void;
  onClose: () => void;
  title?: string;
}

export function CameraScanner({ onScan, onClose, title = "Scan Barcode or QR" }: CameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [detectorSupported, setDetectorSupported] = useState(true);
  const scannedRef = useRef(false);

  useEffect(() => {
    scannedRef.current = false;
    let active = true;
    let scanInterval: ReturnType<typeof setInterval> | null = null;

    async function startCamera() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setError("Camera access is not supported on this device/browser.");
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        // Check torch capability
        const track = stream.getVideoTracks()[0];
        if (track && typeof track.getCapabilities === "function") {
          const caps = track.getCapabilities() as { torch?: boolean };
          if (caps.torch) setHasTorch(true);
        }

        // Start scanning loop
        const BarcodeDetectorClass = (window as unknown as { BarcodeDetector?: any }).BarcodeDetector;
        if (BarcodeDetectorClass) {
          const detector = new BarcodeDetectorClass({
            formats: ["qr_code", "code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e"],
          });

          scanInterval = setInterval(async () => {
            if (!active || scannedRef.current || !videoRef.current) return;
            try {
              if (videoRef.current.readyState >= 2) {
                const barcodes = await detector.detect(videoRef.current);
                if (barcodes && barcodes.length > 0 && !scannedRef.current) {
                  const rawValue = barcodes[0].rawValue;
                  if (rawValue) {
                    scannedRef.current = true;
                    playBeep();
                    triggerHaptic();
                    if (scanInterval) clearInterval(scanInterval);
                    onScan(rawValue.trim());
                  }
                }
              }
            } catch {
              // Frame dropped or detector busy
            }
          }, 150);
        } else {
          setDetectorSupported(false);
        }
      } catch (err) {
        if (active) {
          setError(`Camera access denied or unavailable: ${(err as Error).message}`);
        }
      }
    }

    startCamera();

    return () => {
      active = false;
      if (scanInterval) {
        clearInterval(scanInterval);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [onScan]);

  const toggleTorch = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (track && typeof track.applyConstraints === "function") {
      try {
        const next = !torchOn;
        await (track as any).applyConstraints({ advanced: [{ torch: next }] });
        setTorchOn(next);
      } catch {
        // Torch toggle failed
      }
    }
  };

  const handleManualSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim()) return;
    playBeep();
    triggerHaptic();
    onScan(manualCode.trim());
  };

  return (
    <div
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
        {/* Header */}
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
            <Camera size={18} color="var(--accent, #0066cc)" />
            <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {hasTorch ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={toggleTorch}
                title="Toggle flashlight"
                style={{ padding: "4px 8px" }}
              >
                <Flashlight size={16} color={torchOn ? "#ff9500" : "currentColor"} />
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onClose}
              title="Close scanner"
              style={{ padding: "4px 8px" }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Viewfinder */}
        <div
          style={{
            position: "relative",
            width: "100%",
            height: 280,
            background: "#000000",
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {error ? (
            <div style={{ padding: 20, color: "#f87171", textAlign: "center", fontSize: 13 }}>
              <p>{error}</p>
              <p className="small muted" style={{ marginTop: 8, color: "#94a3b8" }}>
                Use manual input below instead.
              </p>
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                playsInline
                autoPlay
                muted
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
              {/* Aiming Reticle */}
              <div
                style={{
                  position: "absolute",
                  width: 220,
                  height: 140,
                  border: "2px solid rgba(0, 122, 255, 0.8)",
                  borderRadius: 14,
                  boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.45)",
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    inset: "0 0 0 0",
                    border: "2px solid #34c759",
                    borderRadius: 12,
                    animation: "pulse 1.8s infinite ease-in-out",
                  }}
                />
              </div>
            </>
          )}
        </div>

        {!detectorSupported ? (
          <div style={{ padding: "8px 14px", background: "rgba(255, 149, 0, 0.12)", color: "var(--warn, #b45309)", fontSize: 11, borderTop: "1px solid var(--border)" }}>
            Automatic camera barcode decoding requires Chrome, Edge, or Safari 17+. Please enter code below manually.
          </div>
        ) : null}

        {/* Manual Fallback Input */}
        <form
          onSubmit={handleManualSubmit}
          style={{
            padding: 14,
            display: "flex",
            gap: 8,
            borderTop: "1px solid var(--border-subtle, rgba(0, 0, 0, 0.08))",
          }}
        >
          <input
            className="input"
            style={{ flex: 1, fontSize: 13 }}
            placeholder="Or type/paste barcode manually…"
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!manualCode.trim()}>
            Submit
          </button>
        </form>
      </div>
    </div>
  );
}

interface ScanButtonProps {
  onScan: (code: string) => void;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function ScanButton({ onScan, title = "Scan barcode", className = "btn btn-ghost btn-sm", style }: ScanButtonProps) {
  const [open, setOpen] = useState(false);

  const handleScan = (code: string) => {
    setOpen(false);
    onScan(code);
  };

  return (
    <>
      <button
        type="button"
        className={className}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "6px 9px",
          gap: 4,
          ...style,
        }}
        onClick={() => setOpen(true)}
        title={title}
      >
        <Camera size={15} />
        <span style={{ fontSize: 12 }}>Scan</span>
      </button>
      {open ? <CameraScanner onScan={handleScan} onClose={() => setOpen(false)} title={title} /> : null}
    </>
  );
}
