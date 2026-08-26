import { NextResponse, type NextRequest } from "next/server";
import { enforceAccessGuards } from "@/lib/access-guard";

/**
 * When ENABLE_NETWORK_ACL=1, reject non-allowlisted client IPs with 403
 * for all matched routes (UI + API).
 * Rate limiting is applied only in POST /api/check (see that route).
 */
export function middleware(request: NextRequest) {
  const blocked = enforceAccessGuards(request, { rateLimit: false });
  if (blocked) return blocked;
  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * All paths except Next static assets / image optimizer.
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
