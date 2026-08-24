#!/usr/bin/env node
/**
 * Replay HAR archives with Playwright routeFromHAR.
 *
 * Supports:
 * - URL Checker .har.zip / .har / harZipBase64 / check JSON
 * - Chrome/Edge DevTools “Save all as HAR with content” (.har, creator WebInspector)
 * - Firefox DevTools HAR exports
 *
 * Examples:
 *   node scripts/replay-har.mjs --har ~/Downloads/site.har
 *   node scripts/replay-har.mjs --devtools ~/Downloads/site.har
 *   node scripts/replay-har.mjs --file ~/Downloads/site.har
 *   node scripts/replay-har.mjs ~/Downloads/site.har
 *   node scripts/replay-har.mjs --zip ~/Downloads/url-checker-….har.zip
 *   node scripts/replay-har.mjs --base64-file ./harZipBase64.txt
 *
 * Chrome tip: Network → right-click → “Save all as HAR with content”
 * (without content, replay has headers only and the page will look empty).
 *
 * Optional:
 *   --url <url>     Page to open (defaults to document URL from HAR)
 *   --offline       Abort requests not present in the HAR
 *   --headless      No visible browser window
 *   --screenshots [dir]   Progressive PNGs at commit → DOMContentLoaded → load → networkidle
 *   --scroll-screenshots  Also capture viewport frames while scrolling (needs --screenshots)
 */

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { stdin as stdinStream } from "node:process";
import { fileURLToPath } from "node:url";

function usage(exitCode = 1) {
  console.error(`Usage:
  # Auto-detect path (.har / .har.zip / check JSON / base64 text)
  node scripts/replay-har.mjs <path>
  node scripts/replay-har.mjs --file <path>

  # Chrome / Edge / Firefox DevTools HAR (same as --har)
  node scripts/replay-har.mjs --devtools <path.har>
  node scripts/replay-har.mjs --har <path.har>

  # URL Checker zip (attach) / unzipped attach dir
  node scripts/replay-har.mjs --zip <path.har.zip>
  node scripts/replay-har.mjs --dir <extractedDir>
  node scripts/replay-har.mjs --unzip <path.har.zip>

  # API harZipBase64 / check-result JSON
  node scripts/replay-har.mjs --base64-file <file>
  node scripts/replay-har.mjs --json <check-result.json>
  node scripts/replay-har.mjs --base64-stdin

Options:
  --url <url>   Page URL (default: document URL from HAR / pages[])
  --offline     notFound: abort (block live network for missing URLs)
  --headless    Headless browser
  --screenshots [dir]  Progressive screenshots (default dir: ./har-screenshots)
  --scroll-screenshots Scroll the page and capture each viewport step
  -h, --help    Show help`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    zip: null,
    dir: null,
    unzip: null,
    har: null,
    file: null,
    base64File: null,
    json: null,
    base64Stdin: false,
    url: null,
    offline: false,
    headless: false,
    screenshots: null, // null | string (dir)
    scrollScreenshots: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") usage(0);
    else if (a === "--zip") opts.zip = argv[++i];
    else if (a === "--dir") opts.dir = argv[++i];
    else if (a === "--unzip") opts.unzip = argv[++i];
    else if (a === "--har" || a === "--devtools") opts.har = argv[++i];
    else if (a === "--file") opts.file = argv[++i];
    else if (a === "--base64-file") opts.base64File = argv[++i];
    else if (a === "--json") opts.json = argv[++i];
    else if (a === "--base64-stdin") opts.base64Stdin = true;
    else if (a === "--url") opts.url = argv[++i];
    else if (a === "--offline") opts.offline = true;
    else if (a === "--headless") opts.headless = true;
    else if (a === "--scroll-screenshots") opts.scrollScreenshots = true;
    else if (a === "--screenshots") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        opts.screenshots = argv[++i];
      } else {
        opts.screenshots = join(process.cwd(), "har-screenshots");
      }
    } else if (!a.startsWith("-") && !opts.file) opts.file = a;
    else {
      console.error(`Unknown arg: ${a}`);
      usage(1);
    }
  }

  if (opts.scrollScreenshots && !opts.screenshots) {
    opts.screenshots = join(process.cwd(), "har-screenshots");
  }

  const modes = [
    opts.zip,
    opts.dir,
    opts.unzip,
    opts.har,
    opts.file,
    opts.base64File,
    opts.json,
    opts.base64Stdin,
  ].filter(Boolean);
  if (modes.length !== 1) {
    console.error(
      "Pick exactly one input: path | --file | --har | --devtools | --zip | --dir | --unzip | --base64-file | --json | --base64-stdin",
    );
    usage(1);
  }
  return opts;
}

