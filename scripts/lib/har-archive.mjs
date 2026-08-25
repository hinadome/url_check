/**
 * Shared HAR archive helpers for replay + convert scripts.
 * Playwright attach layout: har.har + <sha1>.<ext> sidecars in a zip.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Playwright isTextualMimeType (coreBundle). */
export function isTextualMimeType(mimeType) {
  return !!String(mimeType || "").match(
    /^(text\/.*?|application\/(json|(x-)?javascript|xml.*?|ecmascript|graphql|x-www-form-urlencoded)|image\/svg(\+xml)?|application\/.*?(\+json|\+xml))(;\s*charset=.*)?$/,
  );
}

/** Extension for attach sidecar names (Playwright uses mime.getExtension || "dat"). */
export function extensionForMimeType(mimeType) {
  const subtype =
    String(mimeType || "")
      .split(";")[0]
      .split("/")[1]
      ?.trim()
      .toLowerCase() ?? "";
  if (!subtype) return "dat";
  const tail = subtype.includes("+") ? subtype.split("+").pop() : subtype;
  const map = {
    plain: "txt",
    javascript: "js",
    ecmascript: "js",
    jpeg: "jpg",
    "svg+xml": "svg",
    "xhtml+xml": "xhtml",
    json: "json",
    xml: "xml",
    html: "html",
    css: "css",
    png: "png",
    gif: "gif",
    webp: "webp",
    avif: "avif",
    bmp: "bmp",
    ico: "ico",
    woff: "woff",
    woff2: "woff2",
    ttf: "ttf",
    otf: "otf",
    "octet-stream": "dat",
  };
  if (map[tail]) return map[tail];
  if (map[subtype]) return map[subtype];
  if (/^[a-z0-9]{1,8}$/.test(tail)) return tail;
  return "dat";
}

export function sha1Hex(buf) {
  return createHash("sha1").update(buf).digest("hex");
}

/** Playwright attach filename: sha1 + "." + ext */
export function attachFilenameForBuffer(buf, mimeType) {
  return `${sha1Hex(buf)}.${extensionForMimeType(mimeType)}`;
}

export function safeArchiveBasename(name) {
  const base = basename(String(name || ""));
  if (!base || base === "." || base === ".." || base.includes("\0")) {
    throw new Error(`Unsafe archive member name: ${name}`);
  }
  if (base.includes("/") || base.includes("\\")) {
    throw new Error(`Unsafe archive member name: ${name}`);
  }
  return base;
}

export function findHarInDir(dir) {
  const candidate = join(dir, "har.har");
  if (existsSync(candidate)) return candidate;
  throw new Error(`No har.har in ${dir}`);
}

export function isZipFile(filePath) {
  const abs = resolve(filePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) return false;
  const head = readFileSync(abs).subarray(0, 2);
  return head[0] === 0x50 && head[1] === 0x4b;
}

export function unzipToTemp(zipPath, prefix = "url-checker-har-") {
  const abs = resolve(zipPath);
  if (!existsSync(abs)) throw new Error(`Zip not found: ${abs}`);
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("unzip", ["-q", "-o", abs, "-d", dir], { stdio: "inherit" });
  return dir;
}

/** Read har.har from a zip without extracting everything. */
export function readHarJsonFromZip(zipPath, maxBuffer = 64 * 1024 * 1024) {
  return execFileSync("unzip", ["-p", resolve(zipPath), "har.har"], {
    encoding: "utf8",
    maxBuffer,
  });
}

export function readBlobFromZip(zipPath, memberName, maxBuffer = 64 * 1024 * 1024) {
  const name = safeArchiveBasename(memberName);
  try {
    return execFileSync("unzip", ["-p", resolve(zipPath), name], {
      maxBuffer,
    });
  } catch {
    return null;
  }
}

export function readBlobFromDir(dir, memberName) {
  const name = safeArchiveBasename(memberName);
  const path = join(dir, name);
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return readFileSync(path);
}

/**
 * Decode embed content/postData to raw bytes.
 * @returns {Buffer | null}
 */
export function decodeEmbedBodyBytes(field) {
  if (!field || field.text == null) return null;
  const text = String(field.text);
  if (field.encoding === "base64") {
    return Buffer.from(text.replace(/\s+/g, ""), "base64");
  }
  return Buffer.from(text, "utf8");
}

/**
 * Apply Playwright embed encoding onto a content/postData object (mutates).
 * @param {object} field
 * @param {Buffer} buffer
 * @param {{ resourceType?: string | null }} [opts]
 */
export function applyEmbedContent(field, buffer, opts = {}) {
  const mimeType = field.mimeType ?? "";
  const resourceType = opts.resourceType ?? null;
  if (!buffer || buffer.length === 0) {
    field.size = 0;
    delete field.text;
    delete field.encoding;
    delete field._file;
    delete field._sha1;
    return { kind: "empty" };
  }
  field.size = buffer.length;
  delete field._file;
  delete field._sha1;
  if (isTextualMimeType(mimeType) && resourceType !== "font") {
    field.text = buffer.toString("utf8");
    delete field.encoding;
    return { kind: "utf8" };
  }
  field.text = buffer.toString("base64");
  field.encoding = "base64";
  return { kind: "base64" };
}

/**
 * Convert embed field → attach (_file + sidecar map). Mutates field.
 * @param {object} field
 * @param {Map<string, Buffer>} blobs
 * @returns {{ kind: string, filename?: string }}
 */
export function applyAttachContent(field, blobs) {
  if (!field) return { kind: "skip" };
  if (field._file || field._sha1) {
    return { kind: "already-attach", filename: field._file || field._sha1 };
  }
  if (field.text == null) return { kind: "empty" };

  const buffer = decodeEmbedBodyBytes(field);
  if (!buffer) return { kind: "empty" };

  const filename = attachFilenameForBuffer(buffer, field.mimeType);
  if (!blobs.has(filename)) blobs.set(filename, buffer);

  field._file = filename;
  field.size = buffer.length;
  delete field.text;
  delete field.encoding;
  delete field._sha1;
  return { kind: "attached", filename };
}

/**
 * Pack a directory (har.har + sidecars) into a .har.zip via `zip` CLI.
 */
export function writeHarZipFromDir(dir, outZipPath) {
  const absOut = resolve(outZipPath);
  const absDir = resolve(dir);
  if (!existsSync(join(absDir, "har.har"))) {
    throw new Error(`Missing har.har in ${absDir}`);
  }
  if (existsSync(absOut)) rmSync(absOut, { force: true });
  execFileSync("zip", ["-q", "-r", absOut, "."], {
    cwd: absDir,
    stdio: "inherit",
  });
  return absOut;
}

export function listSidecarFiles(dir) {
  return readdirSync(dir).filter(
    (name) => name !== "har.har" && !name.startsWith("."),
  );
}

export function cleanupDir(dir) {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

export function writeTempDir(prefix = "url-checker-har-conv-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeFileUtf8(path, text) {
  writeFileSync(path, text, "utf8");
}

export function writeFileBinary(path, buf) {
  writeFileSync(path, buf);
}

export function parseHarJson(raw, label = "HAR") {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${label} is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (!data?.log || !Array.isArray(data.log.entries)) {
    throw new Error(`${label} is missing log.entries`);
  }
  return data;
}
