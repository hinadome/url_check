"use client";

import { useState } from "react";
import type { HeaderPair } from "@/lib/types";

export type HeaderTab = "request" | "response";

type HeadersTabsProps = {
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
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

export function HeadersTabs({
  requestHeaders,
  responseHeaders,
  defaultTab = "response",
  className,
  tableMaxHeightClass = "headers-table-wrap",
}: HeadersTabsProps) {
  const [tab, setTab] = useState<HeaderTab>(defaultTab);
  const activeHeaders = tab === "request" ? requestHeaders : responseHeaders;
  const activeLabel = tab === "request" ? "Request headers" : "Response headers";

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
      </div>

      <div
        className="headers-tab-panel"
        role="tabpanel"
        aria-label={activeLabel}
      >
        <div className={tableMaxHeightClass}>
          <HeaderTable headers={activeHeaders} />
        </div>
      </div>
    </div>
  );
}
