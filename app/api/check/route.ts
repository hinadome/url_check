import { NextResponse } from "next/server";
import { enforceAccessGuards } from "@/lib/access-guard";
import { getFeatureFlags } from "@/lib/feature-flags";
import {
  fetchWithPlaywright,
  resolveHttpProtocolOptions,
} from "@/lib/playwright-fetch";
import type {
  CheckRequest,
  CheckResponse,
  HarFormat,
  NetLogCaptureMode,
} from "@/lib/types";
import {
  validateDnsOverride,
  validateHeaders,
  validateUrlWithPin,
} from "@/lib/validate";

export const runtime = "nodejs";
export const maxDuration = 60;

function parseNetLogCaptureMode(value: unknown): NetLogCaptureMode {
  if (value === "includeSensitive" || value === "everything") {
    return value;
  }
  return "default";
}

function emptyErrorPayload(message: string): CheckResponse {
  return {
    finalUrl: "",
    status: 0,
    title: null,
    html: "",
    screenshotBase64: "",
    resources: {
      links: [],
      images: [],
      stylesheets: [],
      scripts: [],
      iframes: [],
      other: [],
    },
    requestHeaders: [],
    responseHeaders: [],
    networkRequests: [],
    networkFailedRequests: [],
    networkSsrfBlockedRequests: [],
    navigationTiming: null,
    dnsPinnedHost: null,
    dnsPinnedIp: null,
    ssrfBrowserGuardEnabled: false,
    dnsOverride: null,
    ignoreCertErrors: false,
    disableHttp2: false,
    disableHttp3: false,
    http11Only: false,
    chromiumProtocolArgs: [],
    http2FallbackApplied: false,
    harFormat: null,
    har: null,
    harZipBase64: null,
    harError: null,
    netLogCaptureMode: null,
    netLogBase64: null,
    netLogError: null,
    timingMs: 0,
    error: message,
  };
}

export async function POST(request: Request) {
  const denied = enforceAccessGuards(request, { rateLimit: true });
  if (denied) return denied;

  let body: CheckRequest;

  try {
    body = (await request.json()) as CheckRequest;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" } satisfies Partial<CheckResponse>,
      { status: 400 },
    );
  }

  if (!body?.url || typeof body.url !== "string") {
    return NextResponse.json(
      { error: "url is required" } satisfies Partial<CheckResponse>,
      { status: 400 },
    );
  }

  try {
    let provisionalHost = "";
    try {
      provisionalHost = new URL(body.url.trim()).hostname;
    } catch {
      throw new Error("Invalid URL");
    }

    const dnsOverride = validateDnsOverride(body.dnsOverride, provisionalHost);
    const validated = await validateUrlWithPin(body.url.trim(), {
      dnsOverride: dnsOverride ?? undefined,
    });
    const headers = validateHeaders(body.headers);

    const flags = getFeatureFlags();
    const wantIgnoreCert = body.ignoreCertErrors === true;
    const wantCaptureHar = body.captureHar === true;
    const harFormat: HarFormat =
      body.harFormat === "zip" ? "zip" : "json";
    const wantCaptureNetLog = body.captureNetLog === true;
    const netLogCaptureMode = parseNetLogCaptureMode(body.netLogCaptureMode);
    const protocol = resolveHttpProtocolOptions({
      disableHttp2: body.disableHttp2 === true,
      disableHttp3: body.disableHttp3 === true,
      http11Only: body.http11Only === true,
    });
    const wantProtocolControls =
      protocol.disableHttp2 || protocol.disableHttp3;

    if (wantIgnoreCert && !flags.allowIgnoreCertErrors) {
      throw new Error(
        "ignoreCertErrors is disabled on this server (set ALLOW_IGNORE_CERT_ERRORS=1 or unset to allow)",
      );
    }
    if (wantCaptureHar && !flags.allowCaptureHar) {
      throw new Error(
        "captureHar is disabled on this server (set ALLOW_CAPTURE_HAR=1 or unset to allow)",
      );
    }
    if (wantCaptureNetLog && !flags.allowCaptureNetLog) {
      throw new Error(
        "captureNetLog is disabled on this server (set ALLOW_CAPTURE_NETLOG=1 or unset to allow)",
      );
    }
    if (wantProtocolControls && !flags.allowHttpProtocolControls) {
      throw new Error(
        "HTTP protocol controls are disabled on this server (set ALLOW_HTTP_PROTOCOL_CONTROLS=1 or unset to allow)",
      );
    }

    const dnsPin =
      validated.pinnedIp != null
        ? { host: validated.host, ip: validated.pinnedIp }
        : null;

    const result = await fetchWithPlaywright(
      validated.url.toString(),
      headers,
      dnsOverride,
      wantIgnoreCert,
      wantCaptureHar,
      harFormat,
      protocol.disableHttp2,
      protocol.disableHttp3,
      wantCaptureNetLog,
      netLogCaptureMode,
      dnsPin,
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Request failed";
    const isClientError =
      /invalid|not allowed|required|too long|could not resolve|credentials|force-resolve|disabled on this server/i.test(
        message,
      );

    return NextResponse.json(emptyErrorPayload(message), {
      status: isClientError ? 400 : 500,
    });
  }
}
