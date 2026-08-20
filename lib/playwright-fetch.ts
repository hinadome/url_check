import { chromium } from "playwright";
import { extractResources } from "./extract-resources";
import { attachNetworkCollector } from "./network-collector";
import type { CheckResponse, DnsOverride, HeaderPair } from "./types";

const NAVIGATION_TIMEOUT_MS = 45_000;
const NETWORK_IDLE_BUDGET_MS = 5_000;
const MAX_HTML_CHARS = 2_000_000;

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

export async function fetchWithPlaywright(
  url: string,
  headers: Record<string, string>,
  dnsOverride: DnsOverride | null = null,
): Promise<CheckResponse> {
  const started = Date.now();
  const browser = await chromium.launch({
    headless: true,
    args: hostResolverArgs(dnsOverride),
  });

  try {
    const context = await browser.newContext({
      extraHTTPHeaders: headers,
      ignoreHTTPSErrors: false,
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

    const resources = await extractResources(page);
    await network.flush();

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
      dnsOverride,
      timingMs: Date.now() - started,
    };
  } finally {
    await browser.close();
  }
}
