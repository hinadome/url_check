"use client";

import { Fragment, useState } from "react";
import { HeadersTabs } from "./HeadersTabs";
import type { NetworkRequestEntry } from "@/lib/types";

type NetworkRequestsPanelProps = {
  requests: NetworkRequestEntry[];
};

const ALL = "";
const DETAIL_COLSPAN = 8;

function formatBytes(size: number | null): string {
  if (size === null || Number.isNaN(size)) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function shortContentType(value: string): string {
  if (!value) return "—";
  return value.split(";")[0].trim() || value;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  });
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function rowKey(req: NetworkRequestEntry, index: number): string {
  return `${index}-${req.date}-${req.url}`;
}

export function NetworkRequestsPanel({ requests }: NetworkRequestsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [openRowKey, setOpenRowKey] = useState<string | null>(null);
  const [urlQuery, setUrlQuery] = useState("");
  const [hostFilter, setHostFilter] = useState(ALL);
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [contentTypeFilter, setContentTypeFilter] = useState(ALL);

  const hostOptions = uniqueSorted(requests.map((r) => r.host));
  const statusOptions = uniqueSorted(requests.map((r) => String(r.status || "")));
  const typeOptions = uniqueSorted(requests.map((r) => r.resourceType));
  const contentTypeOptions = uniqueSorted(
    requests.map((r) => shortContentType(r.contentType)).filter((v) => v !== "—"),
  );

  const query = urlQuery.trim().toLowerCase();
  const filtered = requests.filter((req) => {
    if (query && !req.url.toLowerCase().includes(query)) return false;
    if (hostFilter && req.host !== hostFilter) return false;
    if (statusFilter && String(req.status) !== statusFilter) return false;
    if (typeFilter && req.resourceType !== typeFilter) return false;
    if (
      contentTypeFilter &&
      shortContentType(req.contentType) !== contentTypeFilter
    ) {
      return false;
    }
    return true;
  });

  const hasActiveFilters =
    Boolean(query) ||
    Boolean(hostFilter) ||
    Boolean(statusFilter) ||
    Boolean(typeFilter) ||
    Boolean(contentTypeFilter);

  const clearFilters = () => {
    setUrlQuery("");
    setHostFilter(ALL);
    setStatusFilter(ALL);
    setTypeFilter(ALL);
    setContentTypeFilter(ALL);
  };

  const toggleRow = (key: string) => {
    setOpenRowKey((current) => (current === key ? null : key));
  };

  return (
    <section
      className={
        expanded ? "network-requests network-requests--expanded" : "network-requests"
      }
    >
      <div className="network-requests-header">
        <div>
          <h2>Network requests</h2>
          <p className="muted">
            All URLs requested by Playwright while loading the page. Showing{" "}
            {filtered.length} of {requests.length} responses
            {hasActiveFilters ? " (filtered)" : ""}. Expand a row, then use tabs for
            request or response headers, or response content.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setExpanded((value) => !value)}
          aria-pressed={expanded}
        >
          {expanded ? "Collapse width" : "Expand width"}
        </button>
      </div>

      {requests.length === 0 ? (
        <p className="muted">No network requests captured.</p>
      ) : (
        <>
          <div className="network-filters">
            <label className="network-filter-field">
              <span>URL contains</span>
              <input
                type="search"
                value={urlQuery}
                onChange={(e) => setUrlQuery(e.target.value)}
                placeholder="Filter by URL…"
                autoComplete="off"
              />
            </label>
            <label className="network-filter-field">
              <span>Remote host</span>
              <select
                value={hostFilter}
                onChange={(e) => setHostFilter(e.target.value)}
              >
                <option value={ALL}>All hosts</option>
                {hostOptions.map((host) => (
                  <option key={host} value={host}>
                    {host}
                  </option>
                ))}
              </select>
            </label>
            <label className="network-filter-field">
              <span>Status</span>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value={ALL}>All statuses</option>
                {statusOptions.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <label className="network-filter-field">
              <span>Type</span>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value={ALL}>All types</option>
                {typeOptions.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label className="network-filter-field">
              <span>Content type</span>
              <select
                value={contentTypeFilter}
                onChange={(e) => setContentTypeFilter(e.target.value)}
              >
                <option value={ALL}>All content types</option>
                {contentTypeOptions.map((ctype) => (
                  <option key={ctype} value={ctype}>
                    {ctype}
                  </option>
                ))}
              </select>
            </label>
            <div className="network-filter-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={clearFilters}
                disabled={!hasActiveFilters}
              >
                Clear filters
              </button>
            </div>
          </div>

          {filtered.length === 0 ? (
            <p className="muted">No requests match the current filters.</p>
          ) : (
            <div className="network-table-wrap">
              <table className="network-table">
                <thead>
                  <tr>
                    <th scope="col" className="col-toggle">
                      <span className="sr-only">Headers</span>
                    </th>
                    <th scope="col" className="col-date">
                      Date
                    </th>
                    <th scope="col" className="col-url">
                      URL
                    </th>
                    <th scope="col" className="col-host">
                      Remote host
                    </th>
                    <th scope="col" className="col-status">
                      Status
                    </th>
                    <th scope="col" className="col-ctype">
                      Content type
                    </th>
                    <th scope="col" className="col-size">
                      Content size
                    </th>
                    <th scope="col" className="col-type">
                      Type
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((req, index) => {
                    const key = rowKey(req, index);
                    const isOpen = openRowKey === key;
                    const reqHeaders = req.requestHeaders ?? [];
                    const resHeaders = req.responseHeaders ?? [];

                    return (
                      <Fragment key={key}>
                        <tr
                          className={
                            isOpen ? "network-row network-row-open" : "network-row"
                          }
                        >
                          <td className="network-toggle">
                            <button
                              type="button"
                              className="btn btn-secondary network-toggle-btn"
                              aria-expanded={isOpen}
                              aria-label={
                                isOpen
                                  ? "Hide request and response headers"
                                  : "Show request and response headers"
                              }
                              onClick={() => toggleRow(key)}
                            >
                              {isOpen ? "▾" : "▸"}
                            </button>
                          </td>
                          <td className="network-date" title={req.date}>
                            {formatDate(req.date)}
                          </td>
                          <td className="network-url" title={req.url}>
                            {req.url}
                          </td>
                          <td className="network-host" title={req.host || undefined}>
                            {req.host || "—"}
                          </td>
                          <td className="network-status">{req.status || "—"}</td>
                          <td
                            className="network-ctype"
                            title={req.contentType || undefined}
                          >
                            {shortContentType(req.contentType)}
                          </td>
                          <td className="network-size">
                            {formatBytes(req.contentSize)}
                          </td>
                          <td className="network-type">
                            {req.resourceType || "—"}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="network-detail-row">
                            <td colSpan={DETAIL_COLSPAN}>
                              <div className="network-detail">
                                <HeadersTabs
                                  key={key}
                                  requestHeaders={reqHeaders}
                                  responseHeaders={resHeaders}
                                  bodyEncoding={req.bodyEncoding ?? "empty"}
                                  body={req.body ?? ""}
                                  bodyTruncated={req.bodyTruncated ?? false}
                                  defaultTab="response"
                                  tableMaxHeightClass="network-headers-table-wrap"
                                />
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
