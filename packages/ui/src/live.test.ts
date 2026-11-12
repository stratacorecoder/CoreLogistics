import assert from "node:assert/strict";
import test from "node:test";
import { createReloadScheduler, createSourceManager, type EventSourceLike } from "./live-controller.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeEventSource implements EventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(msg: { data: string }) => void>>();

  addEventListener(type: string, fn: (msg: { data: string }) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  emitOpen() {
    this.onopen?.();
  }

  emitError() {
    this.onerror?.();
  }

  emitEvent(data: string) {
    for (const fn of this.listeners.get("event") ?? []) {
      fn({ data });
    }
  }

  close() {
    this.closed = true;
  }
}

test("createReloadScheduler coalesces burst schedule() calls into one fetch", async () => {
  let runs = 0;
  const scheduler = createReloadScheduler(() => {
    runs += 1;
  }, 40);

  scheduler.schedule();
  scheduler.schedule();
  await sleep(10);
  scheduler.schedule();

  assert.equal(runs, 0);
  await sleep(60);
  assert.equal(runs, 1);

  scheduler.dispose();
});

test("createReloadScheduler serializes in-flight calls and runs one trailing refresh", async () => {
  let active = 0;
  let maxConcurrent = 0;
  let totalRuns = 0;
  let releaseFirst!: () => void;

  const scheduler = createReloadScheduler(async () => {
    totalRuns += 1;
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    if (totalRuns === 1) {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    }
    active -= 1;
  }, 20);

  scheduler.flushNow();
  assert.equal(totalRuns, 1);

  // Scheduled triggers while first fetch is still in-flight must not overlap
  scheduler.schedule();
  await sleep(35);
  assert.equal(totalRuns, 1);
  assert.equal(maxConcurrent, 1);

  // Additional burst while still waiting must still coalesce to one trailing run
  scheduler.schedule();
  releaseFirst();
  await sleep(45);
  assert.equal(totalRuns, 2);
  assert.equal(maxConcurrent, 1);

  scheduler.dispose();
});

test("createReloadScheduler reset() clears pending timers and ignores stale in-flight completion", async () => {
  let runs = 0;
  let releaseStale!: () => void;

  const scheduler = createReloadScheduler(async () => {
    runs += 1;
    if (runs === 1) {
      await new Promise<void>((resolve) => {
        releaseStale = resolve;
      });
    }
  }, 20);

  scheduler.flushNow();
  scheduler.schedule();
  scheduler.reset();

  // New path immediate fetch must not be blocked by stale generation in-flight request
  scheduler.flushNow();
  assert.equal(runs, 2);

  releaseStale();
  await sleep(40);
  assert.equal(runs, 2);

  scheduler.dispose();
});

test("createSourceManager ignores malformed JSON, survives StrictMode remount, and closes when empty", async () => {
  const created: FakeEventSource[] = [];
  const manager = createSourceManager<{ id: number }>(() => {
    const es = new FakeEventSource();
    created.push(es);
    return es;
  });

  const received: number[] = [];
  const statuses: boolean[] = [];

  // StrictMode simulated mount -> unmount -> synchronous remount in same tick
  const offStrict = manager.subscribeStatus((s) => statuses.push(s));
  offStrict();
  const offStatus = manager.subscribeStatus((s) => statuses.push(s));
  const offEvents = manager.subscribeEvents((e) => received.push(e.id));

  await Promise.resolve();
  assert.equal(created.length, 1);
  assert.equal(created[0]!.closed, false);

  created[0]!.emitOpen();
  created[0]!.emitEvent("{not-json");
  created[0]!.emitEvent(JSON.stringify({ id: 7 }));
  assert.deepEqual(received, [7]);
  assert.equal(statuses.at(-1), true);

  // Last subscribers unmount -> auto-closes via microtask
  offStatus();
  offEvents();
  await Promise.resolve();
  assert.equal(created[0]!.closed, true);
  assert.equal(manager.isOnline(), false);

  // Resubscribe creates fresh source; explicit close() closes immediately
  const offNext = manager.subscribeEvents(() => {});
  assert.equal(created.length, 2);
  assert.equal(created[1]!.closed, false);
  manager.close();
  assert.equal(created[1]!.closed, true);
  offNext();
});
