import type { CheckResponse, NetworkRequestEntry } from "./types";

function sanitizeFilenamePart(value: string): string {
  return value
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "export";
}

function timestampForFilename(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function exportBasename(result: CheckResponse): string {
  let host = "result";
  try {
    host = new URL(result.finalUrl || "https://export.local").host;
  } catch {
    host = "result";
  }
  return `url-checker-${sanitizeFilenamePart(host)}-${timestampForFilename()}`;
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function toLightResult(result: CheckResponse): CheckResponse {
  return {
    ...result,
    screenshotBase64: "",
    networkRequests: (result.networkRequests ?? []).map((entry) => ({
      ...entry,
      body: "",
      bodyEncoding: "empty",
      bodyTruncated: false,
    })),
  };
}

export function exportJson(
  result: CheckResponse,
  mode: "full" | "light",
): void {
  const payload = mode === "light" ? toLightResult(result) : result;
  const json = JSON.stringify(payload, null, 2);
  downloadBlob(
    `${exportBasename(result)}-${mode}.json`,
    new Blob([json], { type: "application/json;charset=utf-8" }),
  );
}

export function exportScreenshotPng(result: CheckResponse): boolean {
  const base64 = result.screenshotBase64;
  if (!base64) return false;

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  downloadBlob(
    `${exportBasename(result)}.png`,
    new Blob([bytes], { type: "image/png" }),
  );
  return true;
}

export function exportHtmlSource(result: CheckResponse): void {
  downloadBlob(
    `${exportBasename(result)}.html`,
    new Blob([result.html ?? ""], { type: "text/html;charset=utf-8" }),
  );
}

function csvEscape(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/** Metadata-index CSV only — no header maps or body content. */
export function exportNetworkCsv(result: CheckResponse): void {
  const header = [
    "date",
    "url",
    "host",
    "remoteIp",
    "remotePort",
    "status",
    "httpVersion",
    "contentType",
    "contentSize",
    "resourceType",
    "bodyEncoding",
    "bodyTruncated",
    "requestHeaderCount",
    "responseHeaderCount",
  ];

  const rows = (result.networkRequests ?? []).map((entry: NetworkRequestEntry) =>
    [
      entry.date,
      entry.url,
      entry.host,
      entry.remoteIp ?? "",
      entry.remotePort ?? "",
      entry.status,
      entry.httpVersion ?? "",
      entry.contentType,
      entry.contentSize ?? "",
      entry.resourceType,
      entry.bodyEncoding ?? "",
      entry.bodyTruncated ?? false,
      entry.requestHeaders?.length ?? 0,
      entry.responseHeaders?.length ?? 0,
    ]
      .map(csvEscape)
      .join(","),
  );

  const csv = `\uFEFF${[header.join(","), ...rows].join("\n")}\n`;
  downloadBlob(
    `${exportBasename(result)}-network.csv`,
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
}
