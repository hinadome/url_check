import { NextResponse } from "next/server";
import { getClientIp } from "./client-ip";
import { isClientIpAllowed } from "./network-acl";
import { consumeRateLimit, getRateLimitConfig } from "./rate-limit";

export type AccessGuardOptions = {
  /** When true, apply rate limit (POST /api/check). ACL always applied when enabled. */
  rateLimit?: boolean;
};

/**
 * Network ACL (403) and optional rate limit (429).
 * Returns a NextResponse to send immediately, or null to continue.
 */
export function enforceAccessGuards(
  request: Request,
  options: AccessGuardOptions = {},
): NextResponse | null {
  const clientIp = getClientIp(request);

  if (!isClientIpAllowed(clientIp)) {
    return NextResponse.json(
      {
        error: `Forbidden: client IP ${clientIp} is not on the network allowlist`,
      },
      { status: 403 },
    );
  }

  if (options.rateLimit) {
    const cfg = getRateLimitConfig();
    if (cfg.enabled) {
      const result = consumeRateLimit(clientIp);
      if (!result.allowed) {
        return NextResponse.json(
          {
            error: `Too many requests: limit ${result.limit} per ${Math.round(result.windowMs / 1000)}s`,
          },
          {
            status: 429,
            headers: {
              "Retry-After": String(result.retryAfterSec),
              "X-RateLimit-Limit": String(result.limit),
              "X-RateLimit-Remaining": "0",
            },
          },
        );
      }
    }
  }

  return null;
}
