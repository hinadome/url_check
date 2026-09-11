import type { Page, Route } from "playwright";
import { envFlagOnByDefault } from "./env-flags";
import { evaluateRequestUrl } from "./ssrf-policy";
import type { HeaderPair, NetworkSsrfBlockedRequestEntry } from "./types";

const DEFAULT_MAX_SSRF_BLOCKED_ENTRIES = 500;

export function isSsrfBrowserGuardEnabled(): boolean {
  return envFlagOnByDefault("ENABLE_SSRF_BROWSER_GUARD");
}

export function maxSsrfBlockedEntries(): number {
  const raw = process.env.MAX_SSRF_BLOCKED_ENTRIES;
  if (raw == null || raw.trim() === "") return DEFAULT_MAX_SSRF_BLOCKED_ENTRIES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_SSRF_BLOCKED_ENTRIES;
  return Math.min(Math.floor(n), 10_000);
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function toHeaderPairs(headers: Record<string, string>): HeaderPair[] {
  return Object.entries(headers)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type SsrfBlockedCollector = {
  entries: NetworkSsrfBlockedRequestEntry[];
  record: (entry: Omit<NetworkSsrfBlockedRequestEntry, "date">) => void;
};

export function createSsrfBlockedCollector(): SsrfBlockedCollector {
  const entries: NetworkSsrfBlockedRequestEntry[] = [];
  const max = maxSsrfBlockedEntries();

  return {
    entries,
    record(entry) {
      if (entries.length >= max) return;
      entries.push({
        ...entry,
        date: new Date().toISOString(),
      });
    },
  };
}

export async function attachSsrfRouteGuard(
  page: Page,
  collector: SsrfBlockedCollector,
): Promise<void> {
  const cache = new Map<
    string,
    Awaited<ReturnType<typeof evaluateRequestUrl>>
  >();

  await page.route("**/*", async (route: Route) => {
    const request = route.request();
    const url = request.url();
    const result = await evaluateRequestUrl(url, cache);

    if (!result.safe) {
      collector.record({
        url,
        host: hostFromUrl(url),
        method: request.method(),
        resourceType: request.resourceType(),
        blockReason: result.reason,
        requestHeaders: toHeaderPairs(request.headers()),
      });
      await route.abort("blockedbyclient");
      return;
    }

    await route.continue();
  });
}

export function hostResolverPinArgs(
  host: string,
  pinnedIp: string,
): string[] {
  return [`--host-resolver-rules=MAP ${host} ${pinnedIp}`];
}