function findHarInDir(dir) {
  const candidate = join(dir, "har.har");
  if (existsSync(candidate)) return candidate;
  throw new Error(`No har.har in ${dir}`);
}

function looksLikeUrl(s) {
  return typeof s === "string" && /^https?:\/\//i.test(s);
}

/**
 * Describe HAR origin + body coverage (DevTools often omit bodies).
 */
export function inspectHar(data) {
  const log = data?.log ?? {};
  const creatorName = String(log.creator?.name ?? "");
  const entries = Array.isArray(log.entries) ? log.entries : [];
  const pages = Array.isArray(log.pages) ? log.pages : [];

  let source = "har";
  const lower = creatorName.toLowerCase();
  if (lower.includes("webinspector") || lower.includes("chrome")) {
    source = "devtools-chrome";
  } else if (lower.includes("firefox")) {
    source = "devtools-firefox";
  } else if (lower.includes("playwright")) {
    source = "playwright";
  } else if (creatorName) {
    source = `har:${creatorName}`;
  }

  let withBody = 0;
  for (const entry of entries) {
    const content = entry?.response?.content ?? {};
    if (content.text != null || content._file) withBody += 1;
  }

  return {
    source,
    creatorName: creatorName || null,
    entryCount: entries.length,
    pageCount: pages.length,
    withBody,
    bodyCoverage:
      entries.length === 0 ? 0 : Math.round((withBody / entries.length) * 100),
  };
}

export function describeHarSource(info) {
  switch (info.source) {
    case "devtools-chrome":
      return "Chrome/Edge DevTools HAR (WebInspector)";
    case "devtools-firefox":
      return "Firefox DevTools HAR";
    case "playwright":
      return `Playwright HAR (${info.creatorName ?? "Playwright"})`;
    default:
      return info.creatorName
        ? `HAR (creator: ${info.creatorName})`
        : "HAR JSON";
  }
}

/**
 * Pick navigation URL for replay.
 * Prefer a request that exists in the HAR (DevTools pages[].title is often a URL
 * that was never captured as a document entry).
 */
export function firstDocumentUrlFromHarData(data) {
  const log = data?.log ?? {};
  const entries = Array.isArray(log.entries) ? log.entries : [];
  const pages = Array.isArray(log.pages) ? log.pages : [];
  const urlsInHar = new Set(
    entries.map((e) => e?.request?.url).filter((u) => looksLikeUrl(u)),
  );

  for (const entry of entries) {
    if (entry?._resourceType === "document" && looksLikeUrl(entry?.request?.url)) {
      return entry.request.url;
    }
  }

  for (const entry of entries) {
    const mime = entry?.response?.content?.mimeType ?? "";
    const url = entry?.request?.url;
    if (url && mime.includes("html")) return url;
  }

  // Chrome puts the page URL in pages[].title — only use if that URL was recorded.
  for (const page of pages) {
    if (looksLikeUrl(page?.title) && urlsInHar.has(page.title)) {
      return page.title;
    }
  }

  // Last resort: first http(s) entry (may be XHR-only DevTools export).
  for (const entry of entries) {
    if (looksLikeUrl(entry?.request?.url)) return entry.request.url;
  }
  return null;
}

function firstDocumentUrlFromHarJson(raw) {
  return firstDocumentUrlFromHarData(JSON.parse(raw));
}

function firstDocumentUrlFromFile(harPath) {
  return firstDocumentUrlFromHarJson(readFileSync(harPath, "utf8"));
}

