import type { Page, Request, Response } from "playwright";
import type {
  HeaderPair,
  NetworkBodyEncoding,
  NetworkFailedRequestEntry,
  NetworkRequestEntry,
  ResourceTiming,
} from "./types";

const MAX_NETWORK_ENTRIES = 2_000;
/** Default cap for requestfailed rows; override with MAX_NETWORK_FAILED_ENTRIES. */
const DEFAULT_MAX_NETWORK_FAILED_ENTRIES = 500;
/** Cap captured body bytes per response to keep API payloads manageable */
const MAX_BODY_BYTES = 512_000;
/** `response.body()` can hang forever on streaming/analytics requests (e.g. Costco). */
const BODY_READ_TIMEOUT_MS = 5_000;
/** Cap how long flush waits for in-flight collectors before continuing. */
const FLUSH_TIMEOUT_MS = 15_000;

export function maxNetworkFailedEntries(): number {
  const raw = process.env.MAX_NETWORK_FAILED_ENTRIES;
  if (raw == null || raw.trim() === "") return DEFAULT_MAX_NETWORK_FAILED_ENTRIES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_NETWORK_FAILED_ENTRIES;
  return Math.min(Math.floor(n), 10_000);
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toHeaderPairs(headers: Record<string, string>): HeaderPair[] {
  return Object.entries(headers)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isLikelyBinaryContentType(contentType: string): boolean {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (!mime) return false;
  if (mime.startsWith("text/")) return false;
  if (
    mime.includes("json") ||
    mime.includes("xml") ||
    mime.includes("javascript") ||
    mime.includes("ecmascript") ||
    mime.includes("svg") ||
    mime.includes("xhtml") ||
    mime === "application/x-www-form-urlencoded" ||
    mime === "application/graphql" ||
    mime === "application/ld+json"
  ) {
    return false;
  }
  if (
    mime.startsWith("image/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    mime.startsWith("font/") ||
    mime === "application/octet-stream" ||
    mime === "application/pdf" ||
    mime.includes("zip") ||
    mime.includes("wasm") ||
    mime.includes("protobuf") ||
    mime.includes("msword") ||
    mime.includes("officedocument")
  ) {
    return true;
  }
  return false;
}

function bufferLooksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.byteLength, 8_192));
  if (sample.includes(0)) return true;
  return false;
}

type CapturedBody = {
  bodyEncoding: NetworkBodyEncoding;
  body: string;
  bodyTruncated: boolean;
  contentSize: number | null;
};

async function captureBody(
  response: Response,
  contentType: string,
  contentLengthHeader: string | undefined,
): Promise<CapturedBody> {
  const fromHeader =
    contentLengthHeader && /^\d+$/.test(contentLengthHeader)
      ? Number(contentLengthHeader)
      : null;

  let buf: Buffer | null;
  try {
    buf = await withTimeout(
      response.body(),
      BODY_READ_TIMEOUT_MS,
      () => null,
    );
  } catch {
    return {
      bodyEncoding: "empty",
      body: "",
      bodyTruncated: false,
      contentSize: fromHeader,
    };
  }

  if (!buf) {
    return {
      bodyEncoding: "empty",
      body: "",
      bodyTruncated: false,
      contentSize: fromHeader,
    };
  }

  const contentSize = buf.byteLength;
  if (contentSize === 0) {
    return {
      bodyEncoding: "empty",
      body: "",
      bodyTruncated: false,
      contentSize: 0,
    };
  }

  let truncated = false;
  let data = buf;
  if (data.byteLength > MAX_BODY_BYTES) {
    data = data.subarray(0, MAX_BODY_BYTES);
    truncated = true;
  }

  const asBinary =
    isLikelyBinaryContentType(contentType) || bufferLooksBinary(data);

  if (asBinary) {
    return {
      bodyEncoding: "base64",
      body: data.toString("base64"),
      bodyTruncated: truncated,
      contentSize,
    };
  }

  return {
    bodyEncoding: "text",
    body: data.toString("utf8"),
    bodyTruncated: truncated,
    contentSize,
  };
}

function toResourceTiming(raw: ReturnType<Request["timing"]>): ResourceTiming {
  return {
    startTime: raw.startTime,
    domainLookupStart: raw.domainLookupStart,
    domainLookupEnd: raw.domainLookupEnd,
    connectStart: raw.connectStart,
    secureConnectionStart: raw.secureConnectionStart,
    connectEnd: raw.connectEnd,
    requestStart: raw.requestStart,
    responseStart: raw.responseStart,
    responseEnd: raw.responseEnd,
  };
}

