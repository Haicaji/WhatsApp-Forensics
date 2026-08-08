import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function assertValidUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("Lone high surrogate is forbidden by I-JSON");
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("Lone low surrogate is forbidden by I-JSON");
    }
  }
}

// RFC 8785 JSON Canonicalization Scheme for values already parsed as I-JSON.
export function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite numbers are forbidden");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value);
    keys.forEach(assertValidUnicode);
    keys.sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new TypeError(`Unsupported JSON value: ${typeof value}`);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha512(value) {
  return createHash("sha512").update(value).digest("hex");
}

export function jsonBytes(value) {
  return Buffer.from(`${canonicalize(value)}\n`, "utf8");
}

export function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function writeJson(filePath, value) {
  ensureParent(filePath);
  fs.writeFileSync(filePath, jsonBytes(value));
}

export function writeNdjson(filePath, records) {
  ensureParent(filePath);
  const bytes = records.length
    ? Buffer.from(`${records.map(canonicalize).join("\n")}\n`, "utf8")
    : Buffer.alloc(0);
  fs.writeFileSync(filePath, bytes);
}

export function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

export function utf8Sort(values) {
  return [...values].sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
}

export function walkRegularFiles(rootDir) {
  const result = [];
  if (!fs.existsSync(rootDir)) return result;

  function visit(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Symlink/reparse path is forbidden: ${absolute}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) result.push(toPosix(path.relative(rootDir, absolute)));
      else throw new Error(`Unsupported filesystem entry: ${absolute}`);
    }
  }

  visit(rootDir);
  return utf8Sort(result);
}

export function isSafeRelativePath(relativePath) {
  if (!relativePath || relativePath.includes("\\") || path.posix.isAbsolute(relativePath)) return false;
  const parts = relativePath.split("/");
  return !parts.some((part) => part === "" || part === "." || part === "..");
}

export function buildManifest(rootDir, relativePaths, algorithm) {
  const hash = algorithm === "sha256" ? sha256 : algorithm === "sha512" ? sha512 : null;
  if (!hash) throw new Error(`Unsupported manifest algorithm: ${algorithm}`);
  return utf8Sort(relativePaths).map((relativePath) => {
    if (!isSafeRelativePath(relativePath)) throw new Error(`Unsafe manifest path: ${relativePath}`);
    const bytes = fs.readFileSync(path.join(rootDir, ...relativePath.split("/")));
    return `${hash(bytes)}  ${relativePath}`;
  }).join("\n") + "\n";
}

export function readJson(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`UTF-8 BOM is forbidden: ${filePath}`);
  }
  const text = bytes.toString("utf8");
  if (text.includes("\r")) throw new Error(`CR/CRLF is forbidden: ${filePath}`);
  return JSON.parse(text);
}

export function readNdjson(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length === 0) return [];
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`UTF-8 BOM is forbidden: ${filePath}`);
  }
  const text = bytes.toString("utf8");
  if (text.includes("\r")) throw new Error(`CR/CRLF is forbidden: ${filePath}`);
  if (!text.endsWith("\n")) throw new Error(`NDJSON must end with LF: ${filePath}`);
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) throw new Error(`Blank NDJSON line: ${filePath}`);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid NDJSON at ${filePath}:${index + 1}: ${error.message}`);
    }
  });
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
