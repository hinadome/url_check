"use client";

import { useState } from "react";
import { ContentPreview } from "@/components/ContentPreview";
import { ExportMenu } from "@/components/ExportMenu";
import { HeadersPanel } from "@/components/HeadersPanel";
import { NetworkRequestsPanel } from "@/components/NetworkRequestsPanel";
import { ResourceSummary } from "@/components/ResourceSummary";
import { UrlForm, type UrlFormSubmit } from "@/components/UrlForm";
import type { CheckResponse } from "@/lib/types";

export default function Home() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResponse | null>(null);

  const handleSubmit = async (data: UrlFormSubmit) => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const payload = (await res.json()) as CheckResponse & { error?: string };

      if (!res.ok || payload.error) {
        setError(payload.error || `Request failed (${res.status})`);
        return;
      }

      setResult(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>URL Checker</h1>
        <p>
          Enter a URL and optional headers. Playwright loads the page in a real
          browser, then shows extracted resources, a screenshot, and sandboxed HTML.
        </p>
      </header>

      <UrlForm onSubmit={handleSubmit} loading={loading} />

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {loading && (
        <div className="alert alert-info" role="status">
          Fetching page with Playwright…
        </div>
      )}

      {result && !result.error && (
        <div className="results">
          <div className="meta">
            <div className="meta-main">
              <span>
                Status: <strong>{result.status}</strong>
              </span>
              <span>
                Final URL:{" "}
                <a href={result.finalUrl} target="_blank" rel="noopener noreferrer">
                  {result.finalUrl}
                </a>
              </span>
              <span>
                Timing: <strong>{result.timingMs} ms</strong>
              </span>
              {result.dnsOverride && (
                <span>
                  DNS override:{" "}
                  <strong>
                    {result.dnsOverride.host} → {result.dnsOverride.ip}
                  </strong>
                </span>
              )}
            </div>
            <ExportMenu result={result} />
          </div>

          <HeadersPanel
            requestHeaders={result.requestHeaders ?? []}
            responseHeaders={result.responseHeaders ?? []}
          />

          <ResourceSummary resources={result.resources} />
          <ContentPreview
            html={result.html}
            screenshotBase64={result.screenshotBase64}
            title={result.title}
          />

          <NetworkRequestsPanel
            key={`${result.finalUrl}-${result.timingMs}`}
            requests={result.networkRequests ?? []}
            navigationTiming={result.navigationTiming ?? null}
          />
        </div>
      )}
    </div>
  );
}
