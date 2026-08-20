"use client";

import { useState } from "react";
import type { ResourceSummaryData } from "@/lib/types";

type ResourceSummaryProps = {
  resources: ResourceSummaryData;
};

const CATEGORIES: { key: keyof ResourceSummaryData; label: string }[] = [
  { key: "links", label: "Referenced URLs" },
  { key: "images", label: "Image URLs" },
  { key: "stylesheets", label: "CSS URLs" },
  { key: "scripts", label: "Script URLs" },
  { key: "iframes", label: "Iframe URLs" },
  { key: "other", label: "Other URLs" },
];

function ResourceCategory({
  label,
  urls,
}: {
  label: string;
  urls: string[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="resource-category">
      <button
        type="button"
        className="resource-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>
          {label} <strong>({urls.length})</strong>
        </span>
        <span className="chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul className="resource-list">
          {urls.length === 0 ? (
            <li className="muted">None</li>
          ) : (
            urls.map((url) => (
              <li key={url}>
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {url}
                </a>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

export function ResourceSummary({ resources }: ResourceSummaryProps) {
  const total = CATEGORIES.reduce((sum, c) => sum + resources[c.key].length, 0);

  return (
    <section className="resource-summary">
      <h2>Resource summary</h2>
      <p className="muted">{total} unique URLs extracted from the page.</p>
      <div className="resource-categories">
        {CATEGORIES.map(({ key, label }) => (
          <ResourceCategory key={key} label={label} urls={resources[key]} />
        ))}
      </div>
    </section>
  );
}
