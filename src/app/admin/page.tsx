import Link from "next/link";
import { headers } from "next/headers";
import {
  EXAM_STATUS_LABEL,
  query,
  queryOne,
  type ExamStatus,
} from "@/lib/db";
import { STATUS_BADGE_CLASS } from "@/lib/examStatus";
import { sweepDeadlineStatuses } from "@/lib/deadlines";
import {
  formatDate,
  formatDateOnly,
  formatDateTime as formatDateTimeUk,
} from "@/lib/datetime";

export const dynamic = "force-dynamic";

async function getOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

type UpcomingRow = {
  id: number;
  name: string;
  code: string | null;
  deadline: string; // YYYY-MM-DD
  marker_name: string | null;
  role: "primary" | "secondary";
};

type OverdueRow = {
  id: number;
  name: string;
  code: string | null;
  status: ExamStatus;
  deadline: string | null;
  marker_name: string | null;
};

// Calendar-day difference between two 'YYYY-MM-DD' strings.
function daysBetween(fromISO: string, toISO: string): number {
  const from = new Date(`${fromISO}T00:00:00Z`);
  const to = new Date(`${toISO}T00:00:00Z`);
  return Math.floor((to.getTime() - from.getTime()) / 86400000);
}

function todayIsoDate(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA gives YYYY-MM-DD
  return fmt.format(new Date());
}

