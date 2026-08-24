import type { FeatureFlags } from "./types";

/**
 * Server feature gates for optional check behaviors.
 * Defaults are **allow** (true) when the env var is unset or empty.
 * Disable with: 0, false, no, off (case-insensitive).
 *
 * Enforced in `POST /api/check`. Exposed (non-secret) via `GET /api/config`
 * so the UI can hide checkboxes. Restart the Node process after changing env.
 */

function envFlagAllowByDefault(name: string): boolean {
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
  // Unknown value → treat as allow (fail open to match default-allow policy)
  return true;
}

export function getFeatureFlags(): FeatureFlags {
  return {
    allowIgnoreCertErrors: envFlagAllowByDefault("ALLOW_IGNORE_CERT_ERRORS"),
    allowCaptureHar: envFlagAllowByDefault("ALLOW_CAPTURE_HAR"),
  };
}
