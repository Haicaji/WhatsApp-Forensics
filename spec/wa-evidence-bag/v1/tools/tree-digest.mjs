#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultBag = resolve(
  here,
  "..",
  "examples",
  "minimal-valid-signed",
  "waeb-11111111-1111-4111-8111-111111111111",
);
const root = resolve(process.argv[2] ?? defaultBag);

if (!statSync(root).isDirectory()) {
  throw new Error(`Not a directory: ${root}`);
}

const files = [];

function walk(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) {
      walk(path);
    } else {
      files.push(path);
    }
  }
}

walk(root);

const treeHash = createHash("sha256");
for (const path of files) {
  const portablePath = relative(root, path).split(sep).join("/");
  const fileHash = createHash("sha256").update(readFileSync(path)).digest("hex");
  treeHash.update(portablePath, "utf8");
  treeHash.update("\0", "utf8");
  treeHash.update(fileHash, "ascii");
  treeHash.update("\n", "utf8");
}

console.log(treeHash.digest("hex"));
