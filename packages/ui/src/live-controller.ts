export interface EventSourceLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, fn: (msg: { data: string }) => void): void;
  close(): void;
}

export interface ReloadScheduler {
  schedule: () => void;
  flushNow: () => void;
  reset: () => void;
  dispose: () => void;
}

/**
 * Coalesces rapid background triggers (e.g. local action refresh + SSE frame)
 * into a single trailing fetch and serializes in-flight executions per hook.
 */
export function createReloadScheduler(execute: () => Promise<unknown> | void, delayMs = 80): ReloadScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let pendingTrailing = false;
  let disposed = false;
  let gen = 0;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const run = () => {
    if (disposed) return;
    if (inFlight) {
      pendingTrailing = true;
      return;
    }
    const myGen = gen;
    inFlight = true;
    pendingTrailing = false;
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(execute());
    } catch (err) {
      p = Promise.reject(err);
    }
    p.catch(() => {}).finally(() => {
      if (disposed || gen !== myGen) return;
      inFlight = false;
      if (pendingTrailing) {
        pendingTrailing = false;
        schedule();
      }
    });
  };

  const schedule = () => {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delayMs);
  };

  const flushNow = () => {
    if (disposed) return;
    clearTimer();
    run();
  };

  const reset = () => {
    gen += 1;
    clearTimer();
    inFlight = false;
    pendingTrailing = false;
  };

  const dispose = () => {
    disposed = true;
    reset();
  };

  return { schedule, flushNow, reset, dispose };
}

export type StreamPhase = "connecting" | "online" | "offline";

/**
 * Shared EventSource registry that closes idle connections cleanly via microtask
 * (avoiding dev StrictMode teardown churn) and guards event JSON parsing.
 */
export function createSourceManager<TEvent>(createSource: () => EventSourceLike | null) {
  const listeners = new Set<(event: TEvent) => void>();
  const statusListeners = new Set<(online: boolean) => void>();
  const phaseListeners = new Set<(phase: StreamPhase) => void>();
  let source: EventSourceLike | null = null;
  let online = false;
  let phase: StreamPhase = "connecting";
  let closePending = false;

  const setOnline = (value: boolean) => {
    online = value;
    for (const fn of statusListeners) fn(value);
  };

  const setPhase = (next: StreamPhase) => {
    phase = next;
    setOnline(next === "online");
    for (const fn of phaseListeners) fn(next);
  };

  const close = () => {
    closePending = false;
    if (source) {
      source.onopen = null;
      source.onerror = null;
      source.close();
      source = null;
    }
    setPhase("connecting");
  };

  const ensure = () => {
    closePending = false;
    if (source) return;
    const current = createSource();
    if (!current) return;
    source = current;
    current.onopen = () => {
      if (source === current) setPhase("online");
    };
    current.onerror = () => {
      if (source === current) setPhase("offline");
    };
    current.addEventListener("event", (msg) => {
      if (source !== current) return;
      let parsed: TEvent;
      try {
        parsed = JSON.parse(msg.data) as TEvent;
      } catch {
        return;
      }
      for (const fn of listeners) fn(parsed);
    });
  };

  const scheduleCloseIfEmpty = () => {
    if (listeners.size > 0 || statusListeners.size > 0 || phaseListeners.size > 0 || !source || closePending) return;
    closePending = true;
    queueMicrotask(() => {
      if (!closePending) return;
      closePending = false;
      if (listeners.size === 0 && statusListeners.size === 0 && phaseListeners.size === 0) close();
    });
  };

  return {
    subscribeEvents(fn: (event: TEvent) => void) {
      ensure();
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
        scheduleCloseIfEmpty();
      };
    },
    subscribeStatus(fn: (online: boolean) => void) {
      ensure();
      fn(online);
      statusListeners.add(fn);
      return () => {
        statusListeners.delete(fn);
        scheduleCloseIfEmpty();
      };
    },
    subscribePhase(fn: (next: StreamPhase) => void) {
      ensure();
      fn(phase);
      phaseListeners.add(fn);
      return () => {
        phaseListeners.delete(fn);
        scheduleCloseIfEmpty();
      };
    },
    close,
    isOnline: () => online,
    getPhase: () => phase,
  };
}
