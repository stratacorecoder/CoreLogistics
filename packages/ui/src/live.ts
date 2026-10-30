import type { EventRecord } from "@corelogistics/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, API_URL } from "./api.js";

type Listener = (e: EventRecord) => void;
const listeners = new Set<Listener>();
const statusListeners = new Set<(online: boolean) => void>();
let source: EventSource | null = null;
let online = false;

function setOnline(v: boolean) {
  online = v;
  for (const fn of statusListeners) fn(v);
}

function ensureSource() {
  if (source) return;
  source = new EventSource(`${API_URL}/stream`);
  source.onopen = () => setOnline(true);
  source.onerror = () => setOnline(false);
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

export interface ApiState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetches `path` and refetches whenever a live event arrives (debounced), so
 * every screen stays current without manual refresh. Pass `null` to skip.
 */
export function useApi<T>(
  path: string | null,
  opts: { live?: boolean | ((e: EventRecord) => boolean); intervalMs?: number } = {},
): ApiState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(() => {
    if (!path) return;
    const mine = ++seq.current;
    setLoading(true);
    api
      .get<T>(path)
      .then((d) => {
        if (mine !== seq.current) return;
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
    setData(undefined);
    load();
  }, [load]);

  useEffect(() => {
    if (!opts.intervalMs) return;
    const id = setInterval(load, opts.intervalMs);
    return () => clearInterval(id);
  }, [load, opts.intervalMs]);

  const live = opts.live ?? true;
  useLiveEvents((e) => {
    if (!live || (typeof live === "function" && !live(e))) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 250);
  });

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