/** Read har.har from a zip without extracting everything. */
function firstDocumentUrlFromZip(zipPath) {
  try {
    const raw = execFileSync("unzip", ["-p", resolve(zipPath), "har.har"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return firstDocumentUrlFromHarJson(raw);
  } catch {
    return null;
  }
}

function unzipToTemp(zipPath) {
  const abs = resolve(zipPath);
  if (!existsSync(abs)) throw new Error(`Zip not found: ${abs}`);
  const dir = mkdtempSync(join(tmpdir(), "url-checker-har-"));
  execFileSync("unzip", ["-q", "-o", abs, "-d", dir], { stdio: "inherit" });
  return dir;
}

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    stdinStream.setEncoding("utf8");
    stdinStream.on("data", (c) => chunks.push(c));
    stdinStream.on("end", () => resolvePromise(chunks.join("")));
    stdinStream.on("error", reject);
  });
}

function writeTempHar(harJsonText) {
  const cleanupDir = mkdtempSync(join(tmpdir(), "url-checker-har-json-"));
  const harPath = join(cleanupDir, "session.har");
  writeFileSync(harPath, harJsonText, "utf8");
  return { harPath, cleanupDir };
}

function writeTempZipFromBase64(b64) {
  const cleanupDir = mkdtempSync(join(tmpdir(), "url-checker-har-b64-"));
  const zipPath = join(cleanupDir, "session.har.zip");
  writeFileSync(zipPath, Buffer.from(b64.replace(/\s+/g, ""), "base64"));
  const buf = readFileSync(zipPath);
  if (buf.length < 4 || buf.subarray(0, 2).toString("utf8") !== "PK") {
    rmSync(cleanupDir, { recursive: true, force: true });
    throw new Error(
      "Decoded bytes are not a zip (expected Playwright session.har.zip / harZipBase64)",
    );
  }
  return { harPath: zipPath, cleanupDir };
}

