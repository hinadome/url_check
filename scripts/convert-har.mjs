#!/usr/bin/env node
/**
 * Convert Playwright / URL Checker HAR between attach zip and embed JSON.
 *
 *   node scripts/convert-har.mjs export.har.zip          # → .har (embed)
 *   node scripts/convert-har.mjs site.har                # → .har.zip (attach)
 *   node scripts/convert-har.mjs --to embed|--to zip …
 *
 * Guide: CONVERT_HAR.md
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyAttachContent,
  applyEmbedContent,
  cleanupDir,
  findHarInDir,
  isZipFile,
  parseHarJson,
  readBlobFromDir,
  readBlobFromZip,
  readHarJsonFromZip,
  unzipToTemp,
  writeFileBinary,
  writeFileUtf8,
  writeHarZipFromDir,
  writeTempDir,
} from "./lib/har-archive.mjs";

function usage(exitCode = 1) {
  console.error(`Usage:
  # Auto: .har.zip → .har  |  .har → .har.zip
  node scripts/convert-har.mjs <path>
  node scripts/convert-har.mjs --zip <path.har.zip>
  node scripts/convert-har.mjs --har <path.har>
  node scripts/convert-har.mjs --dir <extractedAttachDir> --to embed

  node scripts/convert-har.mjs --to embed|zip <path>
  node scripts/convert-har.mjs <path> --out <output>
  node scripts/convert-har.mjs <path> --pretty          # embed only (default: compact)
  node scripts/convert-har.mjs <path> --no-strict       # warn instead of fail (default: --strict)
  node scripts/convert-har.mjs <path> --dry-run

Requires: unzip + zip on PATH.
See CONVERT_HAR.md`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    file: null,
    zip: null,
    har: null,
    dir: null,
    to: null, // 'embed' | 'zip' | null
    out: null,
    pretty: false,
    strict: true,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") usage(0);
    else if (a === "--zip") opts.zip = argv[++i];
    else if (a === "--har") opts.har = argv[++i];
    else if (a === "--dir") opts.dir = argv[++i];
    else if (a === "--to") {
      const v = String(argv[++i] || "").toLowerCase();
      if (v !== "embed" && v !== "zip") {
        console.error(`--to must be embed or zip (got ${v})`);
        usage(1);
      }
      opts.to = v;
    } else if (a === "--out") opts.out = argv[++i];
    else if (a === "--pretty") opts.pretty = true;
    else if (a === "--compact") opts.pretty = false;
    else if (a === "--strict") opts.strict = true;
    else if (a === "--no-strict") opts.strict = false;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (!a.startsWith("-") && !opts.file) opts.file = a;
    else {
      console.error(`Unknown arg: ${a}`);
      usage(1);
    }
  }

  const inputs = [opts.file, opts.zip, opts.har, opts.dir].filter(Boolean);
  if (inputs.length !== 1) {
    console.error("Pick exactly one input: <path> | --zip | --har | --dir");
    usage(1);
  }
  return opts;
}

function defaultOutPath(inputPath, direction) {
  const abs = resolve(inputPath);
  const base = basename(abs);
  const dir = dirname(abs);
  if (direction === "embed") {
    if (base.toLowerCase().endsWith(".har.zip")) {
      return join(dir, base.slice(0, -8) + ".har");
    }
    if (base.toLowerCase().endsWith(".zip")) {
      return join(dir, base.slice(0, -4) + ".har");
    }
    return join(dir, base + ".har");
  }
  // → zip
  if (base.toLowerCase().endsWith(".har")) {
    return join(dir, base + ".zip");
  }
  return join(dir, base + ".har.zip");
}

function detectDirection(opts) {
  if (opts.to) return opts.to;
  if (opts.dir) return "embed";
  if (opts.zip) return "embed";
  if (opts.har) return "zip";

  const abs = resolve(opts.file);
  if (!existsSync(abs)) throw new Error(`Not found: ${abs}`);
  if (statSync(abs).isDirectory()) return "embed";
  const name = basename(abs).toLowerCase();
  if (name.endsWith(".har.zip") || name.endsWith(".zip") || isZipFile(abs)) {
    return "embed";
  }
  if (name.endsWith(".har") || name.endsWith(".json")) return "zip";

  const text = readFileSync(abs, "utf8").trim();
  if (text.startsWith("{")) return "zip";
  throw new Error("Cannot auto-detect direction; pass --to embed|zip");
}

function resolveAttachSource(opts) {
  const asDir = opts.dir
    ? resolve(opts.dir)
    : opts.file && existsSync(resolve(opts.file)) && statSync(resolve(opts.file)).isDirectory()
      ? resolve(opts.file)
      : null;

  if (asDir) {
    findHarInDir(asDir);
    return {
      kind: "dir",
      dir: asDir,
      cleanupDir: null,
      label: asDir,
      readBlob: (name) => readBlobFromDir(asDir, name),
      readHar: () => readFileSync(findHarInDir(asDir), "utf8"),
    };
  }

  const zipPath = resolve(opts.zip || opts.file);
  if (!existsSync(zipPath)) throw new Error(`Zip not found: ${zipPath}`);
  if (!isZipFile(zipPath)) {
    throw new Error(`Not a zip archive: ${zipPath}`);
  }
  return {
    kind: "zip",
    zipPath,
    cleanupDir: null,
    label: zipPath,
    readBlob: (name) => readBlobFromZip(zipPath, name),
    readHar: () => readHarJsonFromZip(zipPath),
  };
}

function fieldRefName(field) {
  return field?._file || field?._sha1 || null;
}

function convertFieldToEmbed(field, entry, which, source, stats, strict) {
  if (!field) return;
  const ref = fieldRefName(field);
  if (!ref) {
    if (field.text != null) stats.alreadyEmbed += 1;
    else stats.noBody += 1;
    return;
  }

  const buf = source.readBlob(ref);
  if (!buf) {
    const msg = `Missing sidecar "${ref}" for ${which} (${entry?.request?.url ?? "?"})`;
    if (strict) throw new Error(msg);
    console.warn(`  warning: ${msg}`);
    stats.missing += 1;
    delete field._file;
    delete field._sha1;
    return;
  }

  const resourceType =
    which === "response" ? entry?._resourceType ?? null : null;
  const result = applyEmbedContent(field, buf, { resourceType });
  if (result.kind === "utf8") stats.utf8 += 1;
  else if (result.kind === "base64") stats.base64 += 1;
  else stats.empty += 1;
  stats.inlined += 1;
}

/**
 * @returns {{ har: object, stats: object }}
 */
