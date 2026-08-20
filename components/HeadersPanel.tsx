"use client";

import { HeadersTabs } from "./HeadersTabs";
import type { HeaderPair } from "@/lib/types";

type HeadersPanelProps = {
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
};

export function HeadersPanel({ requestHeaders, responseHeaders }: HeadersPanelProps) {
  return (
    <section className="headers-panel">
      <h2>HTTP headers</h2>
      <p className="muted">
        Captured from the main document navigation (request as sent by the browser,
        response as returned by the server). Use the tabs to switch between sets.
      </p>
      <HeadersTabs
        requestHeaders={requestHeaders}
        responseHeaders={responseHeaders}
        defaultTab="response"
      />
    </section>
  );
}
