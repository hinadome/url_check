import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { DnsOverride, HeaderPair } from "./types";

const BLOCKED_HEADER_NAMES = new Set(
  [
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "keep-alive",
    "upgrade",
    "proxy-connection",
    "proxy-authorization",
    "te",
    "trailer",
  ].map((h) => h.toLowerCase()),
);

const MAX_HEADER_NAME_LENGTH = 256;
const MAX_HEADER_VALUE_LENGTH = 8192;
const MAX_HEADERS = 50;

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isPrivateOrReservedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const parts = parseIpv4(ip);
    if (!parts) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // ULA
    if (normalized.startsWith("fe80")) return true; // link-local
    if (normalized.startsWith("ff")) return true; // multicast
    // IPv4-mapped IPv6
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateOrReservedIp(mapped[1]);
    return false;
  }

  return true;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  return false;
}

function isValidHostnameLabel(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false;
  if (isIP(hostname)) return false;
  return /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i.test(
    hostname,
  );
}

export async function validateUrl(
  rawUrl: string,
  options?: { skipDnsLookup?: boolean },
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed");
  }

  if (parsed.username || parsed.password) {
    throw new Error("URLs with credentials are not allowed");
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new Error("URL must include a hostname");
  }

  if (isBlockedHostname(hostname)) {
    throw new Error("Local or private hostnames are not allowed");
  }

  const ipVersion = isIP(hostname);
  if (ipVersion) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error("Private or reserved IP addresses are not allowed");
    }
    return parsed;
  }

  if (options?.skipDnsLookup) {
    return parsed;
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Could not resolve hostname");
  }

  if (!addresses.length) {
    throw new Error("Could not resolve hostname");
  }

  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new Error("Hostname resolves to a private or reserved address");
    }
  }

  return parsed;
}

export function validateDnsOverride(
  override: Partial<DnsOverride> | undefined,
  urlHostname: string,
): DnsOverride | null {
  if (!override) {
    return null;
  }

  const ip = (override.ip ?? "").trim();
  const hostInput = (override.host ?? "").trim();

  if (!ip && !hostInput) {
    return null;
  }

  if (!ip) {
    throw new Error("Force-resolve IP is required when DNS override is set");
  }

  if (!isIP(ip)) {
    throw new Error("Force-resolve IP is invalid");
  }

  if (isPrivateOrReservedIp(ip)) {
    throw new Error("Force-resolve IP cannot be private or reserved");
  }

  const host = normalizeHostname(hostInput || urlHostname);

  if (!host) {
    throw new Error("Force-resolve host is required");
  }

  if (isBlockedHostname(host)) {
    throw new Error("Force-resolve host is not allowed");
  }

  if (!isValidHostnameLabel(host)) {
    throw new Error("Force-resolve host is invalid");
  }

  if (host !== normalizeHostname(urlHostname)) {
    throw new Error("Force-resolve host must match the URL hostname");
  }

  return { host, ip };
}

export function validateHeaders(
  headers: HeaderPair[] | undefined,
): Record<string, string> {
  if (!headers || headers.length === 0) {
    return {};
  }

  if (headers.length > MAX_HEADERS) {
    throw new Error(`At most ${MAX_HEADERS} headers are allowed`);
  }

  const result: Record<string, string> = {};

  for (const header of headers) {
    const name = (header.name ?? "").trim();
    const value = header.value ?? "";

    if (!name) {
      continue;
    }

    if (name.length > MAX_HEADER_NAME_LENGTH) {
      throw new Error("Header name is too long");
    }
    if (value.length > MAX_HEADER_VALUE_LENGTH) {
      throw new Error("Header value is too long");
    }

    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      throw new Error(`Invalid header name: ${name}`);
    }

    if (/[\r\n]/.test(value)) {
      throw new Error("Header values cannot contain CR or LF");
    }

    const lower = name.toLowerCase();
    if (BLOCKED_HEADER_NAMES.has(lower)) {
      throw new Error(`Header "${name}" is not allowed`);
    }

    result[name] = value;
  }

  return result;
}
