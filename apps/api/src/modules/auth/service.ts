import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { LoginInput, SessionUser } from "@corelogistics/contracts";
import type { FastifyRequest } from "fastify";
import { many, newId, nowIso, one, run } from "../../db.js";
import { HttpError, unauthorized } from "../../errors.js";

const SESSION_DAYS = 7;
export const SESSION_COOKIE_NAME = "cl_session";
export const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SESSION_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 10;
const failedLogins = new Map<string, { count: number; resetAt: number }>();
let lastSessionPruneMs = 0;

function loginThrottleKey(ip: string | undefined, username: string): string {
  return `${ip || "local"}:${username.trim().toLowerCase()}`;
}

function pruneThrottle(now: number) {
  if (failedLogins.size < 100) return;
  for (const [k, entry] of failedLogins) {
    if (entry.resetAt <= now) failedLogins.delete(k);
  }
}

export function pruneExpiredSessions(now = nowIso()): number {
  return Number(run("DELETE FROM sessions WHERE expires_at < ?", [now]).changes);
}

function checkLoginThrottle(key: string, now: number) {
  const entry = failedLogins.get(key);
  if (!entry) return;
  if (entry.resetAt <= now) {
    failedLogins.delete(key);
    return;
  }
  if (entry.count >= MAX_FAILED_LOGINS) {
    throw new HttpError(429, "Too many failed sign-in attempts; try again later");
  }
}

function recordFailedLogin(key: string, now: number) {
  pruneThrottle(now);
  const entry = failedLogins.get(key);
  if (!entry || entry.resetAt <= now) {
    failedLogins.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  failedLogins.set(key, { count: entry.count + 1, resetAt: entry.resetAt });
}

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  name: string;
  role: SessionUser["role"];
  driver_id: string | null;
};

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const next = scryptSync(password, salt, 32);
  const prev = Buffer.from(hash, "hex");
  if (prev.length !== next.length) return false;
  return timingSafeEqual(prev, next);
}

function toUser(row: UserRow): SessionUser {
  return { id: row.id, username: row.username, name: row.name, role: row.role, driverId: row.driver_id };
}

export function userById(id: string): SessionUser | undefined {
  const row = one<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  return row ? toUser(row) : undefined;
}

export function userByUsername(username: string): UserRow | undefined {
  return one<UserRow>("SELECT * FROM users WHERE username = ?", [username.toLowerCase()]);
}

export function upsertUser(
  input: {
    username: string;
    password: string;
    name: string;
    role: SessionUser["role"];
    driverId?: string | null;
  },
  opts: { overwritePassword?: boolean } = {},
): SessionUser {
  const username = input.username.toLowerCase();
  const existing = userByUsername(username);
  if (existing) {
    if (opts.overwritePassword) {
      run("UPDATE users SET name = ?, role = ?, driver_id = ?, password_hash = ? WHERE id = ?", [
        input.name,
        input.role,
        input.driverId ?? null,
        hashPassword(input.password),
        existing.id,
      ]);
    } else {
      run("UPDATE users SET name = ?, role = ?, driver_id = ? WHERE id = ?", [
        input.name,
        input.role,
        input.driverId ?? null,
        existing.id,
      ]);
    }
    return userById(existing.id)!;
  }
  const id = newId("usr");
  run(
    "INSERT INTO users (id, username, password_hash, name, role, driver_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, username, hashPassword(input.password), input.name, input.role, input.driverId ?? null, nowIso()],
  );
  return userById(id)!;
}

export function login(input: LoginInput, ip?: string): { token: string; user: SessionUser } {
  const now = Date.now();
  if (now - lastSessionPruneMs >= SESSION_PRUNE_INTERVAL_MS) {
    lastSessionPruneMs = now;
    pruneExpiredSessions(new Date(now).toISOString());
  }
  const key = loginThrottleKey(ip, input.username);
  checkLoginThrottle(key, now);
  const row = userByUsername(input.username.trim());
  if (!row || !verifyPassword(input.password, row.password_hash)) {
    recordFailedLogin(key, now);
    throw unauthorized("Wrong username or password");
  }
  failedLogins.delete(key);
  const token = randomBytes(24).toString("base64url");
  const expires = new Date(now + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", [token, row.id, expires]);
  return { token, user: toUser(row) };
}

export function sessionUser(token: string | undefined | null): SessionUser | undefined {
  if (!token) return undefined;
  const row = one<UserRow & { expires_at: string }>(
    `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    [token],
  );
  if (!row) return undefined;
  if (Date.parse(row.expires_at) < Date.now()) {
    run("DELETE FROM sessions WHERE token = ?", [token]);
    return undefined;
  }
  return toUser(row);
}

export type AuthToken = { token?: string; via: "header" | "cookie" | null };

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  const joined = Array.isArray(raw) ? raw.join("; ") : raw;
  for (const part of joined.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const rawVal = part.slice(idx + 1).trim();
    if (!rawVal) return undefined;
    try {
      return decodeURIComponent(rawVal);
    } catch {
      return rawVal;
    }
  }
  return undefined;
}

export function authTokenOf(req: FastifyRequest): AuthToken {
  const header = req.headers["x-session"];
  if (typeof header === "string" && header.trim()) return { token: header.trim(), via: "header" };
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return { token, via: "header" };
  }
  const cookie = readCookie(req, SESSION_COOKIE_NAME);
  if (cookie) return { token: cookie, via: "cookie" };
  return { via: null };
}

export function tokenOf(req: FastifyRequest): string | undefined {
  return authTokenOf(req).token;
}

export function buildSessionCookie(token: string, req: FastifyRequest, maxAgeSeconds = SESSION_MAX_AGE_SECONDS): string {
  const secure = req.protocol === "https" ? "; Secure" : "";
  const value = maxAgeSeconds <= 0 ? "" : encodeURIComponent(token);
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function logout(token: string | undefined | null) {
  if (token) run("DELETE FROM sessions WHERE token = ?", [token]);
}

export function listUsers(): SessionUser[] {
  return many<UserRow>("SELECT * FROM users ORDER BY role, name").map(toUser);
}
