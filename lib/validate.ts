import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  assertPublicResolvedAddresses,
  isBlockedHostname,
  isPrivateOrReservedIp,
  isValidHostnameLabel,
  normalizeHostname,
  selectPinnedPublicIp,
} from "./ssrf-policy";
import type { DnsOverride, HeaderPair, ValidatedUrlTarget } from "./types";

export type { ValidatedUrlTarget } from "./types";

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

export type ValidateUrlOptions = {
  /** When set, skip DNS lookup and use this host/IP (Force DNS UI). */
  dnsOverride?: DnsOverride;
  /** @deprecated Use dnsOverride instead. */
  skipDnsLookup?: boolean;
};

export async function validateUrlWithPin(
  input: string,
  options: ValidateUrlOptions = {},
): Promise<ValidatedUrlTarget> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("URL is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
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
    return { url: parsed, host: hostname, pinnedIp: hostname };
  }

  if (!isValidHostnameLabel(hostname)) {
    throw new Error("Invalid hostname");
  }

  const override = options.dnsOverride;
  if (override) {
    if (isPrivateOrReservedIp(override.ip)) {
      throw new Error("Force-resolve IP cannot be private or reserved");
    }
    if (override.host !== hostname) {
      throw new Error("Force-resolve host must match the URL hostname");
    }
    return { url: parsed, host: hostname, pinnedIp: override.ip };
  }

  if (options.skipDnsLookup) {
    return { url: parsed, host: hostname, pinnedIp: null };
  }

  const safety = await assertPublicResolvedAddresses(hostname);
  if (!safety.safe) {
    throw new Error(
      safety.reason === "DNS resolution failed"
        ? "Could not resolve hostname"
        : safety.reason,
    );
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Could not resolve hostname");
  }

  const pinnedIp = selectPinnedPublicIp(addresses);
  if (!pinnedIp) {
    throw new Error("Hostname resolves to a private or reserved address");
  }

  return { url: parsed, host: hostname, pinnedIp };
}

export async function validateUrl(
  input: string,
  options: ValidateUrlOptions = {},
): Promise<URL> {
  const { url } = await validateUrlWithPin(input, options);
  return url;
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

export { isPrivateOrReservedIp } from "./ssrf-policy";
