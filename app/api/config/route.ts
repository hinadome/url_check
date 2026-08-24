import { NextResponse } from "next/server";
import { getFeatureFlags } from "@/lib/feature-flags";

export const runtime = "nodejs";

/** Public feature gates for the UI (same values enforced by POST /api/check). */
export async function GET() {
  return NextResponse.json(getFeatureFlags());
}