export function convertAttachToEmbed(source, { strict = true } = {}) {
  const har = parseHarJson(source.readHar(), source.label);
  const stats = {
    entries: har.log.entries.length,
    inlined: 0,
    utf8: 0,
    base64: 0,
    empty: 0,
    alreadyEmbed: 0,
    noBody: 0,
    missing: 0,
    postData: 0,
  };

  for (const entry of har.log.entries) {
    if (entry?.response?.content) {
      convertFieldToEmbed(
        entry.response.content,
        entry,
        "response",
        source,
        stats,
        strict,
      );
    }
    if (entry?.request?.postData) {
      const before = stats.inlined;
      convertFieldToEmbed(
        entry.request.postData,
        entry,
        "postData",
        source,
        stats,
        strict,
      );
      if (stats.inlined > before) stats.postData += 1;
    }
  }

  return { har, stats };
}

/**
 * @returns {{ har: object, blobs: Map<string, Buffer>, stats: object }}
 */
export function convertEmbedToAttach(har, { strict = true } = {}) {
  const blobs = new Map();
  const stats = {
    entries: har.log.entries.length,
    attached: 0,
    empty: 0,
    alreadyAttach: 0,
    postData: 0,
    errors: 0,
  };

  const handle = (field, which, entry) => {
    if (!field) return;
    if (field._file || field._sha1) {
      // Attach JSON without sidecars cannot be packed from embed path.
      const msg =
        `${which} still has _file/_sha1 (not embed). ` +
        `Use zip→embed on an attach archive, or an embed .har. ` +
        `(${entry?.request?.url ?? "?"})`;
      if (strict) throw new Error(msg);
      console.warn(`  warning: ${msg}`);
      stats.alreadyAttach += 1;
      stats.errors += 1;
      return;
    }
    try {
      const result = applyAttachContent(field, blobs);
      if (result.kind === "attached") {
        stats.attached += 1;
        if (which === "postData") stats.postData += 1;
      } else if (result.kind === "empty" || result.kind === "skip") {
        stats.empty += 1;
      }
    } catch (err) {
      const msg = `${which} convert failed (${entry?.request?.url ?? "?"}): ${err instanceof Error ? err.message : err}`;
      if (strict) throw new Error(msg);
      console.warn(`  warning: ${msg}`);
      stats.errors += 1;
    }
  };

  for (const entry of har.log.entries) {
    handle(entry?.response?.content, "response", entry);
    handle(entry?.request?.postData, "postData", entry);
  }

  return { har, blobs, stats };
}

