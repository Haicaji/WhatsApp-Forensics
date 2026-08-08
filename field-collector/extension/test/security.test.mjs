import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {test} from "node:test";

const root = new URL("../", import.meta.url);
const collectorRoot = new URL("../../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("src/manifest.json", root), "utf8"));
const worker = await readFile(new URL("src/service-worker.js", root), "utf8");
const adapterSource = await readFile(new URL("injector/src/collector.ts", collectorRoot));
const adapterBuilt = await readFile(new URL("injector/dist/collector.iife.js", collectorRoot));

test("manifest exposes only current-tab debugger permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "debugger"]);
  assert.equal("host_permissions" in manifest, false);
  assert.equal("content_scripts" in manifest, false);
  assert.equal(manifest.background.service_worker, "service-worker.js");
});

test("extension network and CDP surfaces remain fixed and read-only", () => {
  assert.match(worker, /ws:\/\/127\.0\.0\.1:17653\/wafc-extension/);
  for (const forbidden of [
    "Network.enable",
    "Storage.getCookies",
    "DOM.set",
    "Input.dispatch",
    "Page.navigate",
    "chrome.cookies",
    "chrome.storage",
    "XMLHttpRequest",
    "sendMessageToChat",
    "createGroup",
  ]) {
    assert.equal(worker.includes(`"${forbidden}"`), false, `forbidden surface: ${forbidden}`);
  }
  assert.equal((worker.match(/new WebSocket\(/g) || []).length, 1);
  assert.equal((worker.match(/chrome\.debugger\.attach\(/g) || []).length, 1);
});

test("versioned adapter source and IIFE are byte-identical", () => {
  assert.deepEqual(adapterSource, adapterBuilt);
  const digest = createHash("sha256").update(adapterBuilt).digest("hex");
  assert.equal(digest.length, 64);
});
