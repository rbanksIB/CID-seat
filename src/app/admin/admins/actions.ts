"use server";

import { revalidatePath } from "next/cache";
import { query, queryOne, type Admin } from "@/lib/db";
import { requireAdmin } from "@/lib/actor";

function parseEmail(v: FormDataEntryValue | null): string {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    throw new Error("Please provide a valid email address");
  }
  return s;
}

export async function createAdminAction(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const email = parseEmail(formData.get("email"));
  if (!name) throw new Error("Name is required");

  const existing = await queryOne<{ id: number }>(
    "SELECT id FROM admins WHERE lower(email) = lower($1)",
    [email],
  );
  if (existing) throw new Error(`An admin with email "${email}" already exists`);

  await query("INSERT INTO admins (email, name) VALUES ($1, $2)", [
    email,
    name,
  ]);
  revalidatePath("/admin/admins");
}

export async function updateAdminAction(id: number, formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const email = parseEmail(formData.get("email"));
  if (!name) throw new Error("Name is required");

  const clash = await queryOne<{ id: number }>(
    "SELECT id FROM admins WHERE lower(email) = lower($1) AND id <> $2",
    [email, id],
  );
  if (clash) throw new Error(`Another admin already has email "${email}"`);

  await query("UPDATE admins SET name = $1, email = $2 WHERE id = $3", [
    name,
    email,
    id,
  ]);
  revalidatePath("/admin/admins");
}

export async function deleteAdminAction(id: number, formData: FormData) {
  await requireAdmin();
  const admin = await queryOne<Admin>(
    "SELECT * FROM admins WHERE id = $1",
    [id],
  );
  if (!admin) return;

  const countRow = await queryOne<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM admins",
  );
  if ((countRow?.n ?? 0) <= 1) {
    throw new Error(
      "There must always be at least one admin. Add another admin before deleting this one.",
    );
  }

  const typed = String(formData.get("confirm_name") ?? "").trim();
  if (typed !== admin.name) {
    throw new Error(
      `Type the admin's name exactly to confirm deletion. Got "${typed}", expected "${admin.name}".`,
    );
  }

  await query("DELETE FROM admins WHERE id = $1", [id]);
  revalidatePath("/admin/admins");
}
