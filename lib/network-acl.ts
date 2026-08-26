import { ipMatchesAllowlist, parseAllowlist } from "./cidr";
import { envFlagOffByDefault } from "./env-flags";

export type NetworkAclConfig = {
  enabled: boolean;
  /** Parsed allowlist; empty when enabled means deny-all */
  allowlistRaw: string;
};

export function getNetworkAclConfig(): NetworkAclConfig {
  return {
    enabled: envFlagOffByDefault("ENABLE_NETWORK_ACL"),
    allowlistRaw: process.env.NETWORK_ACL_ALLOWLIST ?? "",
  };
}

/**
 * When ACL is disabled → allow.
 * When enabled → client IP must match NETWORK_ACL_ALLOWLIST (CIDR or IP list).
 * Empty allowlist while enabled → deny all.
 */
export function isClientIpAllowed(clientIp: string): boolean {
  const { enabled, allowlistRaw } = getNetworkAclConfig();
  if (!enabled) return true;
  const rules = parseAllowlist(allowlistRaw);
  if (rules.length === 0) return false;
  return ipMatchesAllowlist(clientIp, rules);
}
