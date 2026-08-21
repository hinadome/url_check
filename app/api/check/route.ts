import { NextResponse } from "next/server";
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
    const ignoreCertErrors = body.ignoreCertErrors === true;
    const result = await fetchWithPlaywright(
      parsedUrl.toString(),
      headers,
      dnsOverride,
      ignoreCertErrors,
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Request failed";
    const isClientError =
      /invalid|not allowed|required|too long|could not resolve|credentials|force-resolve/i.test(
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
        timingMs: 0,
        error: message,
      } satisfies CheckResponse,
      { status: isClientError ? 400 : 500 },
    );
  }
}
