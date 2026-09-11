import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function embeddedIpv4FromIpv6(normalized: string): string | null {
  const lower = normalized.toLowerCase();

  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];

  const nat64Dotted = lower.match(
    /^64:ff9b:(?:[0-9a-f:]*::?[0-9a-f:]*)?(\d+\.\d+\.\d+\.\d+)$/,
  );
  if (nat64Dotted) return nat64Dotted[1];

  const nat64Hex = lower.match(
    /^64:ff9b(?::[0-9a-f]{1,4}){0,6}:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  if (nat64Hex) {
    const hi = parseInt(nat64Hex[1], 16);
    const lo = parseInt(nat64Hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  const sixToFour = lower.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})/);
  if (sixToFour) {
    const hi = parseInt(sixToFour[1], 16);
    const lo = parseInt(sixToFour[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return null;
}

export function isPrivateOrReservedIp(ip: string): boolean {
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

    const embedded = embeddedIpv4FromIpv6(normalized);
    if (embedded && isPrivateOrReservedIp(embedded)) return true;

    return false;
  }

  return true;
}

export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

export function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal")
  ) {
    return true;
  }
  return false;
}

export function isValidHostnameLabel(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false;
  if (isIP(hostname)) return false;
  return /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i.test(
    hostname,
  );
}

export type RequestSafetyResult =
  | { safe: true }
  | { safe: false; reason: string };

function unsafe(reason: string): RequestSafetyResult {
  return { safe: false, reason };
}

export async function assertPublicResolvedAddresses(
  hostname: string,
): Promise<RequestSafetyResult> {
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return unsafe("DNS resolution failed");
  }

  if (!addresses.length) {
    return unsafe("DNS resolution returned no addresses");
  }

  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      return unsafe("Hostname resolves to a private or reserved address");
    }
  }

  return { safe: true };
}

/** Pick a public IP to pin for Chromium MAP (prefer IPv4). */
export function selectPinnedPublicIp(
  addresses: { address: string; family: number }[],
): string | null {
  const publicAddrs = addresses.filter(
    (a) => !isPrivateOrReservedIp(a.address),
  );
  if (!publicAddrs.length) return null;
  const v4 = publicAddrs.find((a) => a.family === 4);
  return (v4 ?? publicAddrs[0]).address;
}

export async function evaluateRequestUrl(
  rawUrl: string,
  cache?: Map<string, RequestSafetyResult>,
): Promise<RequestSafetyResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return unsafe("Invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return unsafe(`Blocked scheme: ${parsed.protocol.replace(":", "")}`);
  }

  if (parsed.username || parsed.password) {
    return unsafe("URLs with credentials are not allowed");
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return unsafe("URL must include a hostname");
  }

  if (isBlockedHostname(hostname)) {
    return unsafe("Blocked hostname");
  }

  const ipVersion = isIP(hostname);
  if (ipVersion) {
    if (isPrivateOrReservedIp(hostname)) {
      return unsafe("Private or reserved IP address");
    }
    return { safe: true };
  }

  const cacheKey = normalizeHostname(hostname);
  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  const result = await assertPublicResolvedAddresses(hostname);
  cache?.set(cacheKey, result);
  return result;
}
