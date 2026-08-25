export type HeaderPair = {
  name: string;
  value: string;
};

export type DnsOverride = {
  host: string;
  ip: string;
};

/**
 * How Playwright records HAR bodies when `captureHar` is true.
 * - `zip` — `content: "attach"` → `.har.zip` (binaries as files)
 * - `json` — `content: "embed"` → `.har` JSON (binaries as base64 in HAR)
 */
export type HarFormat = "zip" | "json";

export type CheckRequest = {
  url: string;
  headers?: HeaderPair[];
  dnsOverride?: DnsOverride;
  /** When true, Playwright ignores TLS certificate errors (default false). */
  ignoreCertErrors?: boolean;
  /**
   * When true, record a Playwright HAR for the session and return it in the
   * response (ephemeral; not written to app storage). Default false.
   */
  captureHar?: boolean;
  /** HAR packaging when `captureHar` is true. Default `zip`. */
  harFormat?: HarFormat;
  /** Chromium `--disable-http2` for this check. Default false. */
  disableHttp2?: boolean;
  /**
   * Disable HTTP/3 for this check. Mapped to Chromium `--disable-quic`
   * (there is no `--disable-http3`). Default false.
   */
  disableHttp3?: boolean;
  /**
   * Preset: force both disables (≈ HTTP/1.1 only). Default false.
   * Server expands to disableHttp2 + disableHttp3.
   */
  http11Only?: boolean;
};

/** Server feature gates from env (GET /api/config). Default allow when unset. */
export type FeatureFlags = {
  allowIgnoreCertErrors: boolean;
  allowCaptureHar: boolean;
  allowHttpProtocolControls: boolean;
};

export type ResourceSummaryData = {
  links: string[];
  images: string[];
  stylesheets: string[];
  scripts: string[];
  iframes: string[];
  other: string[];
};

export type NetworkBodyEncoding = "text" | "base64" | "empty";

/** Playwright request.timing() / Resource Timing–style phases (ms; -1 = unavailable). */
export type ResourceTiming = {
  startTime: number;
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  secureConnectionStart: number;
  connectEnd: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
};

/** Page-level PerformanceNavigationTiming snapshot (ms relative to time origin). */
export type NavigationTimingSnapshot = {
  fetchStart: number;
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  connectEnd: number;
  secureConnectionStart: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
  domInteractive: number;
  domContentLoadedEventStart: number;
  domContentLoadedEventEnd: number;
  domComplete: number;
  loadEventStart: number;
  loadEventEnd: number;
  redirectCount: number;
  type: string;
};

export type NetworkRequestEntry = {
  url: string;
  host: string;
  status: number;
  contentType: string;
  contentSize: number | null;
  resourceType: string;
  /** ISO-8601 timestamp when the response was observed */
  date: string;
  /** IP from response.serverAddr(); null if unavailable */
  remoteIp: string | null;
  /** Port from response.serverAddr(); null if unavailable */
  remotePort: number | null;
  /** e.g. http/1.1, h2 — from response.httpVersion() */
  httpVersion: string | null;
  /** Per-request Resource Timing from request.timing() */
  timing: ResourceTiming | null;
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  /** How `body` should be interpreted in the Content tab */
  bodyEncoding: NetworkBodyEncoding;
  /** Plain text, base64 string, or empty when no body */
  body: string;
  /** True when body was truncated to the capture size limit */
  bodyTruncated: boolean;
};

export type CheckResponse = {
  finalUrl: string;
  status: number;
  title: string | null;
  html: string;
  screenshotBase64: string;
  resources: ResourceSummaryData;
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  networkRequests: NetworkRequestEntry[];
  /** Main document Navigation Timing (once per check) */
  navigationTiming: NavigationTimingSnapshot | null;
  dnsOverride: DnsOverride | null;
  /** Whether this check ignored TLS certificate errors */
  ignoreCertErrors: boolean;
  /** Chromium `--disable-http2` was applied for this check */
  disableHttp2: boolean;
  /** HTTP/3 disabled via Chromium `--disable-quic` for this check */
  disableHttp3: boolean;
  /** Both protocol disables applied (HTTP/1.1-only intent) */
  http11Only: boolean;
  /** Chromium launch args added for protocol restrictions (empty if none) */
  chromiumProtocolArgs: string[];
  /** HAR packaging used for this check, or null when HAR was not requested */
  harFormat: HarFormat | null;
  /**
   * Full HAR 1.2 JSON text when `captureHar` + `harFormat: "json"` succeeded
   * within the soft size limit; otherwise null. Binaries are base64-in-HAR.
   */
  har: string | null;
  /**
   * Playwright HAR session as a zip (base64 for JSON transport) when
   * `captureHar` + `harFormat: "zip"` succeeded within the soft byte limit;
   * otherwise null. Zip uses `content: "attach"` (binaries as files).
   */
  harZipBase64: string | null;
  /**
   * Set when HAR was requested but could not be returned (e.g. over size limit).
   * Check results still succeed; only HAR download is unavailable.
   */
  harError: string | null;
  timingMs: number;
  error?: string;
};
