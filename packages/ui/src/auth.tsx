import type { AppRoleId, LoginResponse, SessionUser } from "@corelogistics/contracts";
import { useCallback, useEffect, useState } from "react";
import { api, clearSession, getSession, setActor, setSession } from "./api.js";

const APP_PORTS: Record<AppRoleId, number> = { tower: 5180, gate: 5181, warehouse: 5182, driver: 5183 };

const SESSION_QUERY = "session";

export const DEMO_ACCOUNTS = [
  { username: "ava", password: "planner", name: "Ava Chen", role: "tower" as const, title: "Planner" },
  { username: "rico", password: "yard", name: "Rico Santos", role: "gate" as const, title: "Yard guard" },
  { username: "mina", password: "floor", name: "Mina Cruz", role: "warehouse" as const, title: "Floor lead" },
  { username: "jose", password: "drive", name: "Jose Mendoza", role: "driver" as const, title: "Driver" },
  { username: "maria", password: "drive", name: "Maria Garcia", role: "driver" as const, title: "Driver" },
  { username: "ramon", password: "drive", name: "Ramon Bautista", role: "driver" as const, title: "Driver" },
  { username: "liza", password: "drive", name: "Liza Villanueva", role: "driver" as const, title: "Driver" },
  { username: "mark", password: "drive", name: "Mark Aquino", role: "driver" as const, title: "Driver" },
  { username: "grace", password: "drive", name: "Grace Dela Cruz", role: "driver" as const, title: "Driver" },
  { username: "paolo", password: "drive", name: "Paolo Ramos", role: "driver" as const, title: "Driver" },
  { username: "nina", password: "drive", name: "Nina Flores", role: "driver" as const, title: "Driver" },
];

function takeSessionFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const token = (params.get(SESSION_QUERY) ?? "").trim();
  if (!token) return getSession();
  setSession(token);
  params.delete(SESSION_QUERY);
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  return token;
}

function appUrl(role: AppRoleId, token: string): string {
  const port = APP_PORTS[role];
  return `${window.location.protocol}//${window.location.hostname}:${port}/?${SESSION_QUERY}=${encodeURIComponent(token)}`;
}

function goToRole(role: AppRoleId, token: string) {
  window.location.assign(appUrl(role, token));
}

export function useAuth(home: AppRoleId) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const token = takeSessionFromUrl();
    if (!token) {
      setReady(true);
      return;
    }
    api
      .get<SessionUser>("/auth/me")
      .then((me) => {
        if (cancelled) return;
        setActor(me.name);
        if (me.role !== home) {
          goToRole(me.role, token);
          return;
        }
        setUser(me);
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        clearSession();
        setActor("");
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [home]);

  const signIn = useCallback(
    async (username: string, password: string) => {
      const res = await api.post<LoginResponse>("/auth/login", { username, password });
      setSession(res.token);
      setActor(res.user.name);
      if (res.user.role !== home) {
        goToRole(res.user.role, res.token);
        return;
      }
      setUser(res.user);
    },
    [home],
  );

  const signOut = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      /* still clear local session */
    }
    clearSession();
    setActor("");
    setUser(null);
  }, []);

  return { user, ready, signIn, signOut };
}
