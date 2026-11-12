import { NextResponse, type NextRequest } from "next/server";

// Barreira rápida: exige o cookie de sessão. A validação real é feita no servidor (getContext).
const PUBLIC = ["/login", "/redefinir", "/m/", "/api/webhooks"];
export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (PUBLIC.some((p) => path.startsWith(p)) || req.cookies.get("mv_session")) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login"; url.search = "";
  return NextResponse.redirect(url);
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"] };
