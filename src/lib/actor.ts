// Admin identity for the audit trail. Resolved from Easy Auth once
// EMMA_REQUIRE_AUTH is on; the cookie-based "acting as" bridge until then.

import { cookies, headers } from "next/headers";
import { query, queryOne, type Admin } from "@/lib/db";
import {
  PRINCIPAL_CLAIMS_HEADER,
  PRINCIPAL_HEADER,
  authEnforced,
} from "@/lib/easyAuth";

const COOKIE = "emma_actor_id";

// Reads the signed-in admin, or the acting-as cookie before Easy Auth is
// enforcing. Touches last_access_at when found so the Admin users table
// shows recent activity. Returns null when there is no admin identity —
// never falls back to "first admin", because marker requests to /m/ URLs
// also arrive without one and would otherwise be silently stamped as an
// admin override on every save.
export async function getActingAdmin(): Promise<Admin | null> {
  const found = authEnforced() ? await fromSignIn() : await fromCookie();
  if (!found) return null;

  // Fire and forget; don't hold up the page render.
  query(
    "UPDATE admins SET last_access_at = now() WHERE id = $1",
    [found.id],
  ).catch(() => {});
  return found;
}

// Authorisation check for API routes, which bypass the layout. Inert until
// EMMA_REQUIRE_AUTH is on.
export async function adminAllowed(): Promise<boolean> {
  return !authEnforced() || (await getActingAdmin()) !== null;
}

// Server actions are public endpoints, so they authorise individually rather
// than relying on the layout or middleware. Inert until EMMA_REQUIRE_AUTH.
export async function requireAdmin(): Promise<void> {
  if (!(await adminAllowed())) throw new Error("Not authorised");
}

async function fromCookie(): Promise<Admin | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  const id = raw ? Number(raw) : NaN;
  if (!Number.isFinite(id)) return null;

  const found = await queryOne<Admin>(
    "SELECT * FROM admins WHERE id = $1",
    [id],
  );
  return found ?? null;
}

async function fromSignIn(): Promise<Admin | null> {
  const candidates = await signedInEmails();
  if (candidates.length === 0) return null;

  const found = await queryOne<Admin>(
    "SELECT * FROM admins WHERE lower(email) = ANY($1::text[])",
    [candidates],
  );
  return found ?? null;
}

// Claim types that can carry an address. A UPN and a mail address are often
// different strings, so match the admins table against any of them. Only
// safe while the registration is single-tenant.
// TODO: key on the immutable oid claim instead.
const EMAIL_CLAIMS = new Set([
  "email",
  "preferred_username",
  "upn",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
]);

// Off Azure there is no Easy Auth in front of the app, so local development
// falls back to EMMA_DEV_ADMIN_EMAIL. The NODE_ENV check is a hard gate: in
// production a missing header must never resolve to an identity.
async function signedInEmails(): Promise<string[]> {
  const h = await headers();
  const found = new Set<string>();

  for (const claim of decodeClaims(h.get(PRINCIPAL_CLAIMS_HEADER))) {
    if (EMAIL_CLAIMS.has(claim.typ) && claim.val.includes("@")) {
      found.add(claim.val.trim().toLowerCase());
    }
  }

  const name = h.get(PRINCIPAL_HEADER)?.trim();
  if (name?.includes("@")) found.add(name.toLowerCase());

  if (found.size === 0 && process.env.NODE_ENV !== "production") {
    const dev = process.env.EMMA_DEV_ADMIN_EMAIL?.trim().toLowerCase();
    if (dev) found.add(dev);
  }

  return [...found];
}

function decodeClaims(encoded: string | null): { typ: string; val: string }[] {
  if (!encoded) return [];
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    return Array.isArray(parsed?.claims) ? parsed.claims : [];
  } catch {
    return [];
  }
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
