"use client";

import { Fragment, useState } from "react";
import type { NetworkSsrfBlockedRequestEntry } from "@/lib/types";

type NetworkSsrfRequestsPanelProps = {
  requests: NetworkSsrfBlockedRequestEntry[];
};

const ALL = "";
const DETAIL_COLSPAN = 7;

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

function rowKey(req: NetworkSsrfBlockedRequestEntry, index: number): string {
  return `ssrf-${index}-${req.date}-${req.method}-${req.url}`;
}

export function NetworkSsrfRequestsPanel({
  requests,
}: NetworkSsrfRequestsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [openRowKey, setOpenRowKey] = useState<string | null>(null);
  const [urlQuery, setUrlQuery] = useState("");
  const [hostFilter, setHostFilter] = useState(ALL);
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [reasonQuery, setReasonQuery] = useState("");

  if (requests.length === 0) {
    return null;
  }

  const hostOptions = uniqueSorted(requests.map((r) => r.host));
  const typeOptions = uniqueSorted(requests.map((r) => r.resourceType));

  const urlQ = urlQuery.trim().toLowerCase();
  const reasonQ = reasonQuery.trim().toLowerCase();
  const filtered = requests.filter((req) => {
    if (urlQ && !req.url.toLowerCase().includes(urlQ)) return false;
    if (hostFilter && req.host !== hostFilter) return false;
    if (typeFilter && req.resourceType !== typeFilter) return false;
    if (reasonQ && !req.blockReason.toLowerCase().includes(reasonQ)) {
      return false;
    }
    return true;
  });

  const hasActiveFilters =
    Boolean(urlQ) ||
    Boolean(hostFilter) ||
    Boolean(typeFilter) ||
    Boolean(reasonQ);

  const clearFilters = () => {
    setUrlQuery("");
    setHostFilter(ALL);
    setTypeFilter(ALL);
    setReasonQuery("");
  };

  const toggleRow = (key: string) => {
    setOpenRowKey((current) => (current === key ? null : key));
  };

  return (
    <section
      className={
        expanded
          ? "network-requests network-ssrf-requests network-requests--expanded"
          : "network-requests network-ssrf-requests"
      }
    >
      <div className="network-requests-header">
        <div>
          <h2>SSRF requests</h2>
          <p className="muted">
            Subresources blocked by the SSRF browser guard (Playwright route
            abort before fetch). Showing {filtered.length} of {requests.length}
            {hasActiveFilters ? " (filtered)" : ""}. Expand a row for request
            headers and the block reason.
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

      <div className="network-filters">
        <label className="network-filter-field network-filter-field--grow">
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
        <label className="network-filter-field network-filter-field--grow">
          <span>Reason contains</span>
          <input
            type="search"
            value={reasonQuery}
            onChange={(e) => setReasonQuery(e.target.value)}
            placeholder="e.g. Blocked scheme"
            autoComplete="off"
          />
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
        <p className="muted">No SSRF requests match the current filters.</p>
      ) : (
        <div className="network-table-wrap">
          <table className="network-table">
            <thead>
              <tr>
                <th scope="col" className="col-toggle">
                  <span className="sr-only">Details</span>
                </th>
                <th scope="col" className="col-date">
                  Date
                </th>
                <th scope="col" className="col-method">
                  Method
                </th>
                <th scope="col" className="col-url">
                  URL
                </th>
                <th scope="col" className="col-host">
                  Remote host
                </th>
                <th scope="col" className="col-type">
                  Type
                </th>
                <th scope="col" className="col-failure">
                  Block reason
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((req, index) => {
                const key = rowKey(req, index);
                const isOpen = openRowKey === key;
                const headers = req.requestHeaders ?? [];

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
                          onClick={() => toggleRow(key)}
                        >
                          {isOpen ? "−" : "+"}
                        </button>
                      </td>
                      <td className="network-date" title={req.date}>
                        {formatDate(req.date)}
                      </td>
                      <td className="network-method">{req.method || "—"}</td>
                      <td className="network-url" title={req.url}>
                        {req.url}
                      </td>
                      <td className="network-host" title={req.host || undefined}>
                        {req.host || "—"}
                      </td>
                      <td className="network-type">{req.resourceType || "—"}</td>
                      <td className="network-failure" title={req.blockReason}>
                        {req.blockReason}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="network-detail-row">
                        <td colSpan={DETAIL_COLSPAN}>
                          <div className="network-detail">
                            <p className="network-failure-message">
                              <strong>Block reason:</strong> {req.blockReason}
                            </p>
                            {headers.length === 0 ? (
                              <p className="muted">No request headers captured.</p>
                            ) : (
                              <div className="network-headers-table-wrap">
                                <table className="headers-table">
                                  <thead>
                                    <tr>
                                      <th scope="col">Name</th>
                                      <th scope="col">Value</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {headers.map((h) => (
                                      <tr key={`${h.name}:${h.value}`}>
                                        <td className="header-name">{h.name}</td>
                                        <td className="header-value">{h.value}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
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
    </section>
  );
}
