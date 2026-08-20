"use client";

import { useState } from "react";
import type { HeaderPair, NetworkBodyEncoding } from "@/lib/types";

export type HeaderTab = "request" | "response" | "content";

type HeadersTabsProps = {
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  /** When set, shows a Content tab (network rows). */
  bodyEncoding?: NetworkBodyEncoding;
  body?: string;
  bodyTruncated?: boolean;
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

export function HeadersTabs({
  requestHeaders,
  responseHeaders,
  bodyEncoding,
  body = "",
  bodyTruncated = false,
  defaultTab = "response",
  className,
  tableMaxHeightClass = "headers-table-wrap",
}: HeadersTabsProps) {
  const showContentTab = bodyEncoding !== undefined;
  const initialTab =
    defaultTab === "content" && !showContentTab ? "response" : defaultTab;
  const [tab, setTab] = useState<HeaderTab>(initialTab);

  const activeHeaders = tab === "request" ? requestHeaders : responseHeaders;
  const activeLabel =
    tab === "request"
      ? "Request headers"
      : tab === "response"
        ? "Response headers"
        : "Content";

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
        ) : (
          <div className={tableMaxHeightClass}>
            <HeaderTable headers={activeHeaders} />
          </div>
        )}
      </div>
    </div>
  );
}
