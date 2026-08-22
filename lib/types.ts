export type HeaderPair = {
  name: string;
  value: string;
};

export type DnsOverride = {
  host: string;
  ip: string;
};

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
  /**
   * Full HAR 1.2 JSON text when `captureHar` was requested and within size limit;
   * otherwise null. Only held in the API response / browser memory — not persisted.
   */
  har: string | null;
  /**
   * Set when HAR was requested but could not be returned (e.g. over size limit).
   * Check results still succeed; only HAR download is unavailable.
   */
  harError: string | null;
  timingMs: number;
  error?: string;
};