function printAttachToEmbedStats(stats, outPath, dryRun) {
  console.error(
    `  entries: ${stats.entries}; inlined: ${stats.inlined} (utf8: ${stats.utf8}, base64: ${stats.base64}); ` +
      `already embed: ${stats.alreadyEmbed}; no body: ${stats.noBody}; missing: ${stats.missing}; postData: ${stats.postData}`,
  );
  if (dryRun) console.error("  dry-run: no file written");
  else if (outPath) console.error(`  wrote: ${outPath}`);
}

function printEmbedToAttachStats(stats, blobCount, outPath, dryRun) {
  console.error(
    `  entries: ${stats.entries}; attached: ${stats.attached}; sidecars: ${blobCount}; ` +
      `empty: ${stats.empty}; postData: ${stats.postData}; errors: ${stats.errors}`,
  );
  if (dryRun) console.error("  dry-run: no file written");
  else if (outPath) console.error(`  wrote: ${outPath}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const direction = detectDirection(opts);

  if (direction === "embed") {
    const source = resolveAttachSource(opts);
    console.error(`convert: attach → embed`);
    console.error(`  input: ${source.label}`);
    try {
      const { har, stats } = convertAttachToEmbed(source, {
        strict: opts.strict,
      });
      const out =
        opts.out ||
        defaultOutPath(
          opts.dir || opts.zip || opts.file,
          "embed",
        );
      const json = opts.pretty
        ? JSON.stringify(har, null, 2)
        : JSON.stringify(har);
      if (!opts.dryRun) {
        writeFileSync(resolve(out), json, "utf8");
      }
      printAttachToEmbedStats(stats, resolve(out), opts.dryRun);
      if (opts.strict && stats.missing > 0) process.exit(1);
    } finally {
      cleanupDir(source.cleanupDir);
    }
    return;
  }

  // embed → zip
  const harPath = resolve(opts.har || opts.file);
  if (!existsSync(harPath)) throw new Error(`HAR not found: ${harPath}`);
  if (statSync(harPath).isDirectory()) {
    throw new Error("Directory input requires --to embed (attach dir → .har)");
  }
  console.error(`convert: embed → attach zip`);
  console.error(`  input: ${harPath}`);

  const raw = readFileSync(harPath, "utf8");
  const har = parseHarJson(raw, harPath);
  const { har: outHar, blobs, stats } = convertEmbedToAttach(har, {
    strict: opts.strict,
  });

  const out = opts.out || defaultOutPath(harPath, "zip");

  if (opts.dryRun) {
    printEmbedToAttachStats(stats, blobs.size, resolve(out), true);
    return;
  }

  const tmp = writeTempDir();
  try {
    writeFileUtf8(join(tmp, "har.har"), JSON.stringify(outHar));
    for (const [name, buf] of blobs) {
      writeFileBinary(join(tmp, name), buf);
    }
    writeHarZipFromDir(tmp, out);
    printEmbedToAttachStats(stats, blobs.size, resolve(out), false);
  } finally {
    cleanupDir(tmp);
  }
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
