// Cookie-based "acting as" admin identity for the audit trail. Bridge
// until real authentication ships -- swap this module out then.

import { cookies } from "next/headers";
import { query, queryOne, type Admin } from "@/lib/db";

const COOKIE = "emma_actor_id";

// Reads the acting admin from the cookie. Touches last_access_at when
// found so the Admin users table shows recent activity. Returns null
// when the cookie is missing or points to a deleted admin — never
// falls back to "first admin", because marker requests to /m/ URLs
// also arrive without this cookie and would otherwise be silently
// stamped as an admin override on every save.
export async function getActingAdmin(): Promise<Admin | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  const id = raw ? Number(raw) : NaN;
  if (!Number.isFinite(id)) return null;

  const found = await queryOne<Admin>(
    "SELECT * FROM admins WHERE id = $1",
    [id],
  );
  if (!found) return null;

  // Fire and forget; don't hold up the page render.
  query(
    "UPDATE admins SET last_access_at = now() WHERE id = $1",
    [found.id],
  ).catch(() => {});
  return found;
}

export async function getAllAdmins(): Promise<Admin[]> {
  return await query<Admin>("SELECT * FROM admins ORDER BY name");
}

export async function setActingAdminCookie(id: number): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, String(id), {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}
