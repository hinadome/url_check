"use client";

import { useEffect, useState, type FormEvent } from "react";
import { HeaderEditor } from "./HeaderEditor";
import type {
  DnsOverride,
  FeatureFlags,
  HarFormat,
  HeaderPair,
  NetLogCaptureMode,
} from "@/lib/types";

export type UrlFormSubmit = {
  url: string;
  headers: HeaderPair[];
  dnsOverride?: DnsOverride;
  ignoreCertErrors: boolean;
  captureHar: boolean;
  harFormat: HarFormat;
  captureNetLog: boolean;
  netLogCaptureMode: NetLogCaptureMode;
  disableHttp2: boolean;
  disableHttp3: boolean;
  http11Only: boolean;
};

type UrlFormProps = {
  onSubmit: (data: UrlFormSubmit) => void;
  loading: boolean;
};

const DEFAULT_FLAGS: FeatureFlags = {
  allowIgnoreCertErrors: true,
  allowCaptureHar: true,
  allowCaptureNetLog: true,
  allowHttpProtocolControls: true,
};

export function UrlForm({ onSubmit, loading }: UrlFormProps) {
  const [url, setUrl] = useState("https://example.com");
  const [headers, setHeaders] = useState<HeaderPair[]>([]);
  const [dnsHost, setDnsHost] = useState("");
  const [dnsIp, setDnsIp] = useState("");
  const [ignoreCertErrors, setIgnoreCertErrors] = useState(false);
  const [captureHar, setCaptureHar] = useState(false);
  const [harFormat, setHarFormat] = useState<HarFormat>("json");
  const [captureNetLog, setCaptureNetLog] = useState(false);
  const [netLogCaptureMode, setNetLogCaptureMode] =
    useState<NetLogCaptureMode>("default");
  const [disableHttp2, setDisableHttp2] = useState(false);
  const [disableHttp3, setDisableHttp3] = useState(false);
  const [http11Only, setHttp11Only] = useState(false);
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
          allowCaptureNetLog: data.allowCaptureNetLog !== false,
          allowHttpProtocolControls: data.allowHttpProtocolControls !== false,
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
    if (!flags.allowCaptureNetLog) {
      setCaptureNetLog(false);
    }
    if (!flags.allowHttpProtocolControls) {
      setDisableHttp2(false);
      setDisableHttp3(false);
      setHttp11Only(false);
    }
  }, [flags]);

  const handleHttp11Only = (checked: boolean) => {
    setHttp11Only(checked);
    if (checked) {
      setDisableHttp2(true);
      setDisableHttp3(true);
    } else {
      setDisableHttp2(false);
      setDisableHttp3(false);
    }
  };

  const handleDisableHttp2 = (checked: boolean) => {
    setDisableHttp2(checked);
    if (!checked) setHttp11Only(false);
    else if (disableHttp3) setHttp11Only(true);
  };

  const handleDisableHttp3 = (checked: boolean) => {
    setDisableHttp3(checked);
    if (!checked) setHttp11Only(false);
    else if (disableHttp2) setHttp11Only(true);
  };

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
    const wantNetLog = flags.allowCaptureNetLog && captureNetLog;
    const wantProtocol = flags.allowHttpProtocolControls;
    onSubmit({
      url: trimmed,
      headers: headers.filter((h) => h.name.trim()),
      dnsOverride,
      ignoreCertErrors: flags.allowIgnoreCertErrors && ignoreCertErrors,
      captureHar: wantHar,
      harFormat: wantHar ? harFormat : "json",
      captureNetLog: wantNetLog,
      netLogCaptureMode: wantNetLog ? netLogCaptureMode : "default",
      disableHttp2: wantProtocol && disableHttp2,
      disableHttp3: wantProtocol && disableHttp3,
      http11Only: wantProtocol && http11Only,
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

      {flags.allowHttpProtocolControls && (
        <fieldset className="http-protocol" disabled={loading}>
          <legend>HTTP protocol (optional)</legend>
          <p className="muted">
            Restricts Chromium launch flags; negotiated version still shown in
            Network → HTTP. HTTP/3 is disabled via{" "}
            <code>--disable-quic</code>.
          </p>
          <label className="field-checkbox">
            <input
              type="checkbox"
              checked={http11Only}
              onChange={(e) => handleHttp11Only(e.target.checked)}
            />
            <span>
              HTTP/1.1 only
              <span className="muted field-checkbox-hint">
                {" "}
                — preset: disable HTTP/2 and HTTP/3
              </span>
            </span>
          </label>
          <label className="field-checkbox">
            <input
              type="checkbox"
              checked={disableHttp2}
              onChange={(e) => handleDisableHttp2(e.target.checked)}
            />
            <span>
              Disable HTTP/2
              <span className="muted field-checkbox-hint">
                {" "}
                — Chromium <code>--disable-http2</code>
              </span>
            </span>
          </label>
          <label className="field-checkbox">
            <input
              type="checkbox"
              checked={disableHttp3}
              onChange={(e) => handleDisableHttp3(e.target.checked)}
            />
            <span>
              Disable HTTP/3 (QUIC)
              <span className="muted field-checkbox-hint">
                {" "}
                — Chromium <code>--disable-quic</code>
              </span>
            </span>
          </label>
        </fieldset>
      )}

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
            </fieldset>
          )}
        </>
      )}

      {flags.allowCaptureNetLog && (
        <>
          <label className="field-checkbox">
            <input
              type="checkbox"
              checked={captureNetLog}
              onChange={(e) => setCaptureNetLog(e.target.checked)}
              disabled={loading}
            />
            <span>
              Capture NetLog
              <span className="muted field-checkbox-hint">
                {" "}
                — Chromium network stack log for{" "}
                <a
                  href="https://netlog-viewer.appspot.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  NetLog Viewer
                </a>{" "}
                (not stored on the server)
              </span>
            </span>
          </label>

          {captureNetLog && (
            <fieldset className="har-format" disabled={loading}>
              <legend>NetLog capture mode</legend>
              <label className="field-radio">
                <input
                  type="radio"
                  name="netLogCaptureMode"
                  value="default"
                  checked={netLogCaptureMode === "default"}
                  onChange={() => setNetLogCaptureMode("default")}
                />
                <span>
                  Strip private
                  <span className="muted field-checkbox-hint">
                    {" "}
                    — default; omit cookies / auth / raw bytes
                  </span>
                </span>
              </label>
              <label className="field-radio">
                <input
                  type="radio"
                  name="netLogCaptureMode"
                  value="includeSensitive"
                  checked={netLogCaptureMode === "includeSensitive"}
                  onChange={() => setNetLogCaptureMode("includeSensitive")}
                />
                <span>
                  Include sensitive
                  <span className="muted field-checkbox-hint">
                    {" "}
                    — cookies / auth headers (treat download as secret)
                  </span>
                </span>
              </label>
              <label className="field-radio">
                <input
                  type="radio"
                  name="netLogCaptureMode"
                  value="everything"
                  checked={netLogCaptureMode === "everything"}
                  onChange={() => setNetLogCaptureMode("everything")}
                />
                <span>
                  Everything (raw bytes)
                  <span className="muted field-checkbox-hint">
                    {" "}
                    — largest / most sensitive; soft size cap still applies
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
