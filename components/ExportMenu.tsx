"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  exportHar,
  exportHtmlSource,
  exportJson,
  exportNetworkCsv,
  exportScreenshotPng,
} from "@/lib/export";
import type { CheckResponse } from "@/lib/types";

type ExportMenuProps = {
  result: CheckResponse;
};

export function ExportMenu({ result }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const hasScreenshot = Boolean(result.screenshotBase64);
  const hasHar = Boolean(result.har);
  const harError = result.harError ?? null;

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const run = (action: () => void) => {
    action();
    setOpen(false);
  };

  return (
    <div className="export-menu" ref={rootRef}>
      <button
        type="button"
        className="btn btn-secondary"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        Export ▾
      </button>

      {open && (
        <ul id={menuId} className="export-menu-list" role="menu">
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="export-menu-item"
              onClick={() => run(() => exportJson(result, "light"))}
            >
              <span>Download JSON (light)</span>
              <span className="muted">Recommended — keeps headers, strips screenshot & bodies</span>
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="export-menu-item"
              onClick={() => run(() => exportJson(result, "full"))}
            >
              <span>Download JSON (full)</span>
              <span className="muted">Includes screenshot & network bodies</span>
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="export-menu-item"
              disabled={!hasScreenshot}
              onClick={() =>
                run(() => {
                  exportScreenshotPng(result);
                })
              }
            >
              <span>Download screenshot (PNG)</span>
              {!hasScreenshot && (
                <span className="muted">No screenshot available</span>
              )}
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="export-menu-item"
              onClick={() => run(() => exportHtmlSource(result))}
            >
              <span>Download HTML source</span>
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="export-menu-item"
              disabled={!hasHar}
              onClick={() =>
                run(() => {
                  exportHar(result);
                })
              }
            >
              <span>Download HAR</span>
              {hasHar ? (
                <span className="muted">Playwright session archive (HAR 1.2)</span>
              ) : harError ? (
                <span className="muted export-menu-item-error">{harError}</span>
              ) : (
                <span className="muted">Enable “Capture HAR” on the form, then check again</span>
              )}
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="export-menu-item"
              onClick={() => run(() => exportNetworkCsv(result))}
            >
              <span>Download network CSV (index)</span>
              <span className="muted">Metadata only — no headers or bodies</span>
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
