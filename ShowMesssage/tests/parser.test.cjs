"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const JSZip = require("../frontend/vendor/jszip.min.js");
const Parser = require("../frontend/parser.js");

const projectRoot = path.resolve(__dirname, "..", "..");
const sampleDirectory = path.join(projectRoot, "tmp");

function sampleZipPath() {
  const sampleName = "ZAPiXWEB_8615880921237_3@c.us.zip";
  return path.join(sampleDirectory, sampleName);
}

async function parseBuffer(buffer, sourceName = "fixture.zip") {
  return Parser.parseArchive(buffer, JSZip, { sourceName });
}

async function makeArchive({
  chats,
  chatFiles,
  contacts = null,
  userAccount,
  manifest,
  attachments = [],
  additionalChatFiles = [],
}) {
  const zip = new JSZip();
  zip.file("chats.json", JSON.stringify(chats));
  zip.file("contacts.json", JSON.stringify(contacts));
  if (userAccount !== undefined) zip.file("userAccount.json", JSON.stringify(userAccount));
  if (manifest !== undefined) zip.file("extraction_manifest.json", JSON.stringify(manifest));
  for (const [id, messages] of Object.entries(chatFiles)) {
    zip.file(`Chat ${id}.json`, JSON.stringify(messages));
  }
  for (const file of additionalChatFiles) {
    zip.file(file.name, JSON.stringify(file.messages));
  }
  for (const attachment of attachments) {
    zip.file(attachment.name, attachment.content || "fixture");
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

function message(id, overrides = {}) {
  return {
    id: { fromMe: false, remote: "alpha@c.us", id },
    t: 1700000000,
    type: "chat",
    body: `message ${id}`,
    ...overrides,
  };
}

test("parses the optional local ZAPiXWEB sample with the expected totals", {
  skip: fs.existsSync(sampleZipPath()) ? false : "local tmp sample is not present",
}, async () => {
  const source = fs.readFileSync(sampleZipPath());
  const archive = await parseBuffer(source, path.basename(sampleZipPath()));

  assert.equal(archive.stats.chatCount, 1);
  assert.equal(archive.stats.messageCount, 115);
  assert.equal(archive.stats.attachmentCount, 5);
  assert.deepEqual(archive.stats.typeCounts, {
    chat: 108,
    image: 2,
    video: 1,
    ptt: 1,
    document: 1,
    poll_creation: 1,
    event_creation: 1,
  });
  assert.equal(archive.currentUser.id, "259567069958235@lid");
  assert.equal(archive.currentUser.type, "in");
  assert.equal(archive.currentUser.phoneNumber, "8615880921237");
  assert.equal(archive.currentUser.phoneId, "8615880921237_3@c.us");
  assert.equal(archive.currentUser.deviceId, "3");
  assert.equal(archive.currentUser.phoneSource, "sourceName");
  assert.equal(archive.chats[0].contactId, "45046355239082@lid");
  assert.equal(archive.chats[0].contactName, "HH");

  const documentMessage = archive.chats[0].messages.find((item) => item.type === "document");
  assert.ok(documentMessage.media.entryName);
  assert.equal(path.extname(documentMessage.media.entryName), "");
  assert.match(documentMessage.media.downloadName, /\.md$/i);
  assert.equal(documentMessage.media.mime, "text/markdown");
  assert.ok(
    archive.chats[0].messages
      .filter((item) => item.type === "image" || item.type === "video")
      .every((item) => item.body.length < 512),
    "base64 thumbnails must not be exposed as captions",
  );
});

test("accepts null contacts and falls back to formattedTitle", async () => {
  const buffer = await makeArchive({
    chats: [{ id: { _serialized: "alpha@c.us" }, formattedTitle: "本地会话" }],
    chatFiles: { "alpha@c.us": [message("one")] },
    contacts: null,
  });
  const archive = await parseBuffer(buffer);
  assert.equal(archive.chats[0].title, "本地会话");
  assert.equal(archive.currentUser, null);
  assert.equal(archive.extractionManifest, null);
  assert.equal(archive.integrity.status, "no-manifest");
  assert.equal(archive.integrity.complete, null);
  assert.equal(archive.integrity.unreportedChatCount, 0);
});

test("does not present WhatsApp sentinel IDs as phone numbers", async () => {
  const buffer = await makeArchive({
    chats: [{ id: "0@c.us", formattedTitle: "系统记录" }],
    chatFiles: { "0@c.us": [message("one")] },
    contacts: null,
  });
  const archive = await parseBuffer(buffer);
  assert.equal(archive.chats[0].phoneNumber, "");
  assert.equal(archive.chats[0].phoneId, "");
});

test("normalizes current-user metadata when userAccount.json is present", async () => {
  const buffer = await makeArchive({
    chats: [{ id: { _serialized: "alpha@c.us" }, formattedTitle: "本地会话" }],
    chatFiles: { "alpha@c.us": [message("one")] },
    contacts: null,
    userAccount: { id: "self@lid", type: "in", isDeactivated: false },
  });
  const archive = await parseBuffer(buffer);
  assert.deepEqual(archive.currentUser, {
    id: "self@lid",
    name: "当前用户",
    type: "in",
    status: "",
    isDeactivated: false,
    avatarEntryName: "",
    phoneId: "",
    phoneNumber: "",
    deviceId: "",
    phoneSource: "",
  });
});

test("prefers phone metadata embedded by the current extractor", async () => {
  const buffer = await makeArchive({
    chats: [{ id: { _serialized: "alpha@c.us" }, formattedTitle: "本地会话" }],
    chatFiles: { "alpha@c.us": [message("one")] },
    contacts: null,
    userAccount: {
      id: "self@lid",
      type: "in",
      phoneId: "8613899998888:4@c.us",
      phoneNumber: "8613899998888",
      deviceId: "4",
    },
  });
  const archive = await parseBuffer(buffer, "ZAPiXWEB_10000000000_2@c.us.zip");
  assert.equal(archive.currentUser.phoneNumber, "8613899998888");
  assert.equal(archive.currentUser.phoneId, "8613899998888:4@c.us");
  assert.equal(archive.currentUser.deviceId, "4");
  assert.equal(archive.currentUser.phoneSource, "userAccount");
});

test("uses phone metadata embedded in a chat contact", async () => {
  const buffer = await makeArchive({
    chats: [
      {
        id: "45046355239082@lid",
        formattedTitle: "HH",
        contact: {
          id: "45046355239082@lid",
          name: "HH",
          phoneId: "61415715702@c.us",
          phoneNumber: "61415715702",
        },
      },
    ],
    chatFiles: {
      "45046355239082@lid": [
        message("one", {
          id: { fromMe: false, remote: "45046355239082@lid", id: "one" },
        }),
      ],
    },
    contacts: null,
  });
  const archive = await parseBuffer(buffer);
  assert.equal(archive.chats[0].phoneNumber, "61415715702");
  assert.equal(archive.chats[0].phoneId, "61415715702@c.us");
  assert.equal(archive.chats[0].phoneSource, "chat");
});

test("pairs LID and phone contacts when their exported identity is unambiguous", async () => {
  const identity = {
    name: "Matched contact",
    shortName: "Matched contact",
    pushname: "Matched",
  };
  const buffer = await makeArchive({
    chats: [
      {
        id: "122831836823710@lid",
        formattedTitle: "Matched contact",
        contact: { id: "122831836823710@lid", ...identity },
      },
    ],
    chatFiles: {
      "122831836823710@lid": [
        message("one", {
          id: { fromMe: false, remote: "122831836823710@lid", id: "one" },
        }),
      ],
    },
    contacts: [
      { id: "122831836823710@lid", ...identity },
      { id: "61415715702@c.us", ...identity },
    ],
  });
  const archive = await parseBuffer(buffer);
  assert.equal(archive.chats[0].phoneNumber, "61415715702");
  assert.equal(archive.chats[0].phoneId, "61415715702@c.us");
  assert.equal(archive.chats[0].phoneSource, "contacts");
});

test("does not guess a phone when multiple LIDs share the same exported identity", async () => {
  const identity = {
    name: "Duplicate name",
    shortName: "Duplicate name",
    pushname: "Duplicate",
  };
  const buffer = await makeArchive({
    chats: [
      {
        id: "11111111111111@lid",
        formattedTitle: "Duplicate name",
        contact: { id: "11111111111111@lid", ...identity },
      },
    ],
    chatFiles: {
      "11111111111111@lid": [message("one")],
    },
    contacts: [
      { id: "11111111111111@lid", ...identity },
      { id: "22222222222222@lid", ...identity },
      { id: "61415715702@c.us", ...identity },
    ],
  });
  const archive = await parseBuffer(buffer);
  assert.equal(archive.chats[0].phoneNumber, "");
  assert.equal(archive.chats[0].phoneSource, "");
});

test("computes a full lowercase SHA-512 digest", async () => {
  const source = Buffer.from("abc", "utf8");
  const actual = await Parser.digestSha512(source, crypto.webcrypto);
  const expected = crypto.createHash("sha512").update(source).digest("hex");
  assert.equal(actual, expected);
  assert.match(actual, /^[a-f0-9]{128}$/);
});

test("uses an embedded attachment when the original is absent", async () => {
  const mediaMessage = message("image-one", {
    id: { fromMe: true, remote: "alpha@c.us", id: "image-one" },
    type: "image",
    mimetype: "image/jpeg",
  });
  const buffer = await makeArchive({
    chats: [{ id: { _serialized: "alpha@c.us" }, formattedTitle: "图片" }],
    chatFiles: { "alpha@c.us": [mediaMessage] },
    attachments: [
      { name: "Attachment true_alpha@c.us_image-one.embedded.jpg", content: "preview" },
    ],
  });
  const archive = await parseBuffer(buffer);
  const media = archive.chats[0].messages[0].media;
  assert.equal(media.missing, false);
  assert.equal(media.entryName, "Attachment true_alpha@c.us_image-one.embedded.jpg");
  assert.equal(media.previewEntryName, media.entryName);
});

test("marks absent media without failing the conversation", async () => {
  const buffer = await makeArchive({
    chats: [{ id: { _serialized: "alpha@c.us" }, formattedTitle: "缺失附件" }],
    chatFiles: {
      "alpha@c.us": [message("missing", { type: "video", mimetype: "video/mp4" })],
    },
  });
  const archive = await parseBuffer(buffer);
  assert.equal(archive.chats[0].messages[0].media.missing, true);
});

test("merges and sorts multiple chat JSON files", async () => {
  const buffer = await makeArchive({
    chats: [
      { id: { _serialized: "alpha@c.us" }, formattedTitle: "Alpha" },
      { id: { _serialized: "beta@g.us" }, formattedTitle: "Beta" },
    ],
    chatFiles: {
      "alpha@c.us": [message("old", { t: 1700000000 })],
      "beta@g.us": [
        message("new", {
          id: { fromMe: false, remote: "beta@g.us", id: "new" },
          t: 1800000000,
        }),
      ],
    },
  });
  const archive = await parseBuffer(buffer);
  assert.deepEqual(archive.chats.map((chat) => chat.title), ["Beta", "Alpha"]);
  assert.equal(archive.chats[0].isGroup, true);
});

test("normalizes the extraction manifest and associates integrity with each chat", async () => {
  const buffer = await makeArchive({
    chats: [
      { id: "alpha@c.us", formattedTitle: "Alpha" },
      { id: "beta@c.us", formattedTitle: "Beta" },
    ],
    chatFiles: {
      "alpha@c.us": [message("a")],
      "beta@c.us": [
        message("b", { id: "false_beta@c.us_b", t: 1800000000 }),
      ],
    },
    manifest: {
      chatCount: "2",
      totalMessages: "2",
      completeHistoryChats: 2,
      incompleteHistoryChats: 0,
      chatReports: {
        "alpha@c.us": { complete: "true", reason: "control-exhausted", messageCount: "1" },
        "beta@c.us": { complete: true, reason: "already-complete", messageCount: 1 },
      },
    },
  });
  const archive = await parseBuffer(buffer);
  assert.equal(archive.extractionManifest.totalMessages, 2);
  assert.equal(archive.extractionManifest.chatReports[0].chatId, "alpha@c.us");
  assert.deepEqual(
    {
      status: archive.integrity.status,
      complete: archive.integrity.complete,
      expected: archive.integrity.expectedMessageCount,
      actual: archive.integrity.parsedMessageCount,
      totalMatches: archive.integrity.totalMessagesMatch,
      chatsMatch: archive.integrity.chatCountMatch,
    },
    {
      status: "complete",
      complete: true,
      expected: 2,
      actual: 2,
      totalMatches: true,
      chatsMatch: true,
    },
  );
  const alpha = archive.chats.find((chat) => chat.id === "alpha@c.us");
  assert.equal(alpha.historyComplete, true);
  assert.equal(alpha.historyReason, "control-exhausted");
  assert.equal(alpha.reportedMessageCount, 1);
  assert.equal(alpha.messageCountMatches, true);
  assert.deepEqual(alpha.extraction, {
    reported: true,
    complete: true,
    reason: "control-exhausted",
    expectedMessageCount: 1,
    parsedMessageCount: 1,
    messageCountMatches: true,
    hasHistoryDiagnostics: false,
    historyAccessMethod: "",
    historyLoaderFallback: null,
    storeLoadRounds: null,
    storeReturnedMessages: null,
    storeAddedMessages: null,
    storeEmptyRounds: null,
    storeStalledRounds: null,
    openDiagnostics: [],
  });
});

test("preserves new Hook history diagnostics while dropping sensitive raw objects", async () => {
  const buffer = await makeArchive({
    chats: [{ id: "alpha@c.us", formattedTitle: "Alpha" }],
    chatFiles: { "alpha@c.us": [message("one")] },
    manifest: {
      extractorBuildId: "2026-07-18-unopened-history-v2",
      chatCount: 1,
      totalMessages: 1,
      chatReports: [{
        chatId: "alpha@c.us",
        chatTitle: "Alpha",
        complete: true,
        reason: "history-end-confirmed-by-store-loader",
        messageCount: 1,
        historyAccessMethod: "WAWebChatLoadMessages.loadEarlierMsgs",
        historyLoaderFallback: {
          moduleName: "WAWebChatLoadMessages.loadEarlierMsgs",
          round: "4",
          timedOut: "false",
          error: "store-loader-returned-repeated-batches-without-progress",
          privateToken: "fallback-secret",
          rawResult: { html: "fallback-private-object" },
        },
        storeLoadRounds: "5",
        storeReturnedMessages: "41",
        storeAddedMessages: 38,
        storeEmptyRounds: "2",
        storeStalledRounds: 0,
        openDiagnostics: [{
          phase: "visible-row-title-scan",
          surfaceMounted: "true",
          observedChatId: "private-observed-id@c.us",
          observedTitle: "Private observed title",
          activation: {
            activated: true,
            target: "interactive-row",
            matches: "3",
            rawNode: { outerHTML: "private-dom-object" },
          },
          rawDom: { textContent: "private-diagnostic-object" },
        }],
      }],
    },
  });
  const archive = await parseBuffer(buffer);
  const report = archive.extractionManifest.chatReports[0];

  assert.equal(archive.extractionManifest.extractorBuildId, "2026-07-18-unopened-history-v2");
  assert.equal(report.hasHistoryDiagnostics, true);
  assert.equal(report.historyAccessMethod, "WAWebChatLoadMessages.loadEarlierMsgs");
  assert.deepEqual(report.historyLoaderFallback, {
    moduleName: "WAWebChatLoadMessages.loadEarlierMsgs",
    round: 4,
    timedOut: false,
    error: "store-loader-returned-repeated-batches-without-progress",
  });
  assert.deepEqual(
    {
      rounds: report.storeLoadRounds,
      returned: report.storeReturnedMessages,
      added: report.storeAddedMessages,
      empty: report.storeEmptyRounds,
      stalled: report.storeStalledRounds,
    },
    { rounds: 5, returned: 41, added: 38, empty: 2, stalled: 0 },
  );
  assert.deepEqual(report.openDiagnostics, [{
    phase: "visible-row-title-scan",
    surfaceMounted: true,
    observedChatIdPresent: true,
    observedChatIdMatches: false,
    observedTitlePresent: true,
    observedTitleMatches: false,
    activation: {
      activated: true,
      target: "interactive-row",
      reason: "",
      matches: 3,
      available: null,
      chatIdValid: null,
      titlePresent: null,
    },
  }]);
  const serializedDiagnostics = JSON.stringify({
    fallback: report.historyLoaderFallback,
    open: report.openDiagnostics,
  });
  assert.doesNotMatch(serializedDiagnostics, /fallback-secret|private-observed|Private observed|private-dom|private-diagnostic/);

  const extraction = archive.chats[0].extraction;
  assert.equal(extraction.hasHistoryDiagnostics, true);
  assert.equal(extraction.historyAccessMethod, report.historyAccessMethod);
  assert.deepEqual(extraction.historyLoaderFallback, report.historyLoaderFallback);
  assert.deepEqual(extraction.openDiagnostics, report.openDiagnostics);
});

test("reports manifest totals, per-chat count mismatches and incomplete reasons", async () => {
  const buffer = await makeArchive({
    chats: [{ id: "alpha@c.us", formattedTitle: "Alpha" }],
    chatFiles: { "alpha@c.us": [message("one")] },
    manifest: {
      chatCount: 1,
      totalMessages: 9,
      chatReports: [
        {
          chatId: "alpha@c.us",
          complete: false,
          reason: "maximum-sync-rounds-reached",
          messageCount: 2,
        },
      ],
    },
  });
  const archive = await parseBuffer(buffer);
  assert.equal(archive.integrity.status, "mismatch");
  assert.equal(archive.integrity.complete, false);
  assert.equal(archive.integrity.incompleteChatCount, 1);
  assert.equal(archive.integrity.messageCountMismatchChatCount, 1);
  assert.equal(archive.integrity.totalMessagesMatch, false);
  assert.deepEqual(
    archive.integrity.issues.map((issue) => issue.code),
    [
      "CHAT_HISTORY_INCOMPLETE",
      "CHAT_MESSAGE_COUNT_MISMATCH",
      "TOTAL_MESSAGE_COUNT_MISMATCH",
    ],
  );
});

test("merges same-chat JSON fragments, stably de-duplicates, and recomputes stats", async () => {
  const anonymous = {
    t: 1700000002,
    type: "chat",
    body: "message without an exported id",
    from: "sender@c.us",
  };
  const buffer = await makeArchive({
    chats: [{ id: "alpha@c.us", formattedTitle: "Alpha" }],
    chatFiles: {
      "alpha@c.us": [
        message("a", { t: 1700000000 }),
        message("duplicate", { t: 1700000001 }),
        anonymous,
      ],
    },
    additionalChatFiles: [
      {
        name: "fragments/Chat alpha@c.us.json",
        messages: [
          message("duplicate", { t: 1700000001 }),
          message("media", { t: 1700000003, type: "image", mimetype: "image/jpeg" }),
          { ...anonymous },
        ],
      },
    ],
  });
  const archive = await parseBuffer(buffer);
  assert.deepEqual(
    archive.chats[0].messages.map((item) => item.body),
    ["message a", "message duplicate", "message without an exported id", "message media"],
  );
  assert.equal(new Set(archive.chats[0].messages.map((item) => item.key)).size, 4);
  assert.equal(archive.stats.messageCount, 4);
  assert.equal(archive.stats.attachmentCount, 1);
  assert.equal(archive.stats.availableAttachmentCount, 0);
  assert.equal(archive.stats.missingAttachmentCount, 1);
  assert.deepEqual(archive.stats.typeCounts, { chat: 3, image: 1 });
});

test("keeps a preview-only video separate from its missing original with correct MIME", async () => {
  const buffer = await makeArchive({
    chats: [{ id: "alpha@c.us", formattedTitle: "Video" }],
    chatFiles: {
      "alpha@c.us": [
        message("ignored", {
          id: "false_alpha@c.us_video-one",
          type: "video",
          mimetype: "video/mp4",
        }),
      ],
    },
    attachments: [
      {
        name: "Attachment false_alpha@c.us_video-one.embedded.jpg",
        content: "jpeg-preview",
      },
    ],
  });
  const parsedMessage = (await parseBuffer(buffer)).chats[0].messages[0];
  assert.equal(parsedMessage.id, "video-one");
  assert.equal(parsedMessage.key, "false_alpha@c.us_video-one");
  assert.deepEqual(
    {
      entryName: parsedMessage.media.entryName,
      previewEntryName: parsedMessage.media.previewEntryName,
      missing: parsedMessage.media.missing,
      originalMissing: parsedMessage.media.originalMissing,
      previewOnly: parsedMessage.media.previewOnly,
      previewAvailable: parsedMessage.media.previewAvailable,
      mime: parsedMessage.media.mime,
      originalMime: parsedMessage.media.originalMime,
      previewMime: parsedMessage.media.previewMime,
    },
    {
      entryName: "",
      previewEntryName: "Attachment false_alpha@c.us_video-one.embedded.jpg",
      missing: false,
      originalMissing: true,
      previewOnly: true,
      previewAvailable: true,
      mime: "video/mp4",
      originalMime: "video/mp4",
      previewMime: "image/jpeg",
    },
  );
});

test("preserves a validated inline raster thumbnail without confusing it with the original video", async () => {
  const jpegPreview = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    0x49, 0x46, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
  ]).toString("base64");
  const buffer = await makeArchive({
    chats: [{ id: "alpha@c.us", formattedTitle: "Inline preview" }],
    chatFiles: {
      "alpha@c.us": [
        message("ignored", {
          id: "false_alpha@c.us_video-inline",
          type: "video",
          mimetype: "video/mp4",
          size: 1,
          body: jpegPreview,
        }),
      ],
    },
    attachments: [
      {
        name: "Attachment false_alpha@c.us_video-inline.mp4",
        content: "video-original",
      },
    ],
  });
  const parsedMessage = (await parseBuffer(buffer)).chats[0].messages[0];

  assert.equal(parsedMessage.body, "");
  assert.equal(parsedMessage.media.entryName, "Attachment false_alpha@c.us_video-inline.mp4");
  assert.equal(parsedMessage.media.mime, "video/mp4");
  assert.equal(parsedMessage.media.originalMissing, false);
  assert.equal(parsedMessage.media.previewOnly, false);
  assert.equal(parsedMessage.media.previewAvailable, true);
  assert.equal(parsedMessage.media.previewMime, "image/jpeg");
  assert.match(parsedMessage.media.previewDataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(parsedMessage.media.previewSize, 16);
  assert.equal(parsedMessage.media.size, Buffer.byteLength("video-original"));
});

test("rejects non-raster base64 as an inline media preview", async () => {
  const fakePreview = Buffer.from("not an image ".repeat(80)).toString("base64");
  const buffer = await makeArchive({
    chats: [{ id: "alpha@c.us", formattedTitle: "Unsafe preview" }],
    chatFiles: {
      "alpha@c.us": [
        message("ignored", {
          id: "false_alpha@c.us_video-invalid-preview",
          type: "video",
          mimetype: "video/mp4",
          body: fakePreview,
        }),
      ],
    },
  });
  const parsedMessage = (await parseBuffer(buffer)).chats[0].messages[0];

  assert.equal(parsedMessage.body, "");
  assert.equal(parsedMessage.media.previewDataUrl, "");
  assert.equal(parsedMessage.media.previewAvailable, false);
  assert.equal(parsedMessage.media.missing, true);
});

test("matches attachments for bare string and object-serialized message IDs", async () => {
  const buffer = await makeArchive({
    chats: [{ id: "alpha@c.us", formattedTitle: "IDs" }],
    chatFiles: {
      "alpha@c.us": [
        message("ignored", { id: "plain-one", fromMe: true, type: "document" }),
        message("ignored", {
          id: { _serialized: "false_alpha@c.us_object_part-one" },
          type: "image",
        }),
      ],
    },
    attachments: [
      { name: "Attachment true_alpha@c.us_plain-one.pdf" },
      { name: "Attachment false_alpha@c.us_object_part-one.jpg" },
    ],
  });
  const messages = (await parseBuffer(buffer)).chats[0].messages;
  assert.equal(messages[0].media.entryName, "Attachment true_alpha@c.us_plain-one.pdf");
  assert.equal(messages[0].media.mime, "application/pdf");
  assert.equal(messages[1].id, "object_part-one");
  assert.equal(messages[1].media.entryName, "Attachment false_alpha@c.us_object_part-one.jpg");
  assert.equal(messages[1].media.mime, "image/jpeg");
});

test("recovers the account phone from timestamped export names", async () => {
  const buffer = await makeArchive({
    chats: [{ id: "alpha@c.us", formattedTitle: "Alpha" }],
    chatFiles: { "alpha@c.us": [message("one")] },
    userAccount: { id: "self@lid" },
  });
  const archive = await parseBuffer(
    buffer,
    "ZAPiXWEB_8613899998888_4@c.us_20260718_123456_UTC+0800.zip",
  );
  assert.equal(archive.currentUser.phoneId, "8613899998888_4@c.us");
  assert.equal(archive.currentUser.phoneNumber, "8613899998888");
  assert.equal(archive.currentUser.deviceId, "4");
  assert.equal(archive.currentUser.phoneSource, "sourceName");
});

test("normalizes second, millisecond, microsecond and nanosecond timestamps safely", async () => {
  const buffer = await makeArchive({
    chats: [{ id: "alpha@c.us", formattedTitle: "Timestamps" }],
    chatFiles: {
      "alpha@c.us": [
        message("seconds", { t: 1700000000 }),
        message("milliseconds", { t: 1700000000000 }),
        message("microseconds", { t: 1700000000000000 }),
        message("nanoseconds", { t: 1700000000000000000 }),
        message("fallback", { t: -1, timestamp: 1700000000000 }),
        message("invalid", { t: "999999999999999999999999999999" }),
      ],
    },
  });
  const messages = (await parseBuffer(buffer)).chats[0].messages;
  const byId = new Map(messages.map((item) => [item.id, item]));
  for (const id of ["seconds", "milliseconds", "microseconds", "nanoseconds", "fallback"]) {
    assert.equal(byId.get(id).timestamp, 1700000000, id);
  }
  assert.equal(byId.get("invalid").timestamp, 0);
});

test("sorts chats by their actual last displayed message rather than stale chat metadata", async () => {
  const buffer = await makeArchive({
    chats: [
      { id: "alpha@c.us", formattedTitle: "Alpha", t: 2000000000 },
      { id: "beta@c.us", formattedTitle: "Beta", t: 1600000000 },
    ],
    chatFiles: {
      "alpha@c.us": [message("old", { t: 1700000000 })],
      "beta@c.us": [
        message("new", {
          id: "false_beta@c.us_new",
          t: 1800000000,
        }),
      ],
    },
  });
  const archive = await parseBuffer(buffer);
  assert.deepEqual(archive.chats.map((chat) => chat.title), ["Beta", "Alpha"]);
  assert.deepEqual(archive.chats.map((chat) => chat.timestamp), [1800000000, 1700000000]);
});

test("uses raw sender metadata in groups and never labels non-media previews as attachments", async () => {
  const buffer = await makeArchive({
    chats: [
      { id: "group@g.us", formattedTitle: "Group", groupMetadata: { subject: "Group" } },
      { id: "call@c.us", formattedTitle: "Call" },
      { id: "revoked@c.us", formattedTitle: "Revoked" },
      { id: "system@c.us", formattedTitle: "System" },
    ],
    chatFiles: {
      "group@g.us": [
        message("group", {
          id: "false_group@g.us_group",
          sender: { id: "sender@c.us", name: "Alice" },
          from: "",
        }),
      ],
      "call@c.us": [
        message("call", { id: "false_call@c.us_call", type: "call_log", body: "" }),
      ],
      "revoked@c.us": [
        message("revoked", { id: "false_revoked@c.us_revoked", type: "revoked" }),
      ],
      "system@c.us": [
        message("system", { id: "false_system@c.us_system", type: "notification", body: "" }),
      ],
    },
  });
  const archive = await parseBuffer(buffer);
  const groupMessage = archive.chats.find((chat) => chat.id === "group@g.us").messages[0];
  assert.equal(groupMessage.from, "sender@c.us");
  assert.equal(groupMessage.senderName, "Alice");
  assert.equal(archive.chats.find((chat) => chat.id === "call@c.us").preview, "[通话记录]");
  assert.equal(archive.chats.find((chat) => chat.id === "revoked@c.us").preview, "此消息已被删除");
  assert.equal(archive.chats.find((chat) => chat.id === "system@c.us").preview, "[系统消息]");
  assert.ok(archive.chats.every((chat) => !chat.preview.includes("附件")));
});

test("reports a damaged ZIP and required JSON omissions", async () => {
  await assert.rejects(parseBuffer(Buffer.from("not a zip")), { code: "INVALID_ZIP" });

  const zip = new JSZip();
  zip.file("Chat alpha@c.us.json", "[]");
  const missingChats = await zip.generateAsync({ type: "nodebuffer" });
  await assert.rejects(parseBuffer(missingChats), { code: "MISSING_JSON" });

  const zipWithoutMessages = new JSZip();
  zipWithoutMessages.file("chats.json", "[]");
  const missingChatFiles = await zipWithoutMessages.generateAsync({ type: "nodebuffer" });
  await assert.rejects(parseBuffer(missingChatFiles), { code: "MISSING_CHATS" });
});
