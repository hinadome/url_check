import { envFlagOffByDefault } from "./env-flags";

type Bucket = {
  /** Timestamps (ms) of requests in the current window */
  hits: number[];
};

const buckets = new Map<string, Bucket>();

export type RateLimitConfig = {
  enabled: boolean;
  max: number;
  windowMs: number;
};

export function getRateLimitConfig(): RateLimitConfig {
  const maxRaw = Number(process.env.RATE_LIMIT_MAX ?? "10");
  const windowRaw = Number(process.env.RATE_LIMIT_WINDOW_MS ?? "60000");
  const max =
    Number.isFinite(maxRaw) && maxRaw >= 1
      ? Math.min(Math.floor(maxRaw), 10_000)
      : 10;
  const windowMs =
    Number.isFinite(windowRaw) && windowRaw >= 1000
      ? Math.min(Math.floor(windowRaw), 3_600_000)
      : 60_000;

  return {
    enabled: envFlagOffByDefault("ENABLE_RATE_LIMIT"),
    max,
    windowMs,
  };
}

export type RateLimitResult =
  | { allowed: true; remaining: number; limit: number; windowMs: number }
  | {
      allowed: false;
      remaining: 0;
      limit: number;
      windowMs: number;
      retryAfterSec: number;
    };

/**
 * Fixed sliding-window rate limit per key (usually client IP).
 * In-memory only — per Node process; resets on restart. Not shared across replicas.
 */
export function consumeRateLimit(key: string): RateLimitResult {
  const cfg = getRateLimitConfig();
  if (!cfg.enabled) {
    return {
      allowed: true,
      remaining: cfg.max,
      limit: cfg.max,
      windowMs: cfg.windowMs,
    };
  }

  const now = Date.now();
  const windowStart = now - cfg.windowMs;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }

  bucket.hits = bucket.hits.filter((t) => t > windowStart);

  if (bucket.hits.length >= cfg.max) {
    const oldest = bucket.hits[0] ?? now;
    const retryAfterSec = Math.max(
      1,
      Math.ceil((oldest + cfg.windowMs - now) / 1000),
    );
    return {
      allowed: false,
      remaining: 0,
      limit: cfg.max,
      windowMs: cfg.windowMs,
      retryAfterSec,
    };
  }

  bucket.hits.push(now);
  return {
    allowed: true,
    remaining: Math.max(0, cfg.max - bucket.hits.length),
    limit: cfg.max,
    windowMs: cfg.windowMs,
  };
}

/** Test helper / low-traffic cleanup */
export function resetRateLimitForTests(): void {
  buckets.clear();
}