export default async function AdminDashboard() {
  await sweepDeadlineStatuses({ origin: await getOrigin() });
  const today = todayIsoDate();

  const totalRow = await queryOne<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM exams",
  );
  const examCount = totalRow?.n ?? 0;

  // 5 nearest upcoming primary or secondary deadlines whose exam is
  // currently in the corresponding marking phase and hasn't passed.
  const upcoming = await query<UpcomingRow>(
    `SELECT e.id, e.name, e.code, e.primary_deadline_date AS deadline,
            u.name AS marker_name, 'primary'::text AS role
     FROM exams e
     LEFT JOIN users u ON u.id = e.primary_marker_id
     WHERE e.status = 'primary_marking'
       AND e.primary_deadline_date IS NOT NULL
       AND e.primary_deadline_date >= $1::date
     UNION ALL
     SELECT e.id, e.name, e.code, e.secondary_deadline_date AS deadline,
            u.name AS marker_name, 'secondary'::text AS role
     FROM exams e
     LEFT JOIN users u ON u.id = e.secondary_marker_id
     WHERE e.status = 'secondary_marking'
       AND e.secondary_deadline_date IS NOT NULL
       AND e.secondary_deadline_date >= $1::date
     ORDER BY deadline ASC
     LIMIT 5`,
    [today],
  );

  const overdueByStatus = await query<{ status: ExamStatus; n: number }>(
    `SELECT status, COUNT(*)::int AS n
     FROM exams
     WHERE status IN ('first_marking_overdue','first_marking_late',
                      'second_marking_overdue','second_marking_late')
     GROUP BY status`,
  );
  const countByStatus: Record<string, number> = {};
  for (const row of overdueByStatus) countByStatus[row.status] = row.n;
  const overdueCount =
    (countByStatus.first_marking_overdue ?? 0) +
    (countByStatus.first_marking_late ?? 0) +
    (countByStatus.second_marking_overdue ?? 0) +
    (countByStatus.second_marking_late ?? 0);

  const overdue = await query<OverdueRow>(
    `SELECT e.id, e.name, e.code, e.status,
            CASE
              WHEN e.status IN ('first_marking_overdue','first_marking_late')
                THEN e.primary_deadline_date::text
              ELSE e.secondary_deadline_date::text
            END AS deadline,
            CASE
              WHEN e.status IN ('first_marking_overdue','first_marking_late')
                THEN p.name
              ELSE s.name
            END AS marker_name
     FROM exams e
     LEFT JOIN users p ON p.id = e.primary_marker_id
     LEFT JOIN users s ON s.id = e.secondary_marker_id
     WHERE e.status IN ('first_marking_overdue','first_marking_late',
                        'second_marking_overdue','second_marking_late')
     ORDER BY deadline ASC
     LIMIT 3`,
  );

  return (
    <div className="space-y-8">
      <section className="flex items-start justify-between gap-6">
        <div>
          <p className="flex flex-wrap items-center gap-x-4 text-xs text-slate-500">
            <span>Today: {formatDate(new Date())}</span>
            <span>
              Version:{" "}
              <span className="font-mono">
                {(process.env.APP_COMMIT_SHA ?? "dev").slice(0, 7)}
              </span>
            </span>
            <span>
              Deployed: {formatDateTimeUk(process.env.APP_BUILD_TIME)}
            </span>
          </p>
          <h1 className="mt-1 text-2xl font-bold">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-600">
            Anonymous exam script marking.
          </p>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/imperial-business-school.png"
          alt="Imperial Business School"
          width={300}
          className="h-auto w-[min(300px,35vw)]"
        />
      </section>

      {/* Search + quick links */}
      <section className="grid gap-4 md:grid-cols-[2fr_1fr]">
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-700">Find an exam</h2>
          <form action="/exams" method="get" className="mt-3 flex gap-2">
            <input
              name="q"
              placeholder="Search by exam name or module code…"
              className="flex-1 rounded border px-3 py-2 text-sm"
            />
            <button
              type="submit"
              className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Search
            </button>
          </form>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-700">Quick links</h2>
          <ul className="mt-3 space-y-1 text-sm">
            <li>
              <Link
                href="/exams/create"
                className="text-blue-600 hover:underline"
              >
                + Create new exam
              </Link>
            </li>
            <li>
              <Link href="/exams" className="text-blue-600 hover:underline">
                All exams
              </Link>
            </li>
            <li>
              <Link
                href="/admin/programmes"
                className="text-blue-600 hover:underline"
              >
                Programmes
              </Link>
            </li>
            <li>
              <Link
                href="/admin/admins"
                className="text-blue-600 hover:underline"
              >
                Admin users
              </Link>
            </li>
            <li>
              <Link
                href="/admin/emails"
                className="text-blue-600 hover:underline"
              >
                Email log
              </Link>
            </li>
          </ul>
        </div>
      </section>

      {/* Stats row */}
      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase text-slate-500">
            Exams created
          </p>
          <p className="mt-2 text-3xl font-bold">{examCount}</p>
          <Link
            href="/exams"
            className="mt-1 inline-block text-xs text-blue-600 hover:underline"
          >
            View all exams →
          </Link>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase text-slate-500">
            Marking Overdue or Late
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <OverdueLink
              label="First marking overdue"
              count={countByStatus.first_marking_overdue ?? 0}
              status="first_marking_overdue"
              accent="amber"
            />
            <OverdueLink
              label="First marking late"
              count={countByStatus.first_marking_late ?? 0}
              status="first_marking_late"
              accent="red"
            />
            <OverdueLink
              label="Second marking overdue"
              count={countByStatus.second_marking_overdue ?? 0}
              status="second_marking_overdue"
              accent="amber"
            />
            <OverdueLink
              label="Second marking late"
              count={countByStatus.second_marking_late ?? 0}
              status="second_marking_late"
              accent="red"
            />
          </div>
          <p className="mt-3 text-xs text-slate-500">
            <span className="font-medium">Overdue</span> = 0–4 working days
            beyond deadline
            <br />
            <span className="font-medium">Late</span> = 5+ working days beyond
            deadline
          </p>
        </div>
      </section>

      {/* Upcoming deadlines */}
      <section className="rounded-lg border bg-white shadow-sm">
        <div className="border-b px-4 py-3">
          <h2 className="text-lg font-semibold">Upcoming marking deadlines</h2>
          <p className="text-xs text-slate-500">
            The five earliest primary or secondary deadlines still in the future.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead className="border-b bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-4 py-2">Exam</th>
              <th className="px-4 py-2">Role</th>
              <th className="px-4 py-2">Marker</th>
              <th className="px-4 py-2">Deadline</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {upcoming.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  No upcoming deadlines.
                </td>
              </tr>
            )}
            {upcoming.map((r) => (
              <tr key={`${r.id}-${r.role}`} className="border-b last:border-b-0">
                <td className="px-4 py-3 font-medium">
                  {r.name}
                  {r.code && (
                    <span className="ml-2 text-xs text-slate-500">
                      {r.code}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-600 capitalize">{r.role}</td>
                <td className="px-4 py-3 text-slate-700">
                  {r.marker_name ?? "—"}
                </td>
                <td className="px-4 py-3 text-slate-700">
                  {formatDateOnly(r.deadline)}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/admin/exams/${r.id}`}
                    className="text-blue-600 hover:underline"
                  >
                    Manage →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Longest overdue */}
      {overdueCount > 0 && (
        <section className="rounded-lg border bg-white shadow-sm">
          <div className="border-b px-4 py-3">
            <h2 className="text-lg font-semibold">Longest overdue marking</h2>
            <p className="text-xs text-slate-500">
              The three exams whose marking has been overdue longest.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="border-b bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-4 py-2">Exam</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Marker</th>
                <th className="px-4 py-2">Deadline</th>
                <th className="px-4 py-2">Days overdue</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {overdue.map((r) => {
                const days = r.deadline ? daysBetween(r.deadline, today) : null;
                return (
                  <tr key={r.id} className="border-b last:border-b-0">
                    <td className="px-4 py-3 font-medium">
                      {r.name}
                      {r.code && (
                        <span className="ml-2 text-xs text-slate-500">
                          {r.code}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[r.status]}`}
                      >
                        {EXAM_STATUS_LABEL[r.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {r.marker_name ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {r.deadline ? formatDateOnly(r.deadline) : "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {days != null
                        ? `${days} day${days === 1 ? "" : "s"}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/exams/${r.id}`}
                        className="text-blue-600 hover:underline"
                      >
                        Manage →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function OverdueLink({
  label,
  count,
  status,
  accent,
}: {
  label: string;
  count: number;
  status: string;
  accent: "amber" | "red";
}) {
  const active = count > 0;
  const tone = active
    ? accent === "red"
      ? "text-red-700"
      : "text-amber-700"
    : "text-slate-400";
  const content = (
    <div
      className={`rounded border ${active ? "bg-white hover:bg-slate-50" : "bg-slate-50"} px-3 py-2`}
    >
      <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold ${tone}`}>{count}</p>
    </div>
  );
  return active ? (
    <Link href={`/exams?status=${status}`} className="block">
      {content}
    </Link>
  ) : (
    content
  );
}
