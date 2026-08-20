import type { Page } from "playwright";
import type { ResourceSummaryData } from "./types";

type RawResources = {
  links: string[];
  images: string[];
  stylesheets: string[];
  scripts: string[];
  iframes: string[];
  other: string[];
};

function uniqueSorted(urls: string[]): string[] {
  return [...new Set(urls.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export async function extractResources(page: Page): Promise<ResourceSummaryData> {
  const raw = await page.evaluate((): RawResources => {
    const base = document.baseURI;

    const toAbsolute = (value: string | null | undefined): string | null => {
      if (!value) return null;
      const trimmed = value.trim();
      if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("javascript:")) {
        return null;
      }
      try {
        return new URL(trimmed, base).href;
      } catch {
        return null;
      }
    };

    const collect = (selector: string, attr: string): string[] => {
      const out: string[] = [];
      document.querySelectorAll(selector).forEach((el) => {
        const abs = toAbsolute(el.getAttribute(attr));
        if (abs) out.push(abs);
      });
      return out;
    };

    const links = collect("a[href]", "href");

    const images: string[] = [];
    document.querySelectorAll("img").forEach((img) => {
      const src = toAbsolute(img.getAttribute("src"));
      if (src) images.push(src);
      const srcset = img.getAttribute("srcset");
      if (srcset) {
        srcset.split(",").forEach((part) => {
          const urlPart = part.trim().split(/\s+/)[0];
          const abs = toAbsolute(urlPart);
          if (abs) images.push(abs);
        });
      }
    });

    const stylesheets = collect('link[rel~="stylesheet"][href]', "href");
    const scripts = collect("script[src]", "src");
    const iframes = collect("iframe[src]", "src");

    const other: string[] = [];
    document.querySelectorAll("link[href]:not([rel~='stylesheet'])").forEach((el) => {
      const abs = toAbsolute(el.getAttribute("href"));
      if (abs) other.push(abs);
    });
    document.querySelectorAll("video[src], audio[src], source[src], embed[src], object[data]").forEach((el) => {
      const attr = el.hasAttribute("data") ? "data" : "src";
      const abs = toAbsolute(el.getAttribute(attr));
      if (abs) other.push(abs);
    });

    return { links, images, stylesheets, scripts, iframes, other };
  });

  return {
    links: uniqueSorted(raw.links),
    images: uniqueSorted(raw.images),
    stylesheets: uniqueSorted(raw.stylesheets),
    scripts: uniqueSorted(raw.scripts),
    iframes: uniqueSorted(raw.iframes),
    other: uniqueSorted(raw.other),
  };
}
