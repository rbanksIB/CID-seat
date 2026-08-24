import Link from "next/link";
import { getActingAdmin, getAllAdmins } from "@/lib/actor";
import type { Admin } from "@/lib/db";
import { authEnforced } from "@/lib/easyAuth";
import { ActingAsPicker } from "./admin/ActingAsPicker";

// Shared header + main container used by both /admin and /exams routes.
// Keeps navigation identical across the app.
export default async function AdminChrome({
  children,
}: {
  children: React.ReactNode;
}) {
  const current = await getActingAdmin();

  return (
    <>
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link
            href="/admin"
            className="flex items-baseline gap-2 text-lg font-semibold"
            title="Exam Marking & Moderation App"
          >
            <span>EMMA</span>
            <span className="hidden text-xs font-normal text-slate-500 sm:inline">
              Exam Marking &amp; Moderation App
            </span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/admin" className="text-slate-600 hover:text-slate-900">
              Dashboard
            </Link>
            <Link href="/exams" className="text-slate-600 hover:text-slate-900">
              Exams
            </Link>
            <Link
              href="/admin/programmes"
              className="text-slate-600 hover:text-slate-900"
            >
              Programmes
            </Link>
            <Link
              href="/admin/admins"
              className="text-slate-600 hover:text-slate-900"
            >
              Admin users
            </Link>
            <Link
              href="/admin/emails"
              className="text-slate-600 hover:text-slate-900"
            >
              Email log
            </Link>
            <Identity current={current} />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        {authEnforced() && !current ? <NotAuthorised /> : children}
      </main>
    </>
  );
}

// Signed-in name once Easy Auth is enforcing, the acting-as picker before
// then. The admin list is only needed by the picker.
async function Identity({ current }: { current: Admin | null }) {
  if (authEnforced()) {
    if (!current) return null;
    return <span className="text-xs text-slate-500">{current.name}</span>;
  }

  const admins = await getAllAdmins();
  return (
    <ActingAsPicker
      admins={admins.map((a) => ({ id: a.id, name: a.name }))}
      currentId={current?.id ?? null}
    />
  );
}

function NotAuthorised() {
  return (
    <div className="rounded border border-amber-300 bg-amber-50 p-6">
      <h1 className="text-lg font-semibold">Not authorised</h1>
      <p className="mt-2 text-sm text-slate-700">
        You are signed in, but your account is not on the EMMA admin list. Ask
        an existing admin to add you.
      </p>
    </div>
  );
}
