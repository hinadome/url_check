"use client";

import { useState, type FormEvent } from "react";
import { HeaderEditor } from "./HeaderEditor";
import type { DnsOverride, HeaderPair } from "@/lib/types";

export type UrlFormSubmit = {
  url: string;
  headers: HeaderPair[];
  dnsOverride?: DnsOverride;
  ignoreCertErrors: boolean;
  captureHar: boolean;
};

type UrlFormProps = {
  onSubmit: (data: UrlFormSubmit) => void;
  loading: boolean;
};

export function UrlForm({ onSubmit, loading }: UrlFormProps) {
  const [url, setUrl] = useState("https://example.com");
  const [headers, setHeaders] = useState<HeaderPair[]>([]);
  const [dnsHost, setDnsHost] = useState("");
  const [dnsIp, setDnsIp] = useState("");
  const [ignoreCertErrors, setIgnoreCertErrors] = useState(false);
  const [captureHar, setCaptureHar] = useState(false);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;

    const host = dnsHost.trim();
    const ip = dnsIp.trim();
    const dnsOverride =
      host || ip
        ? {
            host: host || (() => {
              try {
                return new URL(trimmed).hostname;
              } catch {
                return "";
              }
            })(),
            ip,
          }
        : undefined;

    onSubmit({
      url: trimmed,
      headers: headers.filter((h) => h.name.trim()),
      dnsOverride,
      ignoreCertErrors,
      captureHar,
    });
  };

  return (
    <form className="url-form" onSubmit={handleSubmit}>
      <label className="field">
        <span>URL</span>
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com"
          disabled={loading}
        />
      </label>

      <fieldset className="dns-override">
        <legend>Force DNS resolution (optional)</legend>
        <p className="muted">
          Map the URL hostname to a specific IP inside Chromium, bypassing system
          DNS. Host must match the URL hostname. Private/reserved IPs are blocked.
        </p>
        <div className="dns-override-row">
          <label className="field">
            <span>Hostname</span>
            <input
              type="text"
              value={dnsHost}
              onChange={(e) => setDnsHost(e.target.value)}
              placeholder="Leave blank to use URL hostname"
              disabled={loading}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>IP address</span>
            <input
              type="text"
              value={dnsIp}
              onChange={(e) => setDnsIp(e.target.value)}
              placeholder="e.g. 203.0.113.10"
              disabled={loading}
              autoComplete="off"
            />
          </label>
        </div>
      </fieldset>

      <HeaderEditor headers={headers} onChange={setHeaders} disabled={loading} />

      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={ignoreCertErrors}
          onChange={(e) => setIgnoreCertErrors(e.target.checked)}
          disabled={loading}
        />
        <span>
          Ignore certificate errors
          <span className="muted field-checkbox-hint">
            {" "}
            — allow self-signed / expired TLS (Playwright{" "}
            <code>ignoreHTTPSErrors</code>)
          </span>
        </span>
      </label>

      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={captureHar}
          onChange={(e) => setCaptureHar(e.target.checked)}
          disabled={loading}
        />
        <span>
          Capture HAR
          <span className="muted field-checkbox-hint">
            {" "}
            — record the Playwright session as a HAR file for download after the
            check (not stored on the server)
          </span>
        </span>
      </label>

      <button type="submit" className="btn btn-primary" disabled={loading}>
        {loading ? "Checking…" : "Check URL"}
      </button>
    </form>
  );
}
