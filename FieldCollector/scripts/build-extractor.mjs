import {mkdir, readFile, writeFile, cp} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const orderedSources = [
  "serialize.ts",
  "modules.ts",
  "history.ts",
  "datasets.ts",
  "media.ts",
  "controller.ts"
];

const chunks = [];
for (const source of orderedSources) {
  chunks.push(await readFile(path.join(root, "extractor", "src", source), "utf8"));
}

const output = [
  "(() => {\n\"use strict\";\n",
  "const FC = globalThis.FieldCollectorExtractor = {};\n",
  ...chunks,
  "\nreturn FC.createController();\n})()\n"
].join("\n");

const extractorDist = path.join(root, "extractor", "dist");
const extensionDist = path.join(root, "extension", "dist");
await mkdir(extractorDist, {recursive: true});
await mkdir(path.join(extensionDist, "adapter"), {recursive: true});
await writeFile(path.join(extractorDist, "collector.iife.js"), output, "utf8");
await writeFile(path.join(extensionDist, "adapter", "collector.iife.js"), output, "utf8");
await cp(path.join(root, "extension", "src"), extensionDist, {recursive: true, force: true});
console.log(`Built ${path.relative(root, path.join(extractorDist, "collector.iife.js"))}`);

