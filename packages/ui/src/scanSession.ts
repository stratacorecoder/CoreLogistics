export const NATIVE_DETECTOR_FORMATS = ["qr_code", "code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e"] as const;

export const FALLBACK_FORMAT_NAMES = ["QR_CODE", "CODE_128", "CODE_39", "EAN_13", "EAN_8", "UPC_A", "UPC_E"] as const;

export const SCAN_INTERVAL_MS = 200;

/** The open camera is released when the document is hidden. Becoming visible does not start it. */
export function shouldReleaseCamera(documentHidden: boolean): boolean {
  return documentHidden;
}

export function fallbackFormatValues<T>(formats: Record<(typeof FALLBACK_FORMAT_NAMES)[number], T>): T[] {
  return FALLBACK_FORMAT_NAMES.map((name) => formats[name]);
}

export function cameraErrorMessage(err: unknown): string {
  const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "NotFoundError");
  if (denied) return "Camera permission is blocked. Allow it, then try the camera again.";
  const message = err instanceof Error ? err.message : "unknown error";
  return `Camera unavailable: ${message}`;
}

export interface ScanVideo {
  srcObject: MediaProvider | null;
  readyState: number;
  play: () => Promise<void>;
}

export interface ScanSnapshot {
  error: string | null;
  paused: boolean;
  usingFallback: boolean;
  hasTorch: boolean;
  torchOn: boolean;
}

interface Timer {
  cancel: () => void;
}

export interface ScanSessionHost {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  detector?: new (opts: { formats: string[] }) => { detect: (source: ScanVideo) => Promise<Array<{ rawValue?: string }>> };
  schedule: (run: () => Promise<void> | void, intervalMs: number) => Timer;
  loadFallback: (video: ScanVideo, onText: (text: string) => void) => Promise<{ stop: () => void }>;
  onCode: (code: string, method: "camera" | "manual") => void;
  onChange: (state: ScanSnapshot) => void;
}

export class ScanSession {
  private generation = 0;
  private scanned = false;
  private busy = false;
  private closed = false;
  private stream: MediaStream | null = null;
  private video: ScanVideo | null = null;
  private controls: { stop: () => void } | null = null;
  private timer: Timer | null = null;
  private state: ScanSnapshot = { error: null, paused: false, usingFallback: false, hasTorch: false, torchOn: false };

  constructor(private readonly host: ScanSessionHost) {}

  currentStream(): MediaStream | null {
    return this.stream;
  }

  snapshot(): ScanSnapshot {
    return this.state;
  }

  private publish(patch: Partial<ScanSnapshot>) {
    this.state = { ...this.state, ...patch };
    this.host.onChange(this.state);
  }

  private stopTracks(stream: MediaStream | null) {
    stream?.getTracks().forEach((track) => track.stop());
  }

  release() {
    this.controls?.stop();
    this.controls = null;
    this.timer?.cancel();
    this.timer = null;
    this.stopTracks(this.stream);
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.publish({ torchOn: false, hasTorch: false });
  }

  /** Returns false when the code was empty or this session already delivered one. */
  deliver(code: string, method: "camera" | "manual"): boolean {
    const value = code.trim();
    if (!value || this.scanned) return false;
    this.scanned = true;
    this.timer?.cancel();
    this.timer = null;
    this.controls?.stop();
    this.controls = null;
    this.host.onCode(value, method);
    return true;
  }

  /** Drops the camera and waits. Resume is a later call to start. */
  background() {
    this.generation += 1;
    this.release();
    this.publish({ paused: true });
  }

  dispose() {
    this.closed = true;
    this.generation += 1;
    this.release();
  }

  async start(video: ScanVideo | null): Promise<void> {
    const current = ++this.generation;
    this.video = video;
    this.release();
    if (this.closed || current !== this.generation) return;
    this.scanned = false;
    this.busy = false;
    this.publish({ error: null, paused: false, usingFallback: false });
    if (!this.host.getUserMedia) {
      this.publish({ error: "Camera access is not supported on this device or browser." });
      return;
    }
    try {
      const stream = await this.host.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (this.closed || current !== this.generation) {
        this.stopTracks(stream);
        return;
      }
      this.stream = stream;
      if (!video) {
        this.stopTracks(stream);
        this.stream = null;
        return;
      }
      video.srcObject = stream;
      await video.play().catch(() => {});
      if (this.closed || current !== this.generation) return;
      const track = stream.getVideoTracks()[0];
      if (track && typeof track.getCapabilities === "function") {
        const caps = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
        if (caps.torch) this.publish({ hasTorch: true });
      }
      if (typeof this.host.detector === "function") {
        const detector = new this.host.detector({ formats: [...NATIVE_DETECTOR_FORMATS] });
        this.timer = this.host.schedule(async () => {
          if (this.busy || this.scanned || current !== this.generation || !video) return;
          if (video.readyState < 2) return;
          this.busy = true;
          try {
            const barcodes = await detector.detect(video);
            const raw = barcodes?.[0]?.rawValue;
            if (raw) this.deliver(raw, "camera");
          } catch {
            // A dropped frame is not a confirmation.
          } finally {
            this.busy = false;
          }
        }, SCAN_INTERVAL_MS);
        return;
      }
      this.publish({ usingFallback: true });
      const controls = await this.host.loadFallback(video, (text) => {
        if (text) this.deliver(text, "camera");
      });
      if (this.closed || current !== this.generation) {
        controls.stop();
        return;
      }
      this.controls = controls;
    } catch (err) {
      if (this.closed || current !== this.generation) return;
      this.release();
      this.publish({ error: cameraErrorMessage(err) });
    }
  }
}
