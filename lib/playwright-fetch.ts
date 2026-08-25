import { chromium, type Browser, type BrowserContext } from "playwright";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractResources } from "./extract-resources";
import { attachNetworkCollector } from "./network-collector";
import type {
  CheckResponse,
  DnsOverride,
  HarFormat,
  HeaderPair,
  NavigationTimingSnapshot,
  NetLogCaptureMode,
} from "./types";

const NAVIGATION_TIMEOUT_MS = 45_000;
const NETWORK_IDLE_BUDGET_MS = 5_000;
const MAX_HTML_CHARS = 2_000_000;
/**
 * Soft cap for HAR archive size in bytes (zip on disk, or embed `.har` file size).
 * Over this limit the check still succeeds; HAR is omitted and `harError` is set.
 */
const MAX_HAR_BYTES = 45_000_000;
/**
 * Soft cap for Chromium NetLog JSON file size in bytes.
 * Over this limit the check still succeeds; NetLog is omitted and `netLogError` is set.
 * Also passed to Chromium as `--net-log-max-size-mb`.
 */
const MAX_NETLOG_BYTES = 45_000_000;

function toHeaderPairs(headers: Record<string, string>): HeaderPair[] {
  return Object.entries(headers)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function findHeaderKey(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(headers).find((k) => k.toLowerCase() === lower);
}

function hostResolverArgs(dnsOverride: DnsOverride | null): string[] {
  if (!dnsOverride) {
    return [];
  }

  // Chromium: MAP hostname ip — keeps URL/SNI/Host as the hostname while dialing the IP.
  return [`--host-resolver-rules=MAP ${dnsOverride.host} ${dnsOverride.ip}`];
}

/** Chromium `--log-net-log` / `--net-log-capture-mode` / `--net-log-max-size-mb`. */
export function netLogLaunchArgs(
  netLogPath: string,
  mode: NetLogCaptureMode,
): string[] {
  const maxMb = Math.max(1, Math.floor(MAX_NETLOG_BYTES / 1_000_000));
  const args = [
    `--log-net-log=${netLogPath}`,
    `--net-log-max-size-mb=${maxMb}`,
  ];
  if (mode === "includeSensitive") {
    args.push("--net-log-capture-mode=IncludeSensitive");
  } else if (mode === "everything") {
    args.push("--net-log-capture-mode=Everything");
  }
  // `default` = omit mode flag (Chromium strips private info)
  return args;
}

/**
 * Allowlisted Chromium network switches for HTTP version restrictions.
 * HTTP/3 is disabled via `--disable-quic` (no official `--disable-http3`).
 */
export function httpProtocolArgs(opts: {
  disableHttp2: boolean;
  disableHttp3: boolean;
}): string[] {
  const args: string[] = [];
  if (opts.disableHttp2) args.push("--disable-http2");
  if (opts.disableHttp3) args.push("--disable-quic");
  return args;
}

/** Expand request flags (including http11Only preset) into launch + echo fields. */
export function resolveHttpProtocolOptions(input: {
  disableHttp2?: boolean;
  disableHttp3?: boolean;
  http11Only?: boolean;
}): {
  disableHttp2: boolean;
  disableHttp3: boolean;
  http11Only: boolean;
  chromiumProtocolArgs: string[];
} {
  const http11Only = input.http11Only === true;
  const disableHttp2 = http11Only || input.disableHttp2 === true;
  const disableHttp3 = http11Only || input.disableHttp3 === true;
  return {
    disableHttp2,
    disableHttp3,
    http11Only: disableHttp2 && disableHttp3,
    chromiumProtocolArgs: httpProtocolArgs({ disableHttp2, disableHttp3 }),
  };
}

/**
 * Headless Chromium sends `HeadlessChrome` in UA / `sec-ch-ua`. Some CDNs/WAFs
 * (e.g. Akamai on costco.com) abort with net::ERR_HTTP2_PROTOCOL_ERROR.
 * Prefer a headed Chrome identity unless the caller already set these headers.
 */
export function buildHeadlessCompatibleIdentity(
  headers: Record<string, string>,
  chromiumVersion: string,
): { userAgent?: string; extraHTTPHeaders: Record<string, string> } {
  const major = chromiumVersion.split(".")[0] || "120";
  const extraHTTPHeaders = { ...headers };

  let userAgent: string | undefined;
  if (!findHeaderKey(extraHTTPHeaders, "user-agent")) {
    if (process.platform === "darwin") {
      userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`;
    } else if (process.platform === "win32") {
      userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`;
    } else {
      userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`;
    }
  }

  if (!findHeaderKey(extraHTTPHeaders, "sec-ch-ua")) {
    extraHTTPHeaders["sec-ch-ua"] =
      `"Chromium";v="${major}", "Not.A/Brand";v="99", "Google Chrome";v="${major}"`;
  }
  if (!findHeaderKey(extraHTTPHeaders, "sec-ch-ua-mobile")) {
    extraHTTPHeaders["sec-ch-ua-mobile"] = "?0";
  }
  if (!findHeaderKey(extraHTTPHeaders, "sec-ch-ua-platform")) {
    const platform =
      process.platform === "darwin"
        ? "macOS"
        : process.platform === "win32"
          ? "Windows"
          : "Linux";
    extraHTTPHeaders["sec-ch-ua-platform"] = `"${platform}"`;
  }

  return { userAgent, extraHTTPHeaders };
}

function isHttp2ProtocolError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ERR_HTTP2_PROTOCOL_ERROR/i.test(msg);
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

async function cleanupTempDir(dir: string | null): Promise<void> {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** Costco/Akamai and similar sites may keep navigating after `load`. */
async function readPageContent(
  page: import("playwright").Page,
): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await page.content();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/navigating and changing the content/i.test(msg) || attempt === 3) {
        throw err;
      }
      await page
        .waitForLoadState("load", { timeout: 10_000 })
        .catch(() => undefined);
      await page.waitForTimeout(300);
    }
  }
  return await page.content();
}

type FetchAttemptOptions = {
  url: string;
  headers: Record<string, string>;
  dnsOverride: DnsOverride | null;
  ignoreCertErrors: boolean;
  captureHar: boolean;
  harFormat: HarFormat;
  captureNetLog: boolean;
  netLogCaptureMode: NetLogCaptureMode;
  disableHttp2: boolean;
  disableHttp3: boolean;
  http2FallbackApplied: boolean;
  started: number;
};

async function runFetchAttempt(
  opts: FetchAttemptOptions,
): Promise<CheckResponse> {
  const protocol = resolveHttpProtocolOptions({
    disableHttp2: opts.disableHttp2,
    disableHttp3: opts.disableHttp3,
  });

  let netLogDir: string | null = null;
  let netLogPath: string | null = null;
  const effectiveNetLogMode: NetLogCaptureMode | null = opts.captureNetLog
    ? opts.netLogCaptureMode
    : null;

  if (opts.captureNetLog) {
    netLogDir = await mkdtemp(join(tmpdir(), "url-checker-netlog-"));
    netLogPath = join(netLogDir, "session.netlog.json");
  }

  const browser: Browser = await chromium.launch({
    headless: true,
    args: [
      ...hostResolverArgs(opts.dnsOverride),
      ...protocol.chromiumProtocolArgs,
      ...(netLogPath && effectiveNetLogMode
        ? netLogLaunchArgs(netLogPath, effectiveNetLogMode)
        : []),
    ],
  });

  let context: BrowserContext | null = null;
  let harDir: string | null = null;
  let harPath: string | null = null;
  const effectiveHarFormat: HarFormat | null = opts.captureHar
    ? opts.harFormat
    : null;
  let browserClosed = false;

  try {
    if (opts.captureHar) {
      harDir = await mkdtemp(join(tmpdir(), "url-checker-har-"));
      if (opts.harFormat === "zip") {
        harPath = join(harDir, "session.har.zip");
      } else {
        harPath = join(harDir, "session.har");
      }
    }

    const identity = buildHeadlessCompatibleIdentity(
      opts.headers,
      browser.version(),
    );

    context = await browser.newContext({
      ...(identity.userAgent ? { userAgent: identity.userAgent } : {}),
      extraHTTPHeaders: identity.extraHTTPHeaders,
      ignoreHTTPSErrors: opts.ignoreCertErrors,
      ...(harPath
        ? {
            recordHar: {
              path: harPath,
              mode: "full" as const,
              content: (opts.harFormat === "zip" ? "attach" : "embed") as
                | "attach"
                | "embed",
            },
          }
        : {}),
    });
    const page = await context.newPage();
    // When HAR is on, bodies are in the archive — skip per-response body() so
    // flush cannot hang on Costco/Akamai long-lived streams (ERR hang / never finish).
    const network = attachNetworkCollector(page, {
      captureBodies: !opts.captureHar,
    });

    let status = 0;
    page.on("response", (response) => {
      if (response.request().resourceType() === "document" && status === 0) {
        status = response.status();
      }
    });

    let response;
    try {
      // Prefer "load" over "networkidle": docs/SPAs often keep analytics/websocket
      // traffic open forever, which makes networkidle hang until timeout.
      response = await page.goto(opts.url, {
        waitUntil: "load",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    } catch (err) {
      // Some CDNs still fail over HTTP/2 even with headed client hints — retry once
      // with --disable-http2 when the caller did not already request it.
      if (!opts.disableHttp2 && isHttp2ProtocolError(err)) {
        throw Object.assign(new Error("HTTP2_FALLBACK_RETRY"), { cause: err });
      }
      throw err;
    }

    if (response) {
      status = response.status();
    }

    await page
      .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_BUDGET_MS })
      .catch(() => undefined);

    let requestHeaders: HeaderPair[] = toHeaderPairs(identity.extraHTTPHeaders);
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
    const title = await page.title().catch(() => "");
    let html = await readPageContent(page);
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

    // HAR flushes on context.close(); NetLog flushes on browser.close().
    await context.close();
    context = null;
    await browser.close();
    browserClosed = true;

    let har: string | null = null;
    let harZipBase64: string | null = null;
    let harError: string | null = null;
    if (harPath && effectiveHarFormat) {
      try {
        const { size } = await stat(harPath);
        if (size > MAX_HAR_BYTES) {
          harError =
            `HAR download unavailable: session archive is too large ` +
            `(${size.toLocaleString()} bytes; limit ${MAX_HAR_BYTES.toLocaleString()}). ` +
            `Page results below are still complete.`;
        } else if (effectiveHarFormat === "zip") {
          const buf = await readFile(harPath);
          harZipBase64 = buf.toString("base64");
        } else {
          const raw = await readFile(harPath, "utf8");
          if (raw.length > MAX_HAR_BYTES) {
            harError =
              `HAR download unavailable: session archive is too large ` +
              `(${raw.length.toLocaleString()} chars; limit ${MAX_HAR_BYTES.toLocaleString()}). ` +
              `Page results below are still complete.`;
          } else {
            har = raw;
          }
        }
      } catch (err) {
        har = null;
        harZipBase64 = null;
        harError =
          err instanceof Error
            ? `HAR download unavailable: ${err.message}`
            : "HAR download unavailable: failed to read session archive.";
      } finally {
        await cleanupTempDir(harDir);
        harDir = null;
        harPath = null;
      }
    }

    let netLogBase64: string | null = null;
    let netLogError: string | null = null;
    if (netLogPath && effectiveNetLogMode) {
      try {
        const { size } = await stat(netLogPath);
        if (size > MAX_NETLOG_BYTES) {
          netLogError =
            `NetLog download unavailable: dump is too large ` +
            `(${size.toLocaleString()} bytes; limit ${MAX_NETLOG_BYTES.toLocaleString()}). ` +
            `Page results below are still complete.`;
        } else {
          const buf = await readFile(netLogPath);
          netLogBase64 = buf.toString("base64");
        }
      } catch (err) {
        netLogBase64 = null;
        netLogError =
          err instanceof Error
            ? `NetLog download unavailable: ${err.message}`
            : "NetLog download unavailable: failed to read dump.";
      } finally {
        await cleanupTempDir(netLogDir);
        netLogDir = null;
        netLogPath = null;
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
      networkFailedRequests: network.failedEntries,
      navigationTiming,
      dnsOverride: opts.dnsOverride,
      ignoreCertErrors: opts.ignoreCertErrors,
      disableHttp2: protocol.disableHttp2,
      disableHttp3: protocol.disableHttp3,
      http11Only: protocol.http11Only,
      chromiumProtocolArgs: protocol.chromiumProtocolArgs,
      http2FallbackApplied: opts.http2FallbackApplied,
      harFormat: effectiveHarFormat,
      har,
      harZipBase64,
      harError,
      netLogCaptureMode: effectiveNetLogMode,
      netLogBase64,
      netLogError,
      timingMs: Date.now() - opts.started,
    };
  } finally {
    if (context) {
      await context.close().catch(() => undefined);
    }
    await cleanupTempDir(harDir);
    await cleanupTempDir(netLogDir);
    if (!browserClosed) {
      await browser.close().catch(() => undefined);
    }
  }
}

export async function fetchWithPlaywright(
  url: string,
  headers: Record<string, string>,
  dnsOverride: DnsOverride | null = null,
  ignoreCertErrors = false,
  captureHar = false,
  harFormat: HarFormat = "json",
  disableHttp2 = false,
  disableHttp3 = false,
  captureNetLog = false,
  netLogCaptureMode: NetLogCaptureMode = "default",
): Promise<CheckResponse> {
  const started = Date.now();
  const base = {
    url,
    headers,
    dnsOverride,
    ignoreCertErrors,
    captureHar,
    harFormat,
    captureNetLog,
    netLogCaptureMode,
    disableHttp3,
    started,
  };

  try {
    return await runFetchAttempt({
      ...base,
      disableHttp2,
      http2FallbackApplied: false,
    });
  } catch (err) {
    if (
      !disableHttp2 &&
      err instanceof Error &&
      err.message === "HTTP2_FALLBACK_RETRY"
    ) {
      // Failed attempt's NetLog temp dir is cleaned in runFetchAttempt finally.
      // Retry uses a fresh NetLog path; only the successful attempt is returned.
      return await runFetchAttempt({
        ...base,
        disableHttp2: true,
        http2FallbackApplied: true,
      });
    }
    throw err;
  }
}
