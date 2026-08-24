import { NextResponse, type NextRequest } from "next/server";
import { PRINCIPAL_HEADER, authEnforced } from "@/lib/easyAuth";

// Marker access is by unguessable token, not by login, so those routes stay
// anonymous. The grades template is column headers only -- no CIDs.
const ANONYMOUS = [/^\/m\//, /^\/api\/exams\/\d+\/grades-template\.csv$/];

export function middleware(req: NextRequest) {
  if (!authEnforced()) return NextResponse.next();

  const { pathname, search } = req.nextUrl;
  if (ANONYMOUS.some((r) => r.test(pathname))) return NextResponse.next();
  if (req.headers.get(PRINCIPAL_HEADER)) return NextResponse.next();

  const login = new URL("/.auth/login/aad", req.url);
  login.searchParams.set("post_login_redirect_uri", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|\\.auth).*)"],
};
