import type { EventRecord } from "@corelogistics/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, API_URL } from "./api.js";

type Listener = (e: EventRecord) => void;
const listeners = new Set<Listener>();
const statusListeners = new Set<(online: boolean) => void>();
let source: EventSource | null = null;
let online = false;
export type StreamPhase = "connecting" | "online" | "offline";
let phase: StreamPhase = "connecting";
const phaseListeners = new Set<(next: StreamPhase) => void>();

function setOnline(v: boolean) {
  online = v;
  for (const fn of statusListeners) fn(v);
}

function setPhase(next: StreamPhase) {
  phase = next;
  setOnline(next === "online");
  for (const fn of phaseListeners) fn(next);
}

function ensureSource() {
  if (source) return;
  source = new EventSource(`${API_URL}/stream`);
  source.onopen = () => setPhase("online");
  source.onerror = () => setPhase("offline");
  source.addEventListener("event", (msg) => {
    const e = JSON.parse((msg as MessageEvent).data) as EventRecord;
    for (const fn of listeners) fn(e);
  });
}

/** Subscribes to the shared SSE connection for the lifetime of the component. */
export function useLiveEvents(onEvent: Listener) {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => {
    ensureSource();
    const fn: Listener = (e) => ref.current(e);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
}

export function useStreamStatus(): boolean {
  const [state, setState] = useState(online);
  useEffect(() => {
    ensureSource();
    statusListeners.add(setState);
    return () => {
      statusListeners.delete(setState);
    };
  }, []);
  return state;
}

/** Connecting until the first open or error, then online or offline. */
export function useStreamPhase(): StreamPhase {
  const [state, setState] = useState(phase);
  useEffect(() => {
    ensureSource();
    phaseListeners.add(setState);
    setState(phase);
    return () => {
      phaseListeners.delete(setState);
    };
  }, []);
  return state;
}

export interface ApiState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

const reloaders = new Set<() => void>();

/** Refetch every mounted query. Used after the operator's own action. */
export function refreshLiveQueries() {
  for (const load of reloaders) load();
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
  const seq = useRef(0);
  const hasData = useRef(false);
  const queued = useRef(false);

  const load = useCallback(() => {
    if (!path) return;
    const mine = ++seq.current;
    if (!hasData.current) setLoading(true);
    api
      .get<T>(path)
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
  }, [path]);

  useEffect(() => {
    hasData.current = false;
    setData(undefined);
    load();
  }, [load]);

  useEffect(() => {
    reloaders.add(load);
    return () => {
      reloaders.delete(load);
    };
  }, [load]);

  useEffect(() => {
    if (!opts.intervalMs) return;
    const id = setInterval(load, opts.intervalMs);
    return () => clearInterval(id);
  }, [load, opts.intervalMs]);

  const live = opts.live ?? true;
  const liveRef = useRef(live);
  liveRef.current = live;

  const schedule = useCallback(() => {
    if (queued.current) return;
    queued.current = true;
    queueMicrotask(() => {
      queued.current = false;
      load();
    });
  }, [load]);

  useLiveEvents((e) => {
    const current = liveRef.current;
    if (!current || (typeof current === "function" && !current(e))) return;
    schedule();
  });

  const followLive = live !== false;
  useEffect(() => {
    if (!followLive) return;
    const onShow = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [load, followLive]);

  return { data, error, loading, reload: load };
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
