import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {test} from "node:test";

const root = new URL("../", import.meta.url);
const collectorRoot = new URL("../../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("src/manifest.json", root), "utf8"));
const workerModules = await Promise.all([
  "src/modules/protocol.js",
  "src/modules/adapter-loader.js",
  "src/modules/command-policy.js",
  "src/service-worker.js",
].map((file) => readFile(new URL(file, root), "utf8")));
const worker = workerModules.join("\n");
const adapterSource = await readFile(new URL("injector/src/collector.ts", collectorRoot));
const adapterBuilt = await readFile(new URL("injector/dist/collector.iife.js", collectorRoot));

test("manifest exposes only current-tab debugger permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.2.5");
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "debugger"]);
  assert.equal("host_permissions" in manifest, false);
  assert.equal("content_scripts" in manifest, false);
  assert.equal(manifest.background.service_worker, "service-worker.js");
});

test("extension source is modular while the release keeps one worker entry", () => {
  assert.equal(workerModules.length, 4);
  assert.match(workerModules[0], /Stable extension\/Collector protocol surface/);
  assert.match(workerModules[1], /Adapter integrity and version gate/);
  assert.match(workerModules[2], /Fail-closed CDP command policy/);
  assert.match(workerModules[3], /async function beginPairing/);
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
  assert.match(worker, /wa-private-collections-v2/);
  assert.match(worker, /start_comprehensive/);
  assert.match(worker, /CONTROLLER_PROTOCOL = "wafc-bridge\/2"/);
  assert.match(worker, /CONTROLLER_VERSION = "0.2.5"/);
  assert.match(worker, /message\.kind === "heartbeat"/);
  assert.match(worker, /pairingConfirmed/);
});

test("popup continuously reflects the live worker connection state", async () => {
  const popup = await readFile(new URL("src/popup.js", root), "utf8");
  assert.match(popup, /setInterval\(\(\) => void refreshStatus\(\), 500\)/);
  assert.match(popup, /response\.phase === "completed"/);
  assert.match(popup, /response\.phase === "connecting"/);
});

test("versioned adapter source and IIFE are byte-identical", () => {
  assert.deepEqual(adapterSource, adapterBuilt);
  const digest = createHash("sha256").update(adapterBuilt).digest("hex");
  assert.equal(digest.length, 64);
});

test("nested start-command validation stays in the trusted extension realm", () => {
  const source = adapterSource.toString("utf8");
  assert.match(worker, /function validateResume\(/);
  assert.match(worker, /\.every\(\(value\) => Number\.isSafeInteger\(value\) && value > 0\)/);
  assert.match(worker, /validateResume\(request\.resume\)/);
  assert.equal(source.includes("function resumeContextValid("), false);
  assert.equal(source.includes("function mediaPolicyValid("), false);
  assert.match(
    source,
    /requestKeys === "command,controllerVersion,mediaPolicy,protocol,resume"/,
  );
});

test("adapter exposes enrichment readers but no WhatsApp mutation surface", () => {
  const source = adapterSource.toString("utf8");
  assert.match(source, /WAWebChatLoadMessages/);
  assert.match(source, /downloadMedia/);
  assert.match(source, /WAWebProfilePicThumbCollection/);
  assert.equal((source.match(/window\.fetch\(/g) || []).length, 1);
  assert.match(source, /host === "whatsapp\.net" \|\| host\.endsWith\("\.whatsapp\.net"\)/);
  assert.match(source, /credentials: "omit"/);
  assert.match(source, /redirect: "error"/);
  assert.match(source, /referrerPolicy: "no-referrer"/);
  assert.match(source, /WAWebLabelItemCollection/);
  assert.match(source, /pastParticipants/);
  assert.match(source, /groupCallParticipants/);
  assert.match(source, /chatstates/);
  for (const forbidden of [
    "sendMessage",
    "sendTextMsgToChat",
    "createGroup",
    "addParticipants",
    "removeParticipants",
    "sendSeen",
    "markRead",
    "subscribePresence",
    "getNewsletterSubscribers",
    "getVotes",
    "Page.navigate",
    "document.querySelector",
    ".click()",
    "XMLHttpRequest",
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden adapter surface: ${forbidden}`);
  }
});
