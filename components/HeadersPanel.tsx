"use client";

import type { HeaderPair } from "@/lib/types";

type HeadersPanelProps = {
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
};

function HeaderTable({ title, headers }: { title: string; headers: HeaderPair[] }) {
  return (
    <div className="headers-block">
      <h3>
        {title} <span className="muted">({headers.length})</span>
      </h3>
      {headers.length === 0 ? (
        <p className="muted">None captured.</p>
      ) : (
        <div className="headers-table-wrap">
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
        </div>
      )}
    </div>
  );
}

export function HeadersPanel({ requestHeaders, responseHeaders }: HeadersPanelProps) {
  return (
    <section className="headers-panel">
      <h2>HTTP headers</h2>
      <p className="muted">
        Captured from the main document navigation (request as sent by the browser,
        response as returned by the server).
      </p>
      <div className="headers-grid">
        <HeaderTable title="Request headers" headers={requestHeaders} />
        <HeaderTable title="Response headers" headers={responseHeaders} />
      </div>
    </section>
  );
}
