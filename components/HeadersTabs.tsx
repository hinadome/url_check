"use client";

import { useState } from "react";
import type {
  HeaderPair,
  NavigationTimingSnapshot,
  NetworkBodyEncoding,
  ResourceTiming,
} from "@/lib/types";

export type HeaderTab = "request" | "response" | "content" | "timing";

type HeadersTabsProps = {
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  /** When set, shows a Content tab (network rows). */
  bodyEncoding?: NetworkBodyEncoding;
  body?: string;
  bodyTruncated?: boolean;
  /** When set (including null), shows Timing tab for network rows. */
  timing?: ResourceTiming | null;
  /** Page Navigation Timing — shown on document rows when present. */
  navigationTiming?: NavigationTimingSnapshot | null;
  showTimingTab?: boolean;
  /** Defaults to response (usually what people inspect first). */
  defaultTab?: HeaderTab;
  className?: string;
  tableMaxHeightClass?: "headers-table-wrap" | "network-headers-table-wrap";
};

function HeaderTable({ headers }: { headers: HeaderPair[] }) {
  if (headers.length === 0) {
    return <p className="muted">None captured.</p>;
  }

  return (
    <table className="headers-table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {headers.map((header, index) => (
          <tr key={`${index}-${header.name}`}>
            <td className="header-name">{header.name}</td>
            <td className="header-value">{header.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ContentPanel({
  bodyEncoding,
  body,
  bodyTruncated,
}: {
  bodyEncoding: NetworkBodyEncoding;
  body: string;
  bodyTruncated: boolean;
}) {
  if (bodyEncoding === "empty" || !body) {
    return null;
  }

  return (
    <div className="network-body-panel">
      {bodyEncoding === "base64" && (
        <p className="muted network-body-meta">Binary content shown as base64.</p>
      )}
      {bodyTruncated && (
        <p className="muted network-body-meta">
          Content truncated to the capture size limit.
        </p>
      )}
      <pre className="plaintext-content network-body-content">{body}</pre>
    </div>
  );
}

function formatTimingMs(value: number | undefined | null): string {
  if (value === undefined || value === null || value < 0) return "—";
  if (Number.isInteger(value)) return `${value} ms`;
  return `${value.toFixed(1)} ms`;
}

function phaseDelta(start: number, end: number): string {
  if (start < 0 || end < 0 || end < start) return "—";
  return formatTimingMs(end - start);
}

function TimingNameValueTable({
  rows,
}: {
  rows: { name: string; value: string }[];
}) {
  return (
    <table className="headers-table timing-table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name}>
            <td className="timing-name">{row.name}</td>
            <td className="timing-value">{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TimingPanel({
  timing,
  navigationTiming,
}: {
  timing: ResourceTiming | null | undefined;
  navigationTiming: NavigationTimingSnapshot | null | undefined;
}) {
  const resourceRows = timing
    ? [
        { name: "startTime", value: formatTimingMs(timing.startTime) },
        {
          name: "domainLookupStart",
          value: formatTimingMs(timing.domainLookupStart),
        },
        {
          name: "domainLookupEnd",
          value: formatTimingMs(timing.domainLookupEnd),
        },
        {
          name: "DNS (lookup)",
          value: phaseDelta(timing.domainLookupStart, timing.domainLookupEnd),
        },
        { name: "connectStart", value: formatTimingMs(timing.connectStart) },
        {
          name: "secureConnectionStart",
          value: formatTimingMs(timing.secureConnectionStart),
        },
        { name: "connectEnd", value: formatTimingMs(timing.connectEnd) },
        {
          name: "TCP connect",
          value: phaseDelta(timing.connectStart, timing.connectEnd),
        },
        { name: "requestStart", value: formatTimingMs(timing.requestStart) },
        { name: "responseStart", value: formatTimingMs(timing.responseStart) },
        {
          name: "TTFB (responseStart − requestStart)",
          value: phaseDelta(timing.requestStart, timing.responseStart),
        },
        { name: "responseEnd", value: formatTimingMs(timing.responseEnd) },
        {
          name: "Total (responseEnd − startTime)",
          value:
            timing.responseEnd >= 0 && timing.startTime >= 0
              ? formatTimingMs(timing.responseEnd)
              : "—",
        },
      ]
    : [];

  const navRows = navigationTiming
    ? [
        { name: "type", value: navigationTiming.type || "—" },
        {
          name: "redirectCount",
          value: String(navigationTiming.redirectCount),
        },
        {
          name: "fetchStart",
          value: formatTimingMs(navigationTiming.fetchStart),
        },
        {
          name: "domainLookupStart",
          value: formatTimingMs(navigationTiming.domainLookupStart),
        },
        {
          name: "domainLookupEnd",
          value: formatTimingMs(navigationTiming.domainLookupEnd),
        },
        {
          name: "connectStart",
          value: formatTimingMs(navigationTiming.connectStart),
        },
        {
          name: "secureConnectionStart",
          value: formatTimingMs(navigationTiming.secureConnectionStart),
        },
        {
          name: "connectEnd",
          value: formatTimingMs(navigationTiming.connectEnd),
        },
        {
          name: "requestStart",
          value: formatTimingMs(navigationTiming.requestStart),
        },
        {
          name: "responseStart",
          value: formatTimingMs(navigationTiming.responseStart),
        },
        {
          name: "responseEnd",
          value: formatTimingMs(navigationTiming.responseEnd),
        },
        {
          name: "domInteractive",
          value: formatTimingMs(navigationTiming.domInteractive),
        },
        {
          name: "domContentLoadedEventStart",
          value: formatTimingMs(navigationTiming.domContentLoadedEventStart),
        },
        {
          name: "domContentLoadedEventEnd",
          value: formatTimingMs(navigationTiming.domContentLoadedEventEnd),
        },
        {
          name: "domComplete",
          value: formatTimingMs(navigationTiming.domComplete),
        },
        {
          name: "loadEventStart",
          value: formatTimingMs(navigationTiming.loadEventStart),
        },
        {
          name: "loadEventEnd",
          value: formatTimingMs(navigationTiming.loadEventEnd),
        },
      ]
    : [];

  return (
    <div className="network-timing-panel">
      <h3 className="network-timing-heading">Resource timing</h3>
      <p className="muted network-timing-note">
        From Playwright <code>request.timing()</code> (Resource Timing–style
        phases; −1 shown as —).
      </p>
      {resourceRows.length === 0 ? (
        <p className="muted">No resource timing captured for this request.</p>
      ) : (
        <div className="network-timing-table-wrap">
          <TimingNameValueTable rows={resourceRows} />
        </div>
      )}

      {navigationTiming !== undefined && (
        <>
          <h3 className="network-timing-heading">Navigation timing</h3>
          <p className="muted network-timing-note">
            Page <code>PerformanceNavigationTiming</code> (shown on the main
            document row).
          </p>
          {navRows.length === 0 ? (
            <p className="muted">No navigation timing available.</p>
          ) : (
            <div className="network-timing-table-wrap">
              <TimingNameValueTable rows={navRows} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function HeadersTabs({
  requestHeaders,
  responseHeaders,
  bodyEncoding,
  body = "",
  bodyTruncated = false,
  timing,
  navigationTiming,
  showTimingTab = false,
  defaultTab = "response",
  className,
  tableMaxHeightClass = "headers-table-wrap",
}: HeadersTabsProps) {
  const showContentTab = bodyEncoding !== undefined;
  const initialTab =
    (defaultTab === "content" && !showContentTab) ||
    (defaultTab === "timing" && !showTimingTab)
      ? "response"
      : defaultTab;
  const [tab, setTab] = useState<HeaderTab>(initialTab);

  const activeHeaders = tab === "request" ? requestHeaders : responseHeaders;
  const activeLabel =
    tab === "request"
      ? "Request headers"
      : tab === "response"
        ? "Response headers"
        : tab === "content"
          ? "Content"
          : "Timing";

  return (
    <div className={className ? `headers-tabs ${className}` : "headers-tabs"}>
      <div className="tabs headers-tablist" role="tablist" aria-label="Header set">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "request"}
          className={tab === "request" ? "tab active" : "tab"}
          onClick={() => setTab("request")}
        >
          Request headers ({requestHeaders.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "response"}
          className={tab === "response" ? "tab active" : "tab"}
          onClick={() => setTab("response")}
        >
          Response headers ({responseHeaders.length})
        </button>
        {showContentTab && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === "content"}
            className={tab === "content" ? "tab active" : "tab"}
            onClick={() => setTab("content")}
          >
            Content
            {bodyEncoding === "base64"
              ? " (base64)"
              : bodyEncoding === "text"
                ? " (text)"
                : ""}
          </button>
        )}
        {showTimingTab && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === "timing"}
            className={tab === "timing" ? "tab active" : "tab"}
            onClick={() => setTab("timing")}
          >
            Timing
          </button>
        )}
      </div>

      <div
        className="headers-tab-panel"
        role="tabpanel"
        aria-label={activeLabel}
      >
        {tab === "content" && showContentTab ? (
          <ContentPanel
            bodyEncoding={bodyEncoding}
            body={body}
            bodyTruncated={bodyTruncated}
          />
        ) : tab === "timing" && showTimingTab ? (
          <TimingPanel timing={timing} navigationTiming={navigationTiming} />
        ) : (
          <div className={tableMaxHeightClass}>
            <HeaderTable headers={activeHeaders} />
          </div>
        )}
      </div>
    </div>
  );
}
