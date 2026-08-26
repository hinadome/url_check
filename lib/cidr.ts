/**
 * Parse and match IPv4 / IPv6 addresses against CIDR allowlist entries.
 * Single IPs are treated as /32 (v4) or /128 (v6).
 */

function parseIpv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

function expandIpv6(ip: string): bigint | null {
  const lower = ip.toLowerCase();
  if (lower.includes(".")) {
    // IPv4-mapped: ::ffff:a.b.c.d
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (!mapped) return null;
    const v4 = parseIpv4ToInt(mapped[1]);
    if (v4 === null) return null;
    return (BigInt(0xffff) << BigInt(32)) + BigInt(v4);
  }

  const sides = lower.split("::");
  if (sides.length > 2) return null;

  const parseSide = (side: string): number[] => {
    if (!side) return [];
    return side.split(":").map((h) => {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return NaN;
      return parseInt(h, 16);
    });
  };

  let head: number[];
  let tail: number[];
  if (sides.length === 1) {
    head = parseSide(sides[0]);
    tail = [];
    if (head.length !== 8 || head.some((x) => Number.isNaN(x))) return null;
  } else {
    head = parseSide(sides[0]);
    tail = parseSide(sides[1]);
    if (head.some((x) => Number.isNaN(x)) || tail.some((x) => Number.isNaN(x))) {
      return null;
    }
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    head = [...head, ...Array(missing).fill(0), ...tail];
  }

  let out = BigInt(0);
  for (const part of head) {
    out = (out << BigInt(16)) + BigInt(part);
  }
  return out;
}

export function normalizeClientIp(ip: string): string | null {
  const trimmed = ip.trim().toLowerCase();
  if (!trimmed) return null;
  // Strip IPv4-mapped prefix for ACL matching convenience
  const mapped = trimmed.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (parseIpv4ToInt(trimmed) !== null) return trimmed;
  if (expandIpv6(trimmed) !== null) return trimmed;
  return null;
}

type CidrRule =
  | { version: 4; network: number; mask: number }
  | { version: 6; network: bigint; maskBits: number };

function parseCidr(entry: string): CidrRule | null {
  const raw = entry.trim().toLowerCase();
  if (!raw) return null;

  const [addrPart, prefixPart] = raw.split("/");
  const addr = normalizeClientIp(addrPart);
  if (!addr) return null;

  if (parseIpv4ToInt(addr) !== null) {
    const ipInt = parseIpv4ToInt(addr)!;
    let prefix = 32;
    if (prefixPart !== undefined) {
      if (!/^\d+$/.test(prefixPart)) return null;
      prefix = Number(prefixPart);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    }
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return { version: 4, network: (ipInt & mask) >>> 0, mask };
  }

  const ipBig = expandIpv6(addr);
  if (ipBig === null) return null;
  let prefix = 128;
  if (prefixPart !== undefined) {
    if (!/^\d+$/.test(prefixPart)) return null;
    prefix = Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
  }
  const shift = BigInt(128 - prefix);
  const network = prefix === 0 ? BigInt(0) : (ipBig >> shift) << shift;
  return { version: 6, network, maskBits: prefix };
}

export function parseAllowlist(raw: string | undefined): CidrRule[] {
  if (!raw || !raw.trim()) return [];
  const rules: CidrRule[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const rule = parseCidr(part);
    if (rule) rules.push(rule);
  }
  return rules;
}

export function ipMatchesAllowlist(ip: string, rules: CidrRule[]): boolean {
  const normalized = normalizeClientIp(ip);
  if (!normalized || rules.length === 0) return false;

  const v4 = parseIpv4ToInt(normalized);
  if (v4 !== null) {
    for (const rule of rules) {
      if (rule.version === 4 && (v4 & rule.mask) >>> 0 === rule.network) {
        return true;
      }
    }
    return false;
  }

  const v6 = expandIpv6(normalized);
  if (v6 === null) return false;
  for (const rule of rules) {
    if (rule.version !== 6) continue;
    const shift = BigInt(128 - rule.maskBits);
    const network =
      rule.maskBits === 0 ? BigInt(0) : (v6 >> shift) << shift;
    if (network === rule.network) return true;
  }
  return false;
}