export type NetworkCollectorOptions = {
  /**
   * When false, record metadata/headers only (no `response.body()`).
   * Use with Capture HAR so bodies live in the HAR and flush cannot hang on
   * long-lived Costco/Akamai streams. Default true.
   */
  captureBodies?: boolean;
};

export function attachNetworkCollector(
  page: Page,
  options: NetworkCollectorOptions = {},
): {
  entries: NetworkRequestEntry[];
  failedEntries: NetworkFailedRequestEntry[];
  flush: () => Promise<void>;
} {
  const captureBodies = options.captureBodies !== false;
  const maxFailed = maxNetworkFailedEntries();
  const entries: NetworkRequestEntry[] = [];
  const failedEntries: NetworkFailedRequestEntry[] = [];
  const pending: Promise<void>[] = [];
  /** Map Playwright Request → entry for timing updates on requestfinished */
  const entryByRequest = new WeakMap<Request, NetworkRequestEntry>();
  let accepting = true;

  page.on("response", (response) => {
    if (!accepting || entries.length + pending.length >= MAX_NETWORK_ENTRIES) {
      return;
    }

    pending.push(
      (async () => {
        try {
          const observedAt = new Date().toISOString();
          const url = response.url();
          const request = response.request();
          const [responseHeaderMap, requestHeaderMap, serverAddr, httpVersion] =
            await Promise.all([
              response.allHeaders(),
              request.allHeaders(),
              response.serverAddr(),
              response.httpVersion(),
            ]);
          const contentType = responseHeaderMap["content-type"] ?? "";
          const contentLength = responseHeaderMap["content-length"];
          const captured = captureBodies
            ? await captureBody(response, contentType, contentLength)
            : {
                bodyEncoding: "empty" as const,
                body: "",
                bodyTruncated: false,
                contentSize:
                  contentLength && /^\d+$/.test(contentLength)
                    ? Number(contentLength)
                    : null,
              };

          // Prefer timing after body read; responseEnd may still update on requestfinished
          let timing: ResourceTiming | null = null;
          try {
            timing = toResourceTiming(request.timing());
          } catch {
            timing = null;
          }

          const entry: NetworkRequestEntry = {
            url,
            host: hostFromUrl(url),
            method: request.method(),
            status: response.status(),
            contentType,
            contentSize: captured.contentSize,
            resourceType: request.resourceType(),
            date: observedAt,
            remoteIp: serverAddr?.ipAddress ?? null,
            remotePort: serverAddr?.port ?? null,
            httpVersion: httpVersion || null,
            timing,
            requestHeaders: toHeaderPairs(requestHeaderMap),
            responseHeaders: toHeaderPairs(responseHeaderMap),
            bodyEncoding: captured.bodyEncoding,
            body: captured.body,
            bodyTruncated: captured.bodyTruncated,
          };
          entries.push(entry);
          entryByRequest.set(request, entry);
        } catch {
          // Ignore individual response collection failures.
        }
      })(),
    );
  });

  page.on("requestfailed", (request) => {
    if (!accepting || failedEntries.length >= maxFailed) {
      return;
    }
    try {
      const url = request.url();
      const failure = request.failure();
      failedEntries.push({
        url,
        host: hostFromUrl(url),
        method: request.method(),
        status: -1,
        resourceType: request.resourceType(),
        date: new Date().toISOString(),
        failureText: failure?.errorText?.trim() || "request failed",
        requestHeaders: toHeaderPairs(request.headers()),
      });
    } catch {
      // Ignore individual failure collection errors.
    }
  });

  page.on("requestfinished", (request) => {
    const entry = entryByRequest.get(request);
    if (!entry) return;
    try {
      entry.timing = toResourceTiming(request.timing());
    } catch {
      // keep prior timing if any
    }
  });

  return {
    entries,
    failedEntries,
    flush: async () => {
      accepting = false;
      await withTimeout(Promise.all(pending), FLUSH_TIMEOUT_MS, () => undefined);
      // Give late requestfinished handlers a tick to update responseEnd
      await new Promise<void>((resolve) => setImmediate(resolve));
      entries.sort((a, b) => {
        const byDate = a.date.localeCompare(b.date);
        return byDate !== 0 ? byDate : a.url.localeCompare(b.url);
      });
      failedEntries.sort((a, b) => {
        const byDate = a.date.localeCompare(b.date);
        return byDate !== 0 ? byDate : a.url.localeCompare(b.url);
      });
    },
  };
}
