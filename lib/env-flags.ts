/**
 * Opt-in access controls (default **off** when env unset).
 * Enable with: 1 | true | yes | on (case-insensitive).
 */

export function envFlagOffByDefault(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return false;
  }
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(v)) {
    return false;
  }
  // Unknown → treat as off (fail closed for enabling security features)
  return false;
}

/**
 * Opt-out security features (default **on** when env unset).
 * Disable with: 0 | false | no | off.
 */
export function envFlagOnByDefault(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return true;
  }
  const v = raw.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(v)) {
    return false;
  }
  if (["1", "true", "yes", "on"].includes(v)) {
    return true;
  }
  // Unknown → treat as on (fail closed for disabling security features)
  return true;
}

/** Trust X-Forwarded-For / X-Real-IP. Default **on** (typical nginx → 127.0.0.1 app). */
export function envTrustProxy(): boolean {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw.trim() === "") {
    return true;
  }
  const v = raw.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(v)) {
    return false;
  }
  return true;
}
