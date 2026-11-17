import type { AppRoleId, LoginResponse, SessionUser } from "@corelogistics/contracts";
import { useCallback, useEffect, useState } from "react";
import { api, clearSession, setActor } from "./api.js";
import { closeSource } from "./live.js";

const APP_PORTS: Record<AppRoleId, number> = { tower: 5180, gate: 5181, warehouse: 5182, driver: 5183 };
const APP_PATHS: Record<AppRoleId, string> = { tower: "/", gate: "/gate/", warehouse: "/warehouse/", driver: "/driver/" };
const ROLE_ROUTING = (import.meta as { env?: { VITE_ROLE_ROUTING?: string } }).env?.VITE_ROLE_ROUTING;

const DEMO_LOGIN_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_DEMO_ACCOUNTS === "1";

/** Cleared on sign-out so the phone notice shows again at the next login. */
export const DESK_NOTICE_KEY = "corelogistics:desk-notice";

export const DEMO_ACCOUNTS = DEMO_LOGIN_ENABLED
  ? [
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
    ]
  : [];

function appUrl(role: AppRoleId): string {
  if (ROLE_ROUTING === "path") {
    return `${window.location.origin}${APP_PATHS[role]}`;
  }
  const port = APP_PORTS[role];
  return `${window.location.protocol}//${window.location.hostname}:${port}/`;
}

function goToRole(role: AppRoleId) {
  window.location.assign(appUrl(role));
}

export function useAuth(home: AppRoleId) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => {
      closeSource();
      clearSession();
      setActor("");
      setUser(null);
      setReady(true);
    };
    window.addEventListener("corelogistics:unauthorized", onUnauthorized);
    return () => window.removeEventListener("corelogistics:unauthorized", onUnauthorized);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .get<SessionUser>("/auth/me")
      .then((me) => {
        if (cancelled) return;
        setActor(me.name);
        if (me.role !== home) {
          goToRole(me.role);
          return;
        }
        setUser(me);
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        closeSource();
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
      setActor(res.user.name);
      if (res.user.role !== home) {
        goToRole(res.user.role);
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
      /* still clear local UI state */
    }
    closeSource();
    clearSession();
    setActor("");
    sessionStorage.removeItem(DESK_NOTICE_KEY);
    setUser(null);
  }, []);

  return { user, ready, signIn, signOut };
}
