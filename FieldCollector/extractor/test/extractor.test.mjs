import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../dist/collector.iife.js", import.meta.url), "utf8");
const mockStore = JSON.parse(
  await readFile(new URL("../../tests/fixtures/mock-store.json", import.meta.url), "utf8")
);

function load() {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    Blob,
    ArrayBuffer,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    ReadableStream,
    AbortController,
    URL,
    Event: class Event { constructor(type) { this.type = type; } },
    MouseEvent: class MouseEvent { constructor(type) { this.type = type; } },
    fetch: async () => { throw new Error("network disabled in tests"); },
    atob,
    btoa,
    crypto: globalThis.crypto,
    document: {
      getElementById() { return null; },
      querySelector() { return null; }
    }
  });
  context.globalThis = context;
  context.window = context;
  const controller = vm.runInContext(source, context, {timeout: 5_000});
  return {context, controller, FC: context.FieldCollectorExtractor};
}

test("capability report always covers every declared dataset", async () => {
  const {controller, FC} = load();
  const capabilities = await controller.dispatch({command: "probe"});
  assert.equal(Object.keys(capabilities.datasets).length, 22);
  assert.deepEqual(Object.keys(capabilities.datasets), Array.from(FC.DATASETS));
  assert.equal(capabilities.datasets.accounts.status, "unavailable");
  assert.equal(capabilities.features.media_decryption.status, "unavailable");
  assert.equal(capabilities.features.media_blob_cache.status, "unavailable");
});

test("raw snapshot preserves fields and marks cycles", () => {
  const {FC} = load();
  const raw = {id: "one", nested: {value: 2}};
  raw.self = raw;
  const snapshot = FC.rawSnapshot({toJSON: () => raw});
  assert.equal(snapshot.id, "one");
  assert.equal(snapshot.nested.value, 2);
  assert.equal(snapshot.self.__fieldCollectorType, "Reference");
});

test("current WhatsApp message keys use the $1 serialized id fallback", () => {
  const {FC} = load();
  assert.equal(
    FC.idString({id: "stanza", $1: "false_chat@lid_stanza"}),
    "false_chat@lid_stanza"
  );
});

test("media payload bodies stay in raw JSON without becoming message text", () => {
  const {FC} = load();
  const payload = "/9j/" + "A".repeat(512);
  const record = FC.messageRecord({
    id: {_serialized: "media-message"},
    type: "image",
    body: payload,
    mimetype: "image/jpeg"
  }, "chat@c.us");
  assert.equal(record.text, null);
  assert.equal(record.raw.body, payload);
});

test("dataset batches are bounded by record count and serialized size", () => {
  const {FC} = load();
  const records = Array.from({length: 101}, (_, id) => ({id, text: "x".repeat(32)}));
  const byCount = FC.datasetBatches(records, 1024 * 1024);
  assert.deepEqual(Array.from(byCount, batch => batch.length), [100, 1]);
  const bySize = FC.datasetBatches(records.slice(0, 3), 80);
  assert.ok(bySize.length > 1);
  assert.equal(bySize.flat().length, 3);
});

test("message collection deduplicates by stable message id", () => {
  const {FC} = load();
  const first = {id: {_serialized: "m1"}, t: 1};
  const duplicate = {id: {_serialized: "m1"}, t: 1, body: "newer view"};
  const chat = {id: {_serialized: "chat@c.us"}, msgs: {_models: [first, duplicate]}};
  const env = {chatCollection: {_models: [chat]}, msgGetters: {getId: item => item.id}};
  FC._activeEnv = env;
  const messages = new Map();
  assert.equal(FC.mergeChatMessages(chat, env, messages), 1);
  assert.equal(messages.size, 1);
  assert.equal(messages.get("m1").body, "newer view");
});

test("dynamic chat queue absorbs new chats and replaces native-id duplicates", () => {
  const {FC} = load();
  const first = {...mockStore.chats[0]};
  const refreshed = {...first, title: "Refreshed"};
  const second = {id: {_serialized: "second@c.us"}, title: "Same"};
  const env = {chatCollection: {_models: [first]}};
  const queue = [];
  const byId = new Map();
  assert.equal(FC.absorbChats(queue, byId, env), 1);
  env.chatCollection._models = [refreshed, second];
  assert.equal(FC.absorbChats(queue, byId, env), 1);
  assert.equal(queue.length, 2);
  assert.equal(queue[0], refreshed);
});

