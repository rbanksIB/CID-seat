"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, setActingAdminCookie } from "@/lib/actor";

export async function setActingAdminAction(id: number) {
  await requireAdmin();
  await setActingAdminCookie(id);
  revalidatePath("/admin");
}
