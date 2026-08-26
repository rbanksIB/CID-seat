"use server";

import { revalidatePath } from "next/cache";
import { query, queryOne, type Programme, PROGRAMME_LEVELS } from "@/lib/db";
import { requireAdmin } from "@/lib/actor";

function parseLevel(v: FormDataEntryValue | null): "MSc" | "MBA" | "BSc" {
  const s = String(v ?? "").trim();
  if (PROGRAMME_LEVELS.includes(s as (typeof PROGRAMME_LEVELS)[number])) {
    return s as "MSc" | "MBA" | "BSc";
  }
  throw new Error("Level must be one of MSc, MBA or BSc");
}

export async function createProgrammeAction(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const programmeId = String(formData.get("programme_id") ?? "").trim();
  const level = parseLevel(formData.get("level"));
  if (!name) throw new Error("Programme name is required");
  if (!programmeId) throw new Error("Programme ID is required");

  const existing = await queryOne<{ id: number }>(
    "SELECT id FROM programmes WHERE lower(programme_id) = lower($1)",
    [programmeId],
  );
  if (existing) {
    throw new Error(
      `A programme with ID "${programmeId}" already exists`,
    );
  }

  await query(
    "INSERT INTO programmes (name, programme_id, level) VALUES ($1, $2, $3)",
    [name, programmeId, level],
  );
  revalidatePath("/admin/programmes");
}

export async function updateProgrammeAction(
  id: number,
  formData: FormData,
) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const programmeId = String(formData.get("programme_id") ?? "").trim();
  const level = parseLevel(formData.get("level"));
  if (!name) throw new Error("Programme name is required");
  if (!programmeId) throw new Error("Programme ID is required");

  const clash = await queryOne<{ id: number }>(
    "SELECT id FROM programmes WHERE lower(programme_id) = lower($1) AND id <> $2",
    [programmeId, id],
  );
  if (clash) {
    throw new Error(
      `Another programme with ID "${programmeId}" already exists`,
    );
  }

  await query(
    "UPDATE programmes SET name = $1, programme_id = $2, level = $3 WHERE id = $4",
    [name, programmeId, level, id],
  );
  revalidatePath("/admin/programmes");
}

export async function deleteProgrammeAction(id: number, formData: FormData) {
  await requireAdmin();
  const prog = await queryOne<Programme>(
    "SELECT * FROM programmes WHERE id = $1",
    [id],
  );
  if (!prog) return;
  const typed = String(formData.get("confirm_name") ?? "").trim();
  if (typed !== prog.name) {
    throw new Error(
      `Type the programme name exactly to confirm deletion. Got "${typed}", expected "${prog.name}".`,
    );
  }
  await query("DELETE FROM programmes WHERE id = $1", [id]);
  revalidatePath("/admin/programmes");
  revalidatePath("/admin");
}