test("duplicate titles are never sufficient to select a conversation", async () => {
  const {context, FC} = load();
  let clicks = 0;
  const row = () => ({
    textContent: "Repeated title",
    getAttribute() { return ""; },
    querySelector() { return null; },
    scrollIntoView() {},
    dispatchEvent() {},
    click() { clicks += 1; }
  });
  const rows = [row(), row()];
  context.document.getElementById = id => id === "pane-side" ? {querySelectorAll: () => rows} : {};
  const chat = {id: {_serialized: "wanted@c.us"}, title: "Repeated title"};
  const env = {chatCollection: {activeChat: null}};
  const opened = await FC.openChat(chat, env);
  assert.equal(opened.opened, false);
  assert.equal(clicks, 0);
});

test("Store history requires two stable empty rounds", async () => {
  const {FC} = load();
  FC.sleep = async () => {};
  let calls = 0;
  const chat = {id: {_serialized: "chat@c.us"}, msgs: {_models: []}};
  const env = {
    chatCollection: {_models: [chat]},
    historyLoader: {async loadEarlierMsgs() { calls += 1; return []; }},
    msgGetters: {getId: item => item.id}
  };
  FC._activeEnv = env;
  const report = {};
  const complete = await FC.tryStoreHistory(chat, env, new Map(), report, () => false);
  assert.equal(complete, true);
  assert.equal(calls, 2);
  assert.equal(report.reason, "history_end_confirmed_by_store_loader");
});

test("UI history fallback terminates after two stable rounds", async () => {
  const {FC} = load();
  FC.sleep = async () => {};
  FC.openChat = async () => ({opened: true, method: "row_id"});
  FC.conversationPanel = () => ({scrollTop: 10, dispatchEvent() {}});
  FC.earlierControl = () => null;
  let merges = 0;
  FC.mergeChatMessages = (_chat, _env, messages) => {
    merges += 1;
    if (merges === 1) {
      messages.set("m1", {id: {_serialized: "m1"}, t: 1});
      return 1;
    }
    return 0;
  };
  const report = {};
  const messages = new Map();
  await FC.tryUiHistory({id: {_serialized: "chat@c.us"}}, {}, messages, report, () => false);
  assert.equal(report.complete, true);
  assert.equal(report.rounds, 3);
  assert.equal(report.reason, "history_end_stable_without_control");
});

test("media metadata distinguishes original files from previews", () => {
  const {FC} = load();
  const message = {id: {_serialized: "m1"}, type: "image", mimetype: "image/jpeg"};
  const env = {msgGetters: {
    getId: item => item.id,
    getType: item => item.type,
    getMimetype: item => item.mimetype
  }};
  FC._activeEnv = env;
  assert.equal(FC.mediaMeta(message, env, "chat", "original").isOriginal, true);
  assert.equal(FC.mediaMeta(message, env, "chat", "preview").isOriginal, false);
});

test("voice media uses the base MIME type for its file extension", () => {
  const {FC} = load();
  const message = {id: {_serialized: "voice1"}, type: "ptt", mimetype: "audio/ogg; codecs=opus"};
  const env = {msgGetters: {
    getId: item => item.id,
    getType: item => item.type,
    getMimetype: item => item.mimetype
  }};
  assert.match(FC.mediaMeta(message, env, "chat").originalFileName, /\.ogg$/);
});

test("downloadMedia waits for an asynchronously populated blob", async () => {
  const {FC} = load();
  const mediaData = {
    downloadMedia(options) {
      assert.equal(options.downloadEvenIfExpensive, true);
      assert.equal(options.isUserInitiated, true);
      setTimeout(() => {
        mediaData.mediaBlob = new Blob([new Uint8Array([1, 2, 3])], {type: "image/jpeg"});
      }, 5);
    }
  };
  const message = {type: "image", mediaData};
  const source = await FC.tryDownloadMedia(message, {msgGetters: {}}, {
    waitMs: 100,
    pollMs: 5,
    requestTimeoutMs: 100
  });
  assert.equal(source.byteLength, 3);
  assert.equal(source.source, "downloadMedia_populated_blob");
});

test("expired media URLs and their expiry time are detected", () => {
  const {FC} = load();
  const url = "https://mmg.whatsapp.net/file.enc?oe=00000001";
  assert.equal(FC.mediaUrlExpiry(url), 1000);
  assert.equal(FC.mediaUrlIsExpired(url, 2000), true);
  assert.equal(FC.mediaNeedsChatRefresh({clientUrl: url}, {}, 2000), true);
});

