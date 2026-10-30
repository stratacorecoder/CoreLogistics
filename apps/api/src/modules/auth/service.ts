import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { LoginInput, SessionUser } from "@corelogistics/contracts";
import type { FastifyRequest } from "fastify";
import { many, newId, nowIso, one, run } from "../../db.js";
import { unauthorized } from "../../errors.js";

const SESSION_DAYS = 7;

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

export function upsertUser(input: {
  username: string;
  password: string;
  name: string;
  role: SessionUser["role"];
  driverId?: string | null;
}): SessionUser {
  const username = input.username.toLowerCase();
  const existing = userByUsername(username);
  if (existing) {
    run("UPDATE users SET name = ?, role = ?, driver_id = ?, password_hash = ? WHERE id = ?", [
      input.name,
      input.role,
      input.driverId ?? null,
      hashPassword(input.password),
      existing.id,
    ]);
    return userById(existing.id)!;
  }
  const id = newId("usr");
  run(
    "INSERT INTO users (id, username, password_hash, name, role, driver_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, username, hashPassword(input.password), input.name, input.role, input.driverId ?? null, nowIso()],
  );
  return userById(id)!;
}

export function login(input: LoginInput): { token: string; user: SessionUser } {
  const row = userByUsername(input.username.trim());
  if (!row || !verifyPassword(input.password, row.password_hash)) throw unauthorized("Wrong username or password");
  const token = randomBytes(24).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
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

export function tokenOf(req: FastifyRequest): string | undefined {
  const header = req.headers["x-session"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return undefined;
}

export function logout(token: string | undefined | null) {
  if (token) run("DELETE FROM sessions WHERE token = ?", [token]);
}

export function listUsers(): SessionUser[] {
  return many<UserRow>("SELECT * FROM users ORDER BY role, name").map(toUser);
}