function validateHarFile(harPath, { requireDocument = true } = {}) {
  const raw = readFileSync(harPath, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Not valid HAR JSON: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (!data?.log || !Array.isArray(data.log.entries)) {
    throw new Error("File is JSON but not a HAR (missing log.entries)");
  }

  const info = inspectHar(data);
  if (info.entryCount === 0) {
    throw new Error(
      "HAR has 0 entries. In DevTools Network panel, reload the page, then " +
        "right-click → “Save all as HAR with content”.",
    );
  }

  console.log(`  source: ${describeHarSource(info)}`);
  console.log(
    `  entries: ${info.entryCount} (bodies: ${info.withBody}, ${info.bodyCoverage}%)`,
  );

  const hasDocument = (data.log.entries ?? []).some(
    (e) =>
      e?._resourceType === "document" ||
      String(e?.response?.content?.mimeType ?? "").includes("html"),
  );
  info.hasDocument = hasDocument;

  if (!hasDocument) {
    const msg =
      "No document/HTML entry in this HAR (common with partial DevTools exports). " +
      "Pass --url to a URL that appears in the HAR, or re-export after a full page load: " +
      "Network → “Save all as HAR with content”.";
    if (requireDocument) throw new Error(msg);
    console.warn(`  warning: ${msg}`);
  }

  if (info.bodyCoverage < 20) {
    console.warn(
      "  warning: few response bodies in this HAR. Chrome: use “Save all as HAR with content” " +
        "(not a headers-only export), or replay will look empty/broken.",
    );
  }

  return info;
}

/**
 * Resolve text input to a HAR path Playwright can load.
 * @returns {{ harPath: string, cleanupDir: string | null, kind: string }}
 */
export function resolveSessionInput(input, { sourcePath = null } = {}) {
  const text = String(input).trim();
  if (!text) throw new Error("Empty session input");

  if (text.startsWith("{")) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : err}`);
    }

    if (data.log && Array.isArray(data.log.entries)) {
      const info = inspectHar(data);
      const kind =
        info.source.startsWith("devtools") ? info.source : "har";
      if (sourcePath && existsSync(sourcePath)) {
        return { harPath: resolve(sourcePath), cleanupDir: null, kind };
      }
      const written = writeTempHar(text);
      return { ...written, kind };
    }

    if (typeof data.harZipBase64 === "string" && data.harZipBase64) {
      return { ...writeTempZipFromBase64(data.harZipBase64), kind: "harZipBase64" };
    }

    if (typeof data.har === "string" && data.har) {
      const harText = data.har;
      if (harText.trim().startsWith("{")) {
        const written = writeTempHar(harText);
        return { ...written, kind: "har" };
      }
      throw new Error("result.har is present but is not HAR JSON");
    }

    if (data.harError) {
      throw new Error(`Check result has harError: ${data.harError}`);
    }

    throw new Error(
      "JSON is not a HAR and has no harZipBase64/har. " +
        "For DevTools/URL Checker .har use: --har <file.har> (or pass the path directly).",
    );
  }

  if (text.startsWith("data:")) {
    const comma = text.indexOf(",");
    if (comma === -1) throw new Error("Invalid data URL");
    return {
      ...writeTempZipFromBase64(text.slice(comma + 1)),
      kind: "harZipBase64",
    };
  }

  return { ...writeTempZipFromBase64(text), kind: "harZipBase64" };
}

export function extractHarZipBase64(input) {
  const text = String(input).trim();
  if (!text) throw new Error("Empty base64 / JSON input");

  if (text.startsWith("{")) {
    const data = JSON.parse(text);
    if (data.log && Array.isArray(data.log?.entries)) {
      throw new Error(
        "This file is a HAR JSON (DevTools or embed), not base64 zip. Use: --har <file.har>",
      );
    }
    if (typeof data.harZipBase64 === "string" && data.harZipBase64) {
      return data.harZipBase64;
    }
    throw new Error(
      "JSON has no harZipBase64 (capture with harFormat zip, or file too large / harError)",
    );
  }

  if (text.startsWith("data:")) {
    const comma = text.indexOf(",");
    if (comma === -1) throw new Error("Invalid data URL");
    return text.slice(comma + 1).replace(/\s+/g, "");
  }

  return text.replace(/\s+/g, "");
}

export function writeHarZipFromBase64(base64) {
  const resolved = resolveSessionInput(base64);
  if (!resolved.harPath.endsWith(".zip")) {
    if (resolved.cleanupDir) rmSync(resolved.cleanupDir, { recursive: true, force: true });
    throw new Error(
      "Input is HAR JSON, not zip base64. Use --har or resolveSessionInput instead.",
    );
  }
  return { zipPath: resolved.harPath, cleanupDir: resolved.cleanupDir };
}

export async function replayFromBase64(base64OrJson, options = {}) {
  const resolved = resolveSessionInput(base64OrJson);
  try {
    return await replayFromHarPath(resolved.harPath, {
      url: options.url ?? null,
      offline: Boolean(options.offline),
      headless: Boolean(options.headless),
      screenshots: options.screenshots ?? null,
      scrollScreenshots: Boolean(options.scrollScreenshots),
      keepOpen: options.keepOpen !== false && !options.headless && !options.screenshots,
    });
  } finally {
    if (resolved.cleanupDir) {
      rmSync(resolved.cleanupDir, { recursive: true, force: true });
    }
  }
}

/**
 * Open a path and choose zip / har / json / base64 automatically.
 */
export function openInputPath(filePath) {
  const abs = resolve(filePath);
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);

  const ext = extname(abs).toLowerCase();
  const name = basename(abs).toLowerCase();

  if (ext === ".zip" || name.endsWith(".har.zip")) {
    return { mode: "zip", harPath: abs, cleanupDir: null };
  }

  const head = readFileSync(abs).subarray(0, 4);
  if (head[0] === 0x50 && head[1] === 0x4b) {
    // PK zip magic (even if extension wrong)
    return { mode: "zip", harPath: abs, cleanupDir: null };
  }

  const text = readFileSync(abs, "utf8");
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const resolved = resolveSessionInput(trimmed, { sourcePath: abs });
    return {
      mode: resolved.kind,
      harPath: resolved.harPath,
      cleanupDir: resolved.cleanupDir,
    };
  }

  // bare base64
  const resolved = resolveSessionInput(trimmed);
  return {
    mode: resolved.kind,
    harPath: resolved.harPath,
    cleanupDir: resolved.cleanupDir,
  };
}

function padIndex(n, width = 2) {
  return String(n).padStart(width, "0");
}

/**
 * Write one PNG and return its path.
 * @param {import('playwright').Page} page
 */
async function writeScreenshot(page, outDir, label, opts = {}) {
  const filePath = join(outDir, `${label}.png`);
  await page.screenshot({
    path: filePath,
    fullPage: Boolean(opts.fullPage),
    animations: "disabled",
  });
  console.log(`  screenshot: ${filePath}`);
  return filePath;
}

/**
 * Capture screenshots while scrolling the page (viewport steps).
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>}
 */
export async function captureScrollScreenshots(page, outDir, options = {}) {
  const overlap = options.overlap ?? 0.15;
  const maxFrames = options.maxFrames ?? 30;
  let index = options.startIndex ?? 1;
  const paths = [];

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);

  const metrics = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: window.innerHeight,
  }));

  const step = Math.max(
    1,
    Math.floor(metrics.clientHeight * (1 - overlap)),
  );
  let y = 0;
  let frame = 0;
  while (frame < maxFrames) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(100);
    const label = `${padIndex(index)}-scroll-${padIndex(frame + 1)}`;
    index += 1;
    frame += 1;
    paths.push(await writeScreenshot(page, outDir, label));
    if (y + metrics.clientHeight >= metrics.scrollHeight - 1) break;
    y = Math.min(y + step, metrics.scrollHeight - metrics.clientHeight);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  return { paths, nextIndex: index };
}

/**
 * Generate progressive screenshots during / after navigation.
 *
 * Stages (default): commit → domcontentloaded → load → networkidle → fullpage
 * Optional scroll viewport frames when `scroll: true`.
 *
 * Call either:
 * - with `url` set: navigates progressively and snaps at each milestone
 * - without `url`: page already loaded — snaps current + networkidle wait + fullpage (+ scroll)
 *
 * @param {import('playwright').Page} page
 * @param {{
 *   outDir: string,
 *   url?: string | null,
 *   timeout?: number,
 *   scroll?: boolean,
 *   stages?: Array<'commit'|'domcontentloaded'|'load'|'networkidle'|'fullpage'>,
 * }} options
 * @returns {Promise<{ outDir: string, paths: string[] }>}
 */
export async function generateProgressiveScreenshots(page, options) {
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });

  const timeout = options.timeout ?? 60_000;
  const stages = options.stages ?? [
    "commit",
    "domcontentloaded",
    "load",
    "networkidle",
    "fullpage",
  ];
  const paths = [];
  let index = 1;

  const snap = async (name, shotOpts = {}) => {
    const label = `${padIndex(index)}-${name}`;
    index += 1;
    paths.push(await writeScreenshot(page, outDir, label, shotOpts));
  };

  if (options.url) {
    if (stages.includes("commit")) {
      await page.goto(options.url, { waitUntil: "commit", timeout });
      await snap("commit");
    } else {
      await page.goto(options.url, { waitUntil: "domcontentloaded", timeout });
    }

    if (stages.includes("domcontentloaded")) {
      await page.waitForLoadState("domcontentloaded", { timeout });
      await snap("domcontentloaded");
    }
    if (stages.includes("load")) {
      await page.waitForLoadState("load", { timeout });
      await snap("load");
    }
    if (stages.includes("networkidle")) {
      try {
        await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 15_000) });
        await snap("networkidle");
      } catch {
        console.warn("  networkidle not reached; skipping that frame");
      }
    }
  } else {
    // Already on a page — capture current state through remaining milestones.
    await snap("current");
    if (stages.includes("load")) {
      try {
        await page.waitForLoadState("load", { timeout: 5_000 });
      } catch {
        /* ignore */
      }
      await snap("load");
    }
    if (stages.includes("networkidle")) {
      try {
        await page.waitForLoadState("networkidle", { timeout: 10_000 });
        await snap("networkidle");
      } catch {
        console.warn("  networkidle not reached; skipping that frame");
      }
    }
  }

  if (options.scroll) {
    const scrolled = await captureScrollScreenshots(page, outDir, {
      startIndex: index,
    });
    paths.push(...scrolled.paths);
    index = scrolled.nextIndex;
  }

  if (stages.includes("fullpage")) {
    await snap("fullpage", { fullPage: true });
  }

  return { outDir, paths };
}

/**
 * Core replay: routeFromHAR + goto.
 */
export async function replayFromHarPath(harPath, options = {}) {
  const offline = Boolean(options.offline);
  const headless = Boolean(options.headless);
  const screenshotsDir = options.screenshots
    ? resolve(options.screenshots)
    : null;
  const scrollScreenshots = Boolean(options.scrollScreenshots);
  // Close after screenshots unless caller forces keepOpen
  const keepOpen =
    options.keepOpen != null
      ? Boolean(options.keepOpen)
      : !headless && !screenshotsDir;

  if (!harPath.endsWith(".zip")) {
    validateHarFile(harPath, { requireDocument: !options.url });
  }

  let gotoUrl = options.url ?? null;
  if (!gotoUrl) {
    gotoUrl = harPath.endsWith(".zip")
      ? firstDocumentUrlFromZip(harPath)
      : firstDocumentUrlFromFile(harPath);
  }
  if (!gotoUrl) {
    throw new Error("Could not detect page URL from HAR; pass --url / url explicitly");
  }

  console.log(`Opening: ${gotoUrl}`);
  if (offline) console.log("Offline mode: missing HAR URLs will abort");

  const browser = await chromium.launch({ headless: headless || Boolean(screenshotsDir) });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  await page.routeFromHAR(harPath, {
    update: false,
    ...(offline ? { notFound: "abort" } : {}),
  });

  let screenshotResult = null;
  if (screenshotsDir) {
    console.log(`Progressive screenshots → ${screenshotsDir}`);
    screenshotResult = await generateProgressiveScreenshots(page, {
      outDir: screenshotsDir,
      url: gotoUrl,
      scroll: scrollScreenshots,
    });
    console.log(`Wrote ${screenshotResult.paths.length} screenshot(s)`);
  } else {
    await page.goto(gotoUrl, { waitUntil: "load", timeout: 60_000 });
    console.log("Loaded. Close the browser window when done inspecting.");
  }

  if (keepOpen) {
    await new Promise((resolvePromise) => {
      browser.on("disconnected", resolvePromise);
    });
  } else {
    if (!screenshotsDir) await page.waitForTimeout(2000);
    await browser.close();
  }

  return { url: gotoUrl, screenshots: screenshotResult };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let harPath;
  let cleanupDir = null;
  const replayOpts = {
    url: opts.url,
    offline: opts.offline,
    headless: opts.headless,
    screenshots: opts.screenshots,
    scrollScreenshots: opts.scrollScreenshots,
    keepOpen: opts.screenshots ? false : !opts.headless,
  };

  if (opts.file) {
    const opened = openInputPath(opts.file);
    harPath = opened.harPath;
    cleanupDir = opened.cleanupDir;
    console.log(`Auto: ${opened.mode}\n  ${resolve(opts.file)} → ${harPath}`);
  } else if (opts.har) {
    harPath = resolve(opts.har);
    if (!existsSync(harPath)) throw new Error(`HAR not found: ${harPath}`);
    console.log(`DevTools / HAR JSON replay\n  ${harPath}`);
  } else if (opts.base64File || opts.json || opts.base64Stdin) {
    let input;
    let sourcePath = null;
    if (opts.base64Stdin) {
      input = await readStdin();
      console.log("Base64 / JSON on stdin (auto-detect)");
    } else if (opts.json) {
      sourcePath = resolve(opts.json);
      if (!existsSync(sourcePath)) throw new Error(`JSON not found: ${sourcePath}`);
      input = readFileSync(sourcePath, "utf8");
      console.log(`Check JSON\n  ${sourcePath}`);
    } else {
      sourcePath = resolve(opts.base64File);
      if (!existsSync(sourcePath)) throw new Error(`File not found: ${sourcePath}`);
      input = readFileSync(sourcePath, "utf8");
      console.log(`Base64 / mixed file (auto-detect)\n  ${sourcePath}`);
    }

    const resolved = resolveSessionInput(input, { sourcePath });
    harPath = resolved.harPath;
    cleanupDir = resolved.cleanupDir;
    console.log(`  detected: ${resolved.kind} → ${harPath}`);
  } else if (opts.zip) {
    harPath = resolve(opts.zip);
    if (!existsSync(harPath)) throw new Error(`Zip not found: ${harPath}`);
    console.log(`Zip replay\n  ${harPath}`);
  } else if (opts.dir) {
    const dir = resolve(opts.dir);
    harPath = findHarInDir(dir);
    console.log(`Extracted dir replay\n  ${harPath}`);
  } else {
    cleanupDir = unzipToTemp(opts.unzip);
    harPath = findHarInDir(cleanupDir);
    console.log(`Unzipped to ${cleanupDir}\n  ${harPath}`);
  }

  try {
    await replayFromHarPath(harPath, replayOpts);
  } finally {
    if (cleanupDir) {
      rmSync(cleanupDir, { recursive: true, force: true });
    }
  }
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
