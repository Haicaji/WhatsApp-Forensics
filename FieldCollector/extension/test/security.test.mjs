import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../src/manifest.json", import.meta.url), "utf8"));
const worker = await readFile(new URL("../src/service-worker.js", import.meta.url), "utf8");
const popup = await readFile(new URL("../src/popup.js", import.meta.url), "utf8");

test("extension uses only activeTab, debugger, and user-triggered clipboard read", () => {
  assert.deepEqual(manifest.permissions, ["activeTab", "debugger", "clipboardRead"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'self' ws:\/\/127\.0\.0\.1:17654/);
  assert.match(popup, /pasteButton\.addEventListener\("click"/);
  assert.match(popup, /navigator\.clipboard\.readText\(\)/);
});

test("relay is restricted to WhatsApp and fixed CDP methods", () => {
  assert.match(worker, /hostname === "web\.whatsapp\.com"/);
  assert.match(worker, /method === "Runtime\.evaluate"/);
  assert.doesNotMatch(worker, /Network\.enable|Storage\.|Input\.|Page\.navigate/);
  assert.match(worker, /params\.expression === adapterText/);
  assert.match(worker, /JSON\.stringify\(this\.next\(\)\)/);
  assert.match(worker, /function validPolicy/);
  assert.match(worker, /exactKeys\(command, \["command", "policy"\]\)/);
});