test("media refresh resolves the newest message model after reopening a chat", () => {
  const {FC} = load();
  const original = {id: {_serialized: "m1"}, clientUrl: "old"};
  const refreshed = {id: {_serialized: "m1"}, clientUrl: "fresh"};
  const staleChat = {id: {_serialized: "chat@c.us"}, msgs: {_models: [original]}};
  const liveChat = {id: {_serialized: "chat@c.us"}, msgs: {_models: [refreshed]}};
  const env = {
    chatCollection: {_models: [liveChat]},
    msgGetters: {getId: item => item.id}
  };
  FC._activeEnv = env;
  assert.equal(FC.refreshedMessageModel(original, staleChat, env), refreshed);
});

test("message body thumbnails are exported only as previews", async () => {
  const {FC} = load();
  const body = "/9j/" + "A".repeat(512);
  const source = await FC.previewMedia({type: "video", body});
  assert.equal(source.source, "message_body_preview_base64");
  assert.equal(source.mimeType, "image/jpeg");
});

test("original media failures preserve a diagnostic reason", async () => {
  const {FC} = load();
  await assert.rejects(
    FC.originalMedia({type: "image"}, {msgGetters: {}}),
    /media_hkdf_unavailable/
  );
});

test("vCard bodies are exported as original vcf bytes", async () => {
  const {FC} = load();
  const body = "BEGIN:VCARD\nFN:Alice\nEND:VCARD";
  const message = {id: {_serialized: "v1"}, type: "vcard", body};
  const env = {msgGetters: {
    getId: item => item.id,
    getType: item => item.type,
    getBody: item => item.body
  }};
  FC._activeEnv = env;
  const meta = FC.mediaMeta(message, env, "chat", "original");
  const source = await FC.originalMedia(message, env);
  const chunks = [];
  const result = await FC.streamMediaSource(source, chunk => chunks.push(chunk.slice()), () => false);
  assert.equal(meta.mimeType, "text/vcard");
  assert.match(meta.originalFileName, /\.vcf$/);
  assert.equal(result.complete, true);
  assert.equal(new TextDecoder().decode(chunks[0]), body);
});

test("unknown-size media streams are forwarded in bounded chunks", async () => {
  const {FC} = load();
  const payload = new Uint8Array(300 * 1024).fill(7);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    }
  });
  const source = FC.mediaSourceFrom(stream, "test_readable_stream");
  const chunkSizes = [];
  const result = await FC.streamMediaSource(
    source,
    chunk => chunkSizes.push(chunk.byteLength),
    () => false
  );
  assert.equal(source.byteLength, null);
  assert.equal(result.byteLength, payload.byteLength);
  assert.ok(chunkSizes.every(size => size <= 128 * 1024));
  assert.equal(chunkSizes.length, 3);
});

test("observable blobs are streamed without making an eager byte-array copy", async () => {
  const {FC} = load();
  const blob = new Blob([new Uint8Array(260 * 1024).fill(3)], {type: "video/mp4"});
  const message = {id: {_serialized: "video1"}, type: "video", mediaData: {mediaBlob: blob}};
  const env = {msgGetters: {getType: item => item.type}};
  const source = await FC.originalMedia(message, env);
  let chunks = 0;
  const result = await FC.streamMediaSource(source, () => { chunks += 1; }, () => false);
  assert.equal(source.transferMode, "blob_stream");
  assert.equal(result.byteLength, blob.size);
  assert.ok(chunks >= 3);
});

test("stalled media streams fail after the no-progress timeout", async () => {
  const {FC} = load();
  const stream = new ReadableStream({start() {}});
  const source = FC.mediaSourceFrom(stream, "stalled_test_stream");
  await assert.rejects(
    FC.streamMediaSource(source, () => {}, () => false, {idleTimeoutMs: 10}),
    /media_idle_timeout/
  );
});

test("avatar tasks include only relevant ids that have a usable URL", () => {
  const {FC} = load();
  const env = {profilePictures: {_models: [
    {id: {_serialized: "used@c.us"}, imgFull: "https://cdn.test/used.jpg"},
    {id: {_serialized: "unused@c.us"}, imgFull: "https://cdn.test/unused.jpg"},
    {id: {_serialized: "no-avatar@c.us"}}
  ]}};
  const tasks = FC.avatarTasks(env, new Set(["used@c.us", "no-avatar@c.us"]));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].contactId, "used@c.us");
});

test("controller keeps a frame frozen until matching ACK", async () => {
  const {controller} = load();
  const started = await controller.dispatch({command: "start_full"});
  assert.equal(started.accepted, true);
  await new Promise(resolve => setTimeout(resolve, 0));
  const first = controller.next();
  const repeated = controller.next();
  assert.equal(first.kind, "capabilities");
  assert.deepEqual(repeated, first);
  assert.equal(controller.ack("999").accepted, false);
  assert.equal(controller.ack(first.sequence).accepted, true);
});
