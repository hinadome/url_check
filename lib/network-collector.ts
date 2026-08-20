import type { Page, Response } from "playwright";
import type { NetworkRequestEntry } from "./types";

const MAX_NETWORK_ENTRIES = 2_000;

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

async function resolveContentSize(
  response: Response,
  headers: Record<string, string>,
): Promise<number | null> {
  const contentLength = headers["content-length"];
  if (contentLength && /^\d+$/.test(contentLength)) {
    return Number(contentLength);
  }

  try {
    const body = await response.body();
    return body.byteLength;
  } catch {
    return null;
  }
}

export function attachNetworkCollector(page: Page): {
  entries: NetworkRequestEntry[];
  flush: () => Promise<void>;
} {
  const entries: NetworkRequestEntry[] = [];
  const pending: Promise<void>[] = [];

  page.on("response", (response) => {
    if (entries.length + pending.length >= MAX_NETWORK_ENTRIES) {
      return;
    }

    pending.push(
      (async () => {
        try {
          const observedAt = new Date().toISOString();
          const url = response.url();
          const headers = await response.allHeaders();
          const contentType = headers["content-type"] ?? "";
          const contentSize = await resolveContentSize(response, headers);

          entries.push({
            url,
            host: hostFromUrl(url),
            status: response.status(),
            contentType,
            contentSize,
            resourceType: response.request().resourceType(),
            date: observedAt,
          });
        } catch {
          // Ignore individual response collection failures.
        }
      })(),
    );
  });

  return {
    entries,
    flush: async () => {
      await Promise.all(pending);
      entries.sort((a, b) => {
        const byDate = a.date.localeCompare(b.date);
        return byDate !== 0 ? byDate : a.url.localeCompare(b.url);
      });
    },
  };
}
