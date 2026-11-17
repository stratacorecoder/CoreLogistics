import type { EventRecord } from "@corelogistics/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, API_URL } from "./api.js";
import { createReloadScheduler, createSourceManager, type EventSourceLike, type StreamPhase } from "./live-controller.js";

export type { StreamPhase };
type Listener = (e: EventRecord) => void;

function openStream(): EventSourceLike | null {
  if (typeof EventSource === "undefined") return null;
  const es = new EventSource(`${API_URL}/stream`, { withCredentials: true });
  return {
    get onopen() {
      return es.onopen as (() => void) | null;
    },
    set onopen(fn) {
      es.onopen = fn;
    },
    get onerror() {
      return es.onerror as (() => void) | null;
    },
    set onerror(fn) {
      es.onerror = fn;
    },
    addEventListener(type, fn) {
      es.addEventListener(type, (msg) => fn({ data: String((msg as MessageEvent).data ?? "") }));
    },
    close() {
      es.close();
    },
  };
}

const sourceManager = createSourceManager<EventRecord>(openStream);

/** Closes the shared SSE connection (for example on sign-out). */
export function closeSource() {
  sourceManager.close();
}

/** Subscribes to the shared SSE connection for the lifetime of the component while enabled. */
export function useLiveEvents(onEvent: Listener, enabled = true) {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => {
    if (!enabled) return;
    return sourceManager.subscribeEvents((e) => ref.current(e));
  }, [enabled]);
}

export function useStreamStatus(): boolean {
  const [state, setState] = useState(() => sourceManager.isOnline());
  useEffect(() => sourceManager.subscribeStatus(setState), []);
  return state;
}

/** Connecting until the first open or error, then online or offline. */
export function useStreamPhase(): StreamPhase {
  const [state, setState] = useState<StreamPhase>(() => sourceManager.getPhase());
  useEffect(() => sourceManager.subscribePhase(setState), []);
  return state;
}

export interface ApiState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

const liveReloaders = new Set<() => void>();

/** Refetch mounted live queries via their coalesced schedulers. */
export function refreshLiveQueries() {
  for (const schedule of liveReloaders) schedule();
}

/**
 * Fetches `path` and refetches as soon as a live event arrives, so every open
 * desk stays current without a manual refresh. Pass `null` to skip.
 */
export function useApi<T>(
  path: string | null,
  opts: { live?: boolean | ((e: EventRecord) => boolean); intervalMs?: number } = {},
): ApiState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const pathRef = useRef(path);
  pathRef.current = path;
  const seq = useRef(0);
  const hasData = useRef(false);

  const load = useCallback(() => {
    const target = pathRef.current;
    if (!target) return Promise.resolve();
    const mine = ++seq.current;
    if (!hasData.current) setLoading(true);
    return api
      .get<T>(target)
      .then((d) => {
        if (mine !== seq.current) return;
        hasData.current = true;
        setData(d);
        setError(null);
      })
      .catch((err: Error) => {
        if (mine === seq.current) setError(err.message);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, []);

  const schedulerRef = useRef<ReturnType<typeof createReloadScheduler> | null>(null);
  if (!schedulerRef.current) {
    schedulerRef.current = createReloadScheduler(() => load());
  }
  const scheduler = schedulerRef.current;

  useEffect(() => {
    seq.current += 1;
    scheduler.reset();
    hasData.current = false;
    setData(undefined);
    setError(null);
    setLoading(Boolean(path));
    if (path) scheduler.flushNow();
    return () => {
      seq.current += 1;
      scheduler.reset();
    };
  }, [path, scheduler]);

  const live = opts.live ?? true;
  const liveRef = useRef(live);
  liveRef.current = live;
  const followLive = Boolean(path) && live !== false;

  useEffect(() => {
    if (!followLive) return;
    liveReloaders.add(scheduler.schedule);
    return () => {
      liveReloaders.delete(scheduler.schedule);
    };
  }, [followLive, scheduler]);

  useEffect(() => {
    if (!path || !opts.intervalMs) return;
    const id = setInterval(scheduler.schedule, opts.intervalMs);
    return () => clearInterval(id);
  }, [path, opts.intervalMs, scheduler]);

  useLiveEvents((e) => {
    const current = liveRef.current;
    if (!current || (typeof current === "function" && !current(e))) return;
    scheduler.schedule();
  }, followLive);

  useEffect(() => {
    if (!followLive) return;
    const onShow = () => {
      if (document.visibilityState === "visible") scheduler.schedule();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [followLive, scheduler]);

  const reload = useCallback(() => {
    if (pathRef.current) scheduler.flushNow();
  }, [scheduler]);

  return { data, error, loading, reload };
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = localStorage.getItem(key);
    if (raw === null) return initial;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      localStorage.setItem(key, JSON.stringify(v));
    },
    [key],
  );
  return [value, set];
}

/** Wraps a mutation with busy and error state plus a success toast. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T>(fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | undefined> => {
    setBusy(true);
    try {
      const result = await fn();
      refreshLiveQueries();
      if (success) toast(typeof success === "function" ? success(result) : success, "ok");
      return result;
    } catch (err) {
      toast((err as Error).message, "error");
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

export interface ToastItem {
  id: number;
  text: string;
  tone: "ok" | "error" | "info";
}
const toastListeners = new Set<(items: ToastItem[]) => void>();
let toasts: ToastItem[] = [];
let toastSeq = 0;

export function toast(text: string, tone: ToastItem["tone"] = "info") {
  const item = { id: ++toastSeq, text, tone };
  toasts = [...toasts, item].slice(-4);
  for (const fn of toastListeners) fn(toasts);
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== item.id);
    for (const fn of toastListeners) fn(toasts);
  }, tone === "error" ? 6000 : 3500);
}

export function useToasts(): ToastItem[] {
  const [items, setItems] = useState(toasts);
  useEffect(() => {
    toastListeners.add(setItems);
    return () => {
      toastListeners.delete(setItems);
    };
  }, []);
  return items;
}
