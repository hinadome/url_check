import { NextResponse } from "next/server";
import { getFeatureFlags } from "@/lib/feature-flags";
import { fetchWithPlaywright } from "@/lib/playwright-fetch";
import type { CheckRequest, CheckResponse } from "@/lib/types";
import {
  validateDnsOverride,
  validateHeaders,
  validateUrl,
} from "@/lib/validate";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
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
    const parsedUrl = await validateUrl(body.url.trim(), {
      skipDnsLookup: dnsOverride !== null,
    });
    const headers = validateHeaders(body.headers);

    const flags = getFeatureFlags();
    const wantIgnoreCert = body.ignoreCertErrors === true;
    const wantCaptureHar = body.captureHar === true;

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

    const result = await fetchWithPlaywright(
      parsedUrl.toString(),
      headers,
      dnsOverride,
      wantIgnoreCert,
      wantCaptureHar,
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Request failed";
    const isClientError =
      /invalid|not allowed|required|too long|could not resolve|credentials|force-resolve|disabled on this server/i.test(
        message,
      );

    return NextResponse.json(
      {
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
        navigationTiming: null,
        dnsOverride: null,
        ignoreCertErrors: false,
        har: null,
        harError: null,
        timingMs: 0,
        error: message,
      } satisfies CheckResponse,
      { status: isClientError ? 400 : 500 },
    );
  }
}
