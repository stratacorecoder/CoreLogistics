function defaultApiUrl(): string {
  if (typeof window !== "undefined" && window.location?.hostname) {
    return `${window.location.protocol}//${window.location.hostname}:3100`;
  }
  return "http://localhost:3100";
}

export const API_URL: string =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL || defaultApiUrl();

const ACTOR_KEY = "corelogistics.actor";

export function getActor(): string {
  return localStorage.getItem(ACTOR_KEY) ?? "";
}

export function setActor(name: string) {
  localStorage.setItem(ACTOR_KEY, name);
  window.dispatchEvent(new CustomEvent("corelogistics:actor", { detail: name }));
}

export function clearSession() {
  localStorage.removeItem(ACTOR_KEY);
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const actor = getActor();
  if (actor) headers["x-actor"] = encodeURIComponent(actor);
  const res = await fetch(`${API_URL}${path}`, {
    method,
    credentials: "include",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== "/auth/login" && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("corelogistics:unauthorized"));
    }
    throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!entries.length) return "";
  return `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")}`;
}
