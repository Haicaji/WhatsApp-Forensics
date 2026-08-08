import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { IPC_CHANNELS } from "../shared/api";

test("the renderer bridge exposes only unique, namespaced IPC channels", () => {
  const channels = Object.values(IPC_CHANNELS);
  assert.equal(new Set(channels).size, channels.length);
  assert.ok(channels.every((channel) => channel.startsWith("wafc:")));
});

test("sandbox preload is self-contained and the main bundle keeps node:sqlite external", () => {
  const preload = readFileSync(
    resolve(__dirname, "../preload/index.cjs"),
    "utf8",
  );
  assert.match(preload, /contextBridge\.exposeInMainWorld\("wafc"/u);
  assert.doesNotMatch(preload, /require\("\.\.\//u);

  const main = readFileSync(resolve(__dirname, "index.cjs"), "utf8");
  assert.match(main, /require\("node:sqlite"\)/u);
  assert.doesNotMatch(main, /__vite-browser-external/u);

  const renderer = readFileSync(
    resolve(__dirname, "../../renderer/index.html"),
    "utf8",
  );
  assert.match(renderer, /Content-Security-Policy/u);
  assert.doesNotMatch(renderer, /unsafe-inline|unsafe-eval/u);
});
