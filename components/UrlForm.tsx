"use client";

import { useEffect, useState, type FormEvent } from "react";
import { HeaderEditor } from "./HeaderEditor";
import type {
  DnsOverride,
  FeatureFlags,
  HarFormat,
  HeaderPair,
} from "@/lib/types";

export type UrlFormSubmit = {
  url: string;
  headers: HeaderPair[];
  dnsOverride?: DnsOverride;
  ignoreCertErrors: boolean;
  captureHar: boolean;
  harFormat: HarFormat;
};

type UrlFormProps = {
  onSubmit: (data: UrlFormSubmit) => void;
  loading: boolean;
};

const DEFAULT_FLAGS: FeatureFlags = {
  allowIgnoreCertErrors: true,
  allowCaptureHar: true,
};

export function UrlForm({ onSubmit, loading }: UrlFormProps) {
  const [url, setUrl] = useState("https://example.com");
  const [headers, setHeaders] = useState<HeaderPair[]>([]);
  const [dnsHost, setDnsHost] = useState("");
  const [dnsIp, setDnsIp] = useState("");
  const [ignoreCertErrors, setIgnoreCertErrors] = useState(false);
  const [captureHar, setCaptureHar] = useState(false);
  const [harFormat, setHarFormat] = useState<HarFormat>("zip");
  const [flags, setFlags] = useState<FeatureFlags>(DEFAULT_FLAGS);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/config");
        if (!res.ok) return;
        const data = (await res.json()) as Partial<FeatureFlags>;
        if (cancelled) return;
        setFlags({
          allowIgnoreCertErrors: data.allowIgnoreCertErrors !== false,
          allowCaptureHar: data.allowCaptureHar !== false,
        });
      } catch {
        // Keep default-allow if config endpoint is unreachable
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!flags.allowIgnoreCertErrors) setIgnoreCertErrors(false);
    if (!flags.allowCaptureHar) {
      setCaptureHar(false);
    }
  }, [flags]);

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

    const wantHar = flags.allowCaptureHar && captureHar;
    onSubmit({
      url: trimmed,
      headers: headers.filter((h) => h.name.trim()),
      dnsOverride,
      ignoreCertErrors: flags.allowIgnoreCertErrors && ignoreCertErrors,
      captureHar: wantHar,
      harFormat: wantHar ? harFormat : "zip",
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

      {flags.allowIgnoreCertErrors && (
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
      )}

      {flags.allowCaptureHar && (
        <>
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
                — record the Playwright session for download (not stored on the
                server)
              </span>
            </span>
          </label>

          {captureHar && (
            <fieldset className="har-format" disabled={loading}>
              <legend>HAR format</legend>
              <label className="field-radio">
                <input
                  type="radio"
                  name="harFormat"
                  value="zip"
                  checked={harFormat === "zip"}
                  onChange={() => setHarFormat("zip")}
                />
                <span>
                  Zip (binaries as files)
                  <span className="muted field-checkbox-hint">
                    {" "}
                    — <code>.har.zip</code>, Playwright <code>content: attach</code>
                  </span>
                </span>
              </label>
              <label className="field-radio">
                <input
                  type="radio"
                  name="harFormat"
                  value="json"
                  checked={harFormat === "json"}
                  onChange={() => setHarFormat("json")}
                />
                <span>
                  JSON (binaries as base64)
                  <span className="muted field-checkbox-hint">
                    {" "}
                    — single <code>.har</code>, Playwright <code>content: embed</code>
                  </span>
                </span>
              </label>
            </fieldset>
          )}
        </>
      )}

      <button type="submit" className="btn btn-primary" disabled={loading}>
        {loading ? "Checking…" : "Check URL"}
      </button>
    </form>
  );
}
