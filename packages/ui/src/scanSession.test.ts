import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fallbackFormatValues, FALLBACK_FORMAT_NAMES, NATIVE_DETECTOR_FORMATS, SCAN_INTERVAL_MS, ScanSession, shouldReleaseCamera, type ScanVideo } from "./scanSession.js";

function track() {
  const stops: string[] = [];
  return {
    stops,
    kind: "video" as const,
    stop: () => stops.push("stop"),
    getCapabilities: () => ({ torch: false }),
    applyConstraints: async () => {},
  };
}

function streamOf(videoTrack = track()) {
  return {
    videoTrack,
    getTracks: () => [videoTrack],
    getVideoTracks: () => [videoTrack],
  } as unknown as MediaStream;
}

function video(): ScanVideo {
  return { srcObject: null, readyState: 4, play: async () => {} };
}

describe("Scanner session", () => {
  it("releases the camera when the page is hidden and leaves it alone when the page is shown", () => {
    assert.equal(shouldReleaseCamera(true), true);
    assert.equal(shouldReleaseCamera(false), false);
  });

  it("uses the backup decoder when the browser has no BarcodeDetector", async () => {
    const codes: string[] = [];
    let stopped = 0;
    let onText: (text: string) => void = () => {};
    const opened = streamOf();
    const session = new ScanSession({
      getUserMedia: async () => opened,
      schedule: () => ({ cancel: () => {} }),
      loadFallback: async (_video, deliverText) => {
        onText = deliverText;
        return { stop: () => { stopped += 1; } };
      },
      onCode: (code) => codes.push(code),
      onChange: () => {},
    });
    await session.start(video());
    assert.equal(session.snapshot().usingFallback, true);
    onText("HU-1");
    onText("HU-1");
    assert.deepEqual(codes, ["HU-1"]);
    assert.equal(stopped, 1);
    assert.deepEqual(NATIVE_DETECTOR_FORMATS, ["qr_code", "code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e"]);
    assert.deepEqual(FALLBACK_FORMAT_NAMES, ["QR_CODE", "CODE_128", "CODE_39", "EAN_13", "EAN_8", "UPC_A", "UPC_E"]);
    assert.deepEqual(fallbackFormatValues({ QR_CODE: "q", CODE_128: "c128", CODE_39: "c39", EAN_13: "e13", EAN_8: "e8", UPC_A: "ua", UPC_E: "ue" }), ["q", "c128", "c39", "e13", "e8", "ua", "ue"]);
  });

  it("reports a blocked camera, ignores a duplicate frame, and does not restart after backgrounding", async () => {
    const denied = new ScanSession({
      getUserMedia: async () => {
        throw new DOMException("blocked", "NotAllowedError");
      },
      schedule: () => ({ cancel: () => {} }),
      loadFallback: async () => ({ stop: () => {} }),
      onCode: () => assert.fail("a denied camera must not confirm a code"),
      onChange: () => {},
    });
    await denied.start(video());
    assert.match(denied.snapshot().error ?? "", /permission is blocked/);

    const codes: string[] = [];
    let detects = 0;
    let interval = 0;
    const stops: string[] = [];
    const videoTrack = track();
    videoTrack.stop = () => stops.push("stop");
    let releaseDetect: (value: Array<{ rawValue?: string }>) => void = () => {};
    const pending = new Promise<Array<{ rawValue?: string }>>((resolve) => {
      releaseDetect = resolve;
    });
    let tick: () => Promise<void> | void = () => {};
    let opens = 0;
    const session = new ScanSession({
      getUserMedia: async () => {
        opens += 1;
        return streamOf(videoTrack);
      },
      detector: class {
        constructor(opts: { formats: string[] }) {
          assert.equal(opts.formats.length, NATIVE_DETECTOR_FORMATS.length);
        }
        detect() {
          detects += 1;
          return pending;
        }
      },
      schedule: (run, intervalMs) => {
        interval = intervalMs;
        tick = run;
        return { cancel: () => stops.push("cancel") };
      },
      loadFallback: async () => ({ stop: () => {} }),
      onCode: (code, method) => codes.push(`${method}:${code}`),
      onChange: () => {},
    });
    await session.start(video());
    assert.equal(interval, SCAN_INTERVAL_MS);
    const first = tick();
    tick();
    assert.equal(detects, 1);
    releaseDetect([{ rawValue: " HU-9 " }]);
    await first;
    assert.deepEqual(codes, ["camera:HU-9"]);
    session.background();
    assert.equal(session.snapshot().paused, true);
    assert.equal(opens, 1);
    assert.ok(stops.includes("stop"));
    await session.start(video());
    assert.equal(opens, 2);
    assert.equal(session.snapshot().paused, false);
    session.dispose();
    assert.ok(stops.filter((item) => item === "stop").length >= 2);
  });
});
