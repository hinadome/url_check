"use client";

import { useState } from "react";

type ContentPreviewProps = {
  html: string;
  screenshotBase64: string;
  title: string | null;
};

type Tab = "screenshot" | "html" | "plaintext";

export function ContentPreview({ html, screenshotBase64, title }: ContentPreviewProps) {
  const [tab, setTab] = useState<Tab>("screenshot");

  return (
    <section className="content-preview">
      <div className="preview-header">
        <h2>Full content{title ? `: ${title}` : ""}</h2>
        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "screenshot"}
            className={tab === "screenshot" ? "tab active" : "tab"}
            onClick={() => setTab("screenshot")}
          >
            Screenshot
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "html"}
            className={tab === "html" ? "tab active" : "tab"}
            onClick={() => setTab("html")}
          >
            HTML
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "plaintext"}
            className={tab === "plaintext" ? "tab active" : "tab"}
            onClick={() => setTab("plaintext")}
          >
            Plain text
          </button>
        </div>
      </div>

      {tab === "screenshot" && (
        <div className="screenshot-pane">
          {screenshotBase64 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`data:image/png;base64,${screenshotBase64}`}
              alt={title ? `Screenshot of ${title}` : "Page screenshot"}
            />
          ) : (
            <p className="muted">No screenshot available.</p>
          )}
        </div>
      )}

      {tab === "html" && (
        <div className="html-pane">
          <iframe
            title="HTML preview"
            sandbox=""
            srcDoc={html}
            className="html-iframe"
          />
        </div>
      )}

      {tab === "plaintext" && (
        <div className="plaintext-pane">
          {html ? (
            <pre className="plaintext-content">{html}</pre>
          ) : (
            <p className="muted">No HTML source available.</p>
          )}
        </div>
      )}
    </section>
  );
}
