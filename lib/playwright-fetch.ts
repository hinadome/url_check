import { chromium, type BrowserContext } from "playwright";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractResources } from "./extract-resources";
import { attachNetworkCollector } from "./network-collector";
import type {
  CheckResponse,
  DnsOverride,
  HeaderPair,
  NavigationTimingSnapshot,
} from "./types";

const NAVIGATION_TIMEOUT_MS = 45_000;
const NETWORK_IDLE_BUDGET_MS = 5_000;
const MAX_HTML_CHARS = 2_000_000;
/**
 * Soft cap for HAR payload size (bytes on disk ≈ UTF-8 chars for typical HAR JSON).
 * Over this limit the check still succeeds; HAR is omitted and `harError` is set.
 */
const MAX_HAR_CHARS = 25_000_000;

function toHeaderPairs(headers: Record<string, string>): HeaderPair[] {
  return Object.entries(headers)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function hostResolverArgs(dnsOverride: DnsOverride | null): string[] {
  if (!dnsOverride) {
    return [];
  }

  // Chromium: MAP hostname ip — keeps URL/SNI/Host as the hostname while dialing the IP.
  return [`--host-resolver-rules=MAP ${dnsOverride.host} ${dnsOverride.ip}`];
}

async function captureNavigationTiming(
  page: import("playwright").Page,
): Promise<NavigationTimingSnapshot | null> {
  try {
    return await page.evaluate(() => {
      const nav = performance.getEntriesByType(
        "navigation",
      )[0] as PerformanceNavigationTiming | undefined;
      if (!nav) return null;
      return {
        fetchStart: nav.fetchStart,
        domainLookupStart: nav.domainLookupStart,
        domainLookupEnd: nav.domainLookupEnd,
        connectStart: nav.connectStart,
        connectEnd: nav.connectEnd,
        secureConnectionStart: nav.secureConnectionStart,
        requestStart: nav.requestStart,
        responseStart: nav.responseStart,
        responseEnd: nav.responseEnd,
        domInteractive: nav.domInteractive,
        domContentLoadedEventStart: nav.domContentLoadedEventStart,
        domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
        domComplete: nav.domComplete,
        loadEventStart: nav.loadEventStart,
        loadEventEnd: nav.loadEventEnd,
        redirectCount: nav.redirectCount,
        type: nav.type,
      };
    });
  } catch {
    return null;
  }
}

async function cleanupHarDir(harDir: string | null): Promise<void> {
  if (!harDir) return;
  await rm(harDir, { recursive: true, force: true }).catch(() => undefined);
}

export async function fetchWithPlaywright(
  url: string,
  headers: Record<string, string>,
  dnsOverride: DnsOverride | null = null,
  ignoreCertErrors = false,
  captureHar = false,
): Promise<CheckResponse> {
  const started = Date.now();
  const browser = await chromium.launch({
    headless: true,
    args: hostResolverArgs(dnsOverride),
  });

  let context: BrowserContext | null = null;
  let harDir: string | null = null;
  let harPath: string | null = null;

  try {
    if (captureHar) {
      // Ephemeral OS temp only — never under the app tree; deleted after read.
      harDir = await mkdtemp(join(tmpdir(), "url-checker-har-"));
      harPath = join(harDir, "session.har");
    }

    context = await browser.newContext({
      extraHTTPHeaders: headers,
      ignoreHTTPSErrors: ignoreCertErrors,
      ...(harPath
        ? {
            recordHar: {
              path: harPath,
              mode: "full" as const,
              content: "embed" as const,
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const network = attachNetworkCollector(page);

    let status = 0;
    page.on("response", (response) => {
      if (response.request().resourceType() === "document" && status === 0) {
        status = response.status();
      }
    });

    // Prefer "load" over "networkidle": docs/SPAs often keep analytics/websocket
    // traffic open forever, which makes networkidle hang until timeout.
    const response = await page.goto(url, {
      waitUntil: "load",
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    if (response) {
      status = response.status();
    }

    // Best-effort settle for late JS/DOM updates; ignore timeout.
    await page
      .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_BUDGET_MS })
      .catch(() => undefined);

    let requestHeaders: HeaderPair[] = toHeaderPairs(headers);
    let responseHeaders: HeaderPair[] = [];

    if (response) {
      const [reqAll, resAll] = await Promise.all([
        response.request().allHeaders(),
        response.allHeaders(),
      ]);
      requestHeaders = toHeaderPairs(reqAll);
      responseHeaders = toHeaderPairs(resAll);
    }

    const finalUrl = page.url();
    const title = await page.title();
    let html = await page.content();
    if (html.length > MAX_HTML_CHARS) {
      html = html.slice(0, MAX_HTML_CHARS);
    }

    const screenshotBuffer = await page.screenshot({
      fullPage: true,
      type: "png",
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    const navigationTiming = await captureNavigationTiming(page);
    const resources = await extractResources(page);
    await network.flush();

    // context.close() flushes Playwright's HAR recorder to harPath.
    await context.close();
    context = null;

    let har: string | null = null;
    let harError: string | null = null;
    if (harPath) {
      try {
        const { size } = await stat(harPath);
        if (size > MAX_HAR_CHARS) {
          harError =
            `HAR download unavailable: session archive is too large ` +
            `(${size.toLocaleString()} bytes; limit ${MAX_HAR_CHARS.toLocaleString()}). ` +
            `Page results below are still complete.`;
        } else {
          const raw = await readFile(harPath, "utf8");
          if (raw.length > MAX_HAR_CHARS) {
            harError =
              `HAR download unavailable: session archive is too large ` +
              `(${raw.length.toLocaleString()} chars; limit ${MAX_HAR_CHARS.toLocaleString()}). ` +
              `Page results below are still complete.`;
          } else {
            har = raw;
          }
        }
      } catch (err) {
        har = null;
        harError =
          err instanceof Error
            ? `HAR download unavailable: ${err.message}`
            : "HAR download unavailable: failed to read session archive.";
      } finally {
        await cleanupHarDir(harDir);
        harDir = null;
        harPath = null;
      }
    }

    return {
      finalUrl,
      status,
      title: title || null,
      html,
      screenshotBase64: screenshotBuffer.toString("base64"),
      resources,
      requestHeaders,
      responseHeaders,
      networkRequests: network.entries,
      navigationTiming,
      dnsOverride,
      ignoreCertErrors,
      har,
      harError,
      timingMs: Date.now() - started,
    };
  } finally {
    if (context) {
      await context.close().catch(() => undefined);
    }
    await cleanupHarDir(harDir);
    await browser.close();
  }
}
