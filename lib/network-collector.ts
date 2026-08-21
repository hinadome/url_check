import type { Page, Request, Response } from "playwright";
import type {
  HeaderPair,
  NetworkBodyEncoding,
  NetworkRequestEntry,
  ResourceTiming,
} from "./types";

const MAX_NETWORK_ENTRIES = 2_000;
/** Cap captured body bytes per response to keep API payloads manageable */
const MAX_BODY_BYTES = 512_000;

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
  let buf: Buffer;
  try {
    buf = await response.body();
  } catch {
    const fromHeader =
      contentLengthHeader && /^\d+$/.test(contentLengthHeader)
        ? Number(contentLengthHeader)
        : null;
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

export function attachNetworkCollector(page: Page): {
  entries: NetworkRequestEntry[];
  flush: () => Promise<void>;
} {
  const entries: NetworkRequestEntry[] = [];
  const pending: Promise<void>[] = [];
  /** Map Playwright Request → entry for timing updates on requestfinished */
  const entryByRequest = new WeakMap<Request, NetworkRequestEntry>();

  page.on("response", (response) => {
    if (entries.length + pending.length >= MAX_NETWORK_ENTRIES) {
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
          const captured = await captureBody(
            response,
            contentType,
            responseHeaderMap["content-length"],
          );

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
    flush: async () => {
      await Promise.all(pending);
      // Give late requestfinished handlers a tick to update responseEnd
      await new Promise<void>((resolve) => setImmediate(resolve));
      entries.sort((a, b) => {
        const byDate = a.date.localeCompare(b.date);
        return byDate !== 0 ? byDate : a.url.localeCompare(b.url);
      });
    },
  };
}
