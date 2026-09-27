// 会话认证：HMAC 签名的 httpOnly Cookie
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { q1, hashPassword } from "./db";

const SECRET = process.env.MCARE_SECRET || "mcare-dev-secret-change-me";
const COOKIE = "mcare_session";
const TTL_MS = 1000 * 60 * 60 * 12; // 12小时

export type SessionUser = {
  id: number;
  username: string;
  name: string;
  role: string;
};

function sign(payload: string): string {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
}

export function verifyLogin(username: string, password: string): SessionUser | null {
  const u = q1("SELECT * FROM users WHERE username=? AND active=1", username);
  if (!u) return null;
  const hash = hashPassword(password, String(u.salt));
  if (hash !== String(u.password_hash)) return null;
  return { id: Number(u.id), username: String(u.username), name: String(u.name), role: String(u.role) };
}

export function makeToken(user: SessionUser): string {
  const payload = Buffer.from(
    JSON.stringify({ id: user.id, username: user.username, name: user.name, role: user.role, exp: Date.now() + TTL_MS })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function parseToken(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (sign(payload) !== sig) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!obj.exp || Date.now() > obj.exp) return null;
    return { id: obj.id, username: obj.username, name: obj.name, role: obj.role };
  } catch {
    return null;
  }
}

export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  return parseToken(store.get(COOKIE)?.value);
}

export async function setSessionCookie(user: SessionUser) {
  const store = await cookies();
  store.set(COOKIE, makeToken(user), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: TTL_MS / 1000,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(COOKIE);
}

export const COOKIE_NAME = COOKIE;
