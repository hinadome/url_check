import { envTrustProxy } from "./env-flags";
import { normalizeClientIp } from "./cidr";

/**
 * Resolve client IP for ACL / rate limiting.
 * When TRUST_PROXY is on (default): X-Real-IP, then left-most X-Forwarded-For.
 * When off: only use direct-looking headers if present is ignored — returns "unknown"
 * unless a non-forwarded hint exists (Next may not expose socket IP in App Router).
 */
export function getClientIp(request: Request): string {
  const trustProxy = envTrustProxy();

  if (trustProxy) {
    const realIp = request.headers.get("x-real-ip");
    if (realIp) {
      const n = normalizeClientIp(realIp.split(",")[0] ?? "");
      if (n) return n;
    }
    const xff = request.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim() ?? "";
      const n = normalizeClientIp(first);
      if (n) return n;
    }
  }

  // NextRequest.ip when available (middleware / some runtimes)
  const maybeIp = (request as Request & { ip?: string | null }).ip;
  if (maybeIp) {
    const n = normalizeClientIp(maybeIp);
    if (n) return n;
  }

  return "unknown";
}
