const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appPath = path.join(__dirname, "..", "frontend", "app.js");
const source = fs.readFileSync(appPath, "utf8");

function functionSource(name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  if (source.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function loadFunction(name, dependencies = []) {
  const declarations = [...dependencies, name].map(functionSource).join("\n");
  return vm.runInNewContext(`${declarations}\n${name};`);
}

function plainValue(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeMediaElement {
  constructor(tagName) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = "";
    this.isConnected = true;
    this.disabled = false;
    this.src = "";
    this.paused = this.tagName === "AUDIO";
    this.currentTime = 0;
    this.duration = 2;
    this.value = "";
  }

  append(...nodes) {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      node.parentElement = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  async dispatch(type) {
    const listeners = this.listeners.get(type) || [];
    await Promise.all(listeners.map((listener) => listener({ target: this })));
  }

  click() {
    if (this.disabled) return Promise.resolve();
    return this.dispatch("click");
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "src") this.src = "";
  }

  matches(selector) {
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches && child.matches(selector)) return child;
      const nested = child.querySelector && child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches && current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  pause() {
    const wasPlaying = !this.paused;
    this.paused = true;
    if (wasPlaying) void this.dispatch("pause");
  }

  play() {
    this.paused = false;
    void this.dispatch("play");
    return Promise.resolve();
  }

  load() {}
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("message search includes poll options and event descriptions", () => {
  const messageSearchText = loadFunction("messageSearchText");
  const pollText = messageSearchText({
    type: "poll_creation",
    poll: { name: "午餐", options: [{ name: "拉面" }, { name: "饺子" }] },
  });
  const eventText = messageSearchText({
    type: "event_creation",
    event: { name: "会议", description: "三楼会议室" },
  });
  assert.match(pollText, /午餐.*拉面.*饺子/);
  assert.match(eventText, /会议.*三楼会议室/);
});

test("URL cleanup keeps balanced closing parentheses and removes prose punctuation", () => {
  const splitUrlAndSuffix = loadFunction("splitUrlAndSuffix");
  let result = splitUrlAndSuffix("https://example.test/wiki/Function_(math). ".trim());
  assert.equal(result.clean, "https://example.test/wiki/Function_(math)");
  assert.equal(result.suffix, ".");

  result = splitUrlAndSuffix("https://example.test/path).");
  assert.equal(result.clean, "https://example.test/path");
  assert.equal(result.suffix, ").");

  result = splitUrlAndSuffix("https://example.test/a(b)");
  assert.equal(result.clean, "https://example.test/a(b)");
  assert.equal(result.suffix, "");
});

test("preview-only video state is explicit and does not require a fake video entry", () => {
  const isPreviewOnlyVideo = loadFunction("isPreviewOnlyVideo");
  assert.equal(isPreviewOnlyVideo({ previewOnly: true, entryName: "" }), true);
  assert.equal(isPreviewOnlyVideo({
    originalMissing: true,
    previewAvailable: true,
    previewEntryName: "Attachment 1.embedded.jpeg",
  }), true);
  assert.equal(isPreviewOnlyVideo({
    originalMissing: false,
    previewAvailable: true,
    previewEntryName: "preview.jpeg",
    entryName: "video.mp4",
  }), false);
});

test("media thumbnails prefer exported previews, then validated inline previews, with a local video-frame fallback", () => {
  const mediaPreviewSource = loadFunction("mediaPreviewSource");
  const shouldUseVideoFrameFallback = vm.runInNewContext(
    `${functionSource("isPreviewOnlyVideo")}\n${functionSource("shouldUseVideoFrameFallback")}\nshouldUseVideoFrameFallback;`,
    { MAX_VIDEO_FRAME_SOURCE_BYTES: 96 * 1024 * 1024 },
  );
  assert.deepEqual(
    plainValue(mediaPreviewSource({
      type: "video",
      media: {
        entryName: "video.mp4",
        previewEntryName: "video.embedded.jpg",
        previewMime: "image/jpeg",
        previewDataUrl: "data:image/jpeg;base64,inline",
      },
    })),
    { entryName: "video.embedded.jpg", mime: "image/jpeg", dataUrl: "" },
  );
  assert.deepEqual(
    plainValue(mediaPreviewSource({
      type: "video",
      media: {
        entryName: "video.mp4",
        previewEntryName: "",
        previewMime: "image/jpeg",
        previewDataUrl: "data:image/jpeg;base64,inline",
      },
    })),
    { entryName: "", mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,inline" },
  );
  assert.equal(
    mediaPreviewSource({ type: "video", media: { entryName: "video.mp4" } }),
    null,
  );
  assert.equal(
    shouldUseVideoFrameFallback({
      type: "video",
      media: { entryName: "video.mp4", missing: false, originalMissing: false, size: 1024 },
    }),
    true,
  );
  assert.equal(
    shouldUseVideoFrameFallback({
      type: "video",
      media: { entryName: "huge.mp4", missing: false, originalMissing: false, size: 97 * 1024 * 1024 },
    }),
    false,
  );
  assert.equal(
    shouldUseVideoFrameFallback({
      type: "video",
      media: {
        entryName: "",
        missing: false,
        originalMissing: true,
        previewAvailable: true,
        previewDataUrl: "data:image/jpeg;base64,preview",
      },
    }),
    false,
  );
  assert.deepEqual(
    plainValue(mediaPreviewSource({ type: "image", media: { entryName: "photo.jpg", mime: "image/jpeg" } })),
    { entryName: "photo.jpg", mime: "image/jpeg", dataUrl: "" },
  );
});

test("media dialog sequence preserves visual order, removes duplicates, and excludes unavailable videos", () => {
  const normalizeMediaDialogItems = loadFunction("normalizeMediaDialogItems", [
    "isPreviewOnlyVideo",
    "mediaDialogItemKey",
    "canOpenMediaItem",
  ]);
  const image = {
    chat: { id: "chat-a" },
    message: { id: "image-1", key: "image-1", type: "image", media: { entryName: "image.jpg" } },
  };
  const video = {
    chat: { id: "chat-a" },
    message: { id: "video-1", key: "video-1", type: "video", media: { entryName: "video.mp4" } },
  };
  const previewOnly = {
    chat: { id: "chat-a" },
    message: {
      id: "video-2",
      key: "video-2",
      type: "video",
      media: {
        entryName: "",
        originalMissing: true,
        previewAvailable: true,
        previewDataUrl: "data:image/jpeg;base64,preview",
      },
    },
  };

  assert.deepEqual(plainValue(normalizeMediaDialogItems([image, video, image, previewOnly])), [image, video]);
});

test("inline media resolves its actual parent chat before trusting a conflicting remote chat id", () => {
  const message = { id: "message-a", chatId: "chat-b" };
  const parentChat = { id: "chat-a", messages: [message] };
  const remoteChat = { id: "chat-b", messages: [{ id: "message-b" }] };
  const findMessageChat = vm.runInNewContext(
    `${functionSource("findMessageChat")}\nfindMessageChat;`,
    {
      state: { archive: { chats: [remoteChat, parentChat] } },
      getActiveChat: () => remoteChat,
    },
  );

  assert.equal(findMessageChat(message), parentChat);
  assert.match(functionSource("createImageCard"), /findMessageChat\(message\)/);
  assert.match(functionSource("createVideoCard"), /findMessageChat\(message\)/);
});

test("media navigation has non-wrapping boundary states", () => {
  const mediaNavigationState = loadFunction("mediaNavigationState");
  assert.deepEqual(plainValue(mediaNavigationState(0, 3)), {
    hasMultiple: true,
    canPrevious: false,
    canNext: true,
  });
  assert.deepEqual(plainValue(mediaNavigationState(1, 3)), {
    hasMultiple: true,
    canPrevious: true,
    canNext: true,
  });
  assert.deepEqual(plainValue(mediaNavigationState(2, 3)), {
    hasMultiple: true,
    canPrevious: true,
    canNext: false,
  });
  assert.deepEqual(plainValue(mediaNavigationState(0, 1)), {
    hasMultiple: false,
    canPrevious: false,
    canNext: false,
  });
});

test("all date presentation helpers return a full year-month-day label", () => {
  const declarations = ["formatDateLabel", "formatSearchResultDate", "formatChatTime"]
    .map(functionSource)
    .join("\n");
  const formatter = {
    format(date) {
      const iso = date.toISOString().slice(0, 10);
      return `完整日期:${iso}`;
    },
  };
  const helpers = vm.runInNewContext(
    `${declarations}\n({ formatDateLabel, formatSearchResultDate, formatChatTime });`,
    { dateFormatter: formatter },
  );
  for (const timestamp of [1700000000, 1735689600, 1767225600]) {
    assert.match(helpers.formatDateLabel(timestamp), /^完整日期:\d{4}-\d{2}-\d{2}$/);
    assert.equal(helpers.formatSearchResultDate(timestamp), helpers.formatDateLabel(timestamp));
    assert.equal(helpers.formatChatTime(timestamp), helpers.formatDateLabel(timestamp));
  }
  assert.doesNotMatch(source, /return ["'](?:今天|昨天)["']/);
});

test("media UI source includes side-panel scoping, dialog buttons, keyboard navigation, and guarded image lifecycle", () => {
  assert.match(source, /state\.detailMode === "media"/);
  assert.match(source, /查看所有聊天的影音内容、链接和文档/);
  assert.match(source, /mediaPreviousButton\.addEventListener\("click"/);
  assert.match(source, /mediaNextButton\.addEventListener\("click"/);
  assert.match(source, /\["ArrowLeft", "ArrowRight"\]/);
  assert.match(source, /requestToken !== state\.dialogRequestToken/);
  assert.match(source, /conversationView\.inert = overlay/);
  assert.match(source, /maintainMediaDialogFocus\(\)/);
  assert.match(functionSource("getVideoFramePreview"), /hasActiveVideoFrameConsumer\(key\)/);
  const installImageSource = functionSource("installMediaImage");
  assert.ok(installImageSource.indexOf('addEventListener("load"') < installImageSource.indexOf("image.src = url"));
  assert.ok(installImageSource.indexOf('addEventListener("error"') < installImageSource.indexOf("image.src = url"));
  const videoFallbackSource = functionSource("captureVideoFrame");
  assert.ok(videoFallbackSource.indexOf('addEventListener("loadeddata"') < videoFallbackSource.indexOf("video.src = url"));
  assert.ok(videoFallbackSource.indexOf('addEventListener("error"') < videoFallbackSource.indexOf("video.src = url"));
  assert.match(functionSource("generateVideoFramePreview"), /URL\.revokeObjectURL\(url\)/);
});

test("media blobs use bounded or view-scoped object URL lifetimes", () => {
  assert.match(functionSource("hydrateImage"), /createTransientObjectUrl/);
  assert.doesNotMatch(functionSource("hydrateImage"), /getObjectUrl/);
  assert.match(functionSource("installMediaImage"), /releaseSource/);
  assert.match(functionSource("createAudioPlayer"), /createTransientObjectUrl/);
  assert.doesNotMatch(functionSource("createAudioPlayer"), /observeWhenVisible/);
  assert.match(functionSource("createAudioPlayer"), /__showMessageReleaseAudio/);
  assert.match(functionSource("createAudioPlayer"), /playRequestToken = \+\+state\.audioPlayRequestToken/);
  assert.match(functionSource("createAudioPlayer"), /playRequestToken !== state\.audioPlayRequestToken/);
  assert.match(functionSource("createAudioPlayer"), /error\.name === "AbortError"/);
  assert.doesNotMatch(
    functionSource("createAudioPlayer"),
    /audio\.pause\(\);\s*if \(state\.activeAudio === audio\) state\.activeAudio = null/,
  );
  assert.match(functionSource("cleanupLazyMedia"), /releaseTransientMediaInRoot/);
  assert.match(functionSource("mediaDialogSource"), /createTransientObjectUrl/);
  assert.match(functionSource("renderMediaDialogItem"), /revokeDialogObjectUrl/);
  assert.match(functionSource("getObjectUrl"), /MAX_CACHED_OBJECT_URLS/);
  assert.match(functionSource("revokeObjectUrls"), /state\.transientUrls\.clear\(\)/);
});

test("audio playback honors the latest async intent and releases every superseded blob", async () => {
  const pending = new Map();
  const revoked = [];
  const state = { generation: 1, activeAudio: null, audioPlayRequestToken: 0 };
  const createTransientObjectUrl = (entryName) => {
    const request = deferred();
    if (!pending.has(entryName)) pending.set(entryName, []);
    pending.get(entryName).push(request);
    return request.promise;
  };
  const resolveNext = (entryName, url) => {
    const request = (pending.get(entryName) || []).shift();
    assert.ok(request, `missing pending request for ${entryName}`);
    request.resolve(url);
  };
  const context = {
    document: { createElement: (tagName) => new FakeMediaElement(tagName) },
    state,
    createTransientObjectUrl,
    revokeTransientObjectUrl: (url) => revoked.push(url),
    formatDuration: (seconds) => `duration:${seconds}`,
    icon: () => new FakeMediaElement("svg"),
    showToast: () => {},
    console: { error: () => {} },
  };
  const createAudioPlayer = vm.runInNewContext(
    `${functionSource("createAudioPlayer")}\ncreateAudioPlayer;`,
    context,
  );
  const playerA = createAudioPlayer({ media: { entryName: "a.ogg", mime: "audio/ogg", duration: 2 } });
  const playerB = createAudioPlayer({ media: { entryName: "b.ogg", mime: "audio/ogg", duration: 3 } });
  const buttonA = playerA.querySelector(".audio-play-button");
  const buttonB = playerB.querySelector(".audio-play-button");
  const audioA = playerA.querySelector("audio");
  const audioB = playerB.querySelector("audio");

  const slowA = buttonA.click();
  const fastB = buttonB.click();
  resolveNext("b.ogg", "blob:b-1");
  await fastB;
  assert.equal(state.activeAudio, audioB);
  assert.equal(audioB.paused, false);
  resolveNext("a.ogg", "blob:a-stale");
  await slowA;
  assert.equal(state.activeAudio, audioB, "the stale A request must not steal playback from B");
  assert.equal(audioA.src, "");
  assert.ok(revoked.includes("blob:a-stale"));

  await buttonB.click();
  assert.equal(audioB.paused, true);
  assert.equal(state.activeAudio, audioB, "a paused loaded item remains releasable when another starts");

  const resumeA = buttonA.click();
  resolveNext("a.ogg", "blob:a-2");
  await resumeA;
  assert.equal(state.activeAudio, audioA);
  assert.equal(audioA.paused, false);
  assert.equal(audioB.src, "", "starting A must release the paused B blob");
  assert.ok(revoked.includes("blob:b-1"));

  await audioA.dispatch("ended");
  assert.equal(state.activeAudio, null);
  assert.equal(audioA.src, "");
  assert.ok(revoked.includes("blob:a-2"));

  const replayA = buttonA.click();
  resolveNext("a.ogg", "blob:a-3");
  await replayA;
  assert.equal(state.activeAudio, audioA);
  assert.equal(audioA.src, "blob:a-3");

  await buttonA.click();
  const closingB = buttonB.click();
  playerB.isConnected = false;
  playerB.__showMessageReleaseAudio();
  resolveNext("b.ogg", "blob:b-disconnected");
  await closingB;
  assert.ok(revoked.includes("blob:b-disconnected"));
  assert.notEqual(state.activeAudio, audioB);
});

test("integrity view consumes the parser archive and chat contracts", () => {
  const archiveIntegrityView = loadFunction("archiveIntegrityView", ["formatHistoryReason", "formatIntegrityIssue"]);
  const chatIntegrityView = loadFunction("chatIntegrityView", ["formatHistoryReason"]);
  const archive = {
    stats: { chatCount: 2, messageCount: 9 },
    integrity: {
      manifestPresent: true,
      status: "mismatch",
      complete: false,
      expectedMessageCount: 10,
      parsedMessageCount: 9,
      totalMessagesMatch: false,
      expectedChatCount: 2,
      parsedChatCount: 2,
      chatCountMatch: true,
      incompleteChatCount: 1,
      issues: [{ code: "message-count-mismatch", chatId: "chat-1", expected: 10, actual: 9 }],
    },
  };
  const archiveView = archiveIntegrityView(archive);
  assert.equal(archiveView.status, "mismatch");
  assert.equal(archiveView.incompleteChatCount, 1);
  assert.equal(archiveView.totalMessagesMatch, false);
  assert.match(archiveView.issues[0], /message-count-mismatch.*chat-1.*预期 10，实际 9/);

  const chatView = chatIntegrityView({
    historyComplete: false,
    historyReason: "maximum-sync-rounds-reached",
    messages: new Array(9),
    extraction: {
      reported: true,
      complete: false,
      reason: "maximum-sync-rounds-reached",
      expectedMessageCount: 10,
      parsedMessageCount: 9,
      messageCountMatches: false,
    },
  });
  assert.equal(chatView.incomplete, true);
  assert.match(chatView.reason, /同步轮次上限/);
  assert.match(chatView.reason, /清单记录 10 条，实际解析 9 条/);

  const unreported = chatIntegrityView(
    { messages: [], extraction: { reported: false, complete: null, messageCountMatches: null } },
    { integrity: { manifestPresent: true } },
  );
  assert.equal(unreported.incomplete, true);
  assert.equal(unreported.label, "历史完整性未确认");
  assert.match(unreported.reason, /清单未报告/);
});

test("hook incompleteness reasons are presented in Chinese", () => {
  const formatHistoryReason = loadFunction("formatHistoryReason");
  assert.match(
    formatHistoryReason("maximum-sync-rounds-reached-without-end-evidence"),
    /同步轮次上限.*历史起点证据/,
  );
  assert.match(
    formatHistoryReason("conversation-panel-unavailable-or-scroll-failed"),
    /会话面板不可用.*无法滚动/,
  );
  assert.match(
    formatHistoryReason("history-end-confirmed-by-store-loader"),
    /Store 历史加载器.*历史起点/,
  );
  assert.match(
    formatHistoryReason("store-loader-returned-repeated-batches-without-progress"),
    /重复返回.*没有新增消息/,
  );
});

test("history diagnostic view formats every new Hook manifest field and keeps old reports hidden", () => {
  const historyDiagnosticsView = loadFunction("historyDiagnosticsView", [
    "formatHistoryReason",
    "formatHistoryLoaderFallback",
    "formatOpenDiagnostic",
  ]);
  const view = historyDiagnosticsView({
    chatTitle: "Alpha",
    complete: false,
    hasHistoryDiagnostics: true,
    historyAccessMethod: "WAWebChatLoadMessages.loadEarlierMsgs",
    historyLoaderFallback: {
      moduleName: "WAWebChatLoadMessages.loadEarlierMsgs",
      round: 3,
      timedOut: true,
      error: "store-loader-returned-repeated-batches-without-progress",
      rawResult: { secret: "must-not-render" },
    },
    storeLoadRounds: 5,
    storeReturnedMessages: 41,
    storeAddedMessages: 38,
    storeEmptyRounds: 2,
    storeStalledRounds: 1,
    openDiagnostics: [{
      phase: "visible-row-title-scan",
      surfaceMounted: true,
      observedChatIdPresent: true,
      observedChatIdMatches: false,
      observedTitlePresent: true,
      observedTitleMatches: true,
      activation: { matches: 3, rawNode: { secret: "must-not-render-either" } },
    }],
  });

  assert.equal(view.available, true);
  assert.equal(view.complete, false);
  assert.equal(view.fields.find((field) => field.label === "历史访问方式").value, "WAWebChatLoadMessages.loadEarlierMsgs");
  assert.equal(view.fields.find((field) => field.label === "Store 加载轮次").value, "5");
  assert.equal(view.fields.find((field) => field.label === "Store 返回 / 新增").value, "41 / 38");
  assert.equal(view.fields.find((field) => field.label === "Store 空批次 / 停滞").value, "2 / 1");
  assert.match(view.fields.find((field) => field.label === "加载器回退").value, /第 3 轮.*等待超时.*重复返回/);
  assert.match(view.openDiagnostics[0], /visible-row-title-scan.*会话界面已挂载.*会话 ID 不匹配.*标题匹配.*候选 3 个/);
  assert.doesNotMatch(JSON.stringify(view), /must-not-render/);

  const oldReport = historyDiagnosticsView({
    chatTitle: "旧版会话",
    complete: true,
    reason: "already-complete",
    messageCount: 1,
    hasHistoryDiagnostics: false,
  });
  assert.equal(oldReport.available, false);
});

test("archive information renderer exposes sanitized per-chat history diagnostics", () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.className = "";
      this.textContent = "";
      this.open = false;
    }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    addEventListener() {}
  }
  const document = { createElement: (tagName) => new FakeElement(tagName) };
  const declarations = [
    "formatHistoryReason",
    "formatHistoryLoaderFallback",
    "formatOpenDiagnostic",
    "historyDiagnosticsView",
    "createArchiveInfoField",
    "createHistoryDiagnosticsSection",
  ].map(functionSource).join("\n");
  const createHistoryDiagnosticsSection = vm.runInNewContext(
    `${declarations}\ncreateHistoryDiagnosticsSection;`,
    { document },
  );
  const section = createHistoryDiagnosticsSection({
    extractorBuildId: "2026-07-18-unopened-history-v2",
    chatReports: [{
      chatTitle: "Alpha",
      complete: false,
      hasHistoryDiagnostics: true,
      historyAccessMethod: "WAWebChatLoadMessages.loadEarlierMsgs",
      historyLoaderFallback: { round: 2, timedOut: false, error: "simulated store failure", private: { value: "secret-raw-value" } },
      storeLoadRounds: 2,
      storeReturnedMessages: 7,
      storeAddedMessages: 5,
      storeEmptyRounds: 0,
      storeStalledRounds: 1,
      openDiagnostics: [{
        phase: "search-input-scan",
        surfaceMounted: false,
        observedChatIdPresent: false,
        observedChatIdMatches: null,
        observedTitlePresent: false,
        observedTitleMatches: null,
        activation: { available: false },
        rawDom: { value: "secret-dom-value" },
      }],
    }],
  });
  const allText = (node) => [
    node && typeof node.textContent === "string" ? node.textContent : "",
    ...((node && node.children) || []).map(allText),
  ].join(" ");
  const text = allText(section);

  assert.match(text, /历史同步诊断/);
  assert.match(text, /Hook 构建版本.*2026-07-18-unopened-history-v2/);
  assert.match(text, /历史访问方式.*WAWebChatLoadMessages\.loadEarlierMsgs/);
  assert.match(text, /Store 加载轮次.*2/);
  assert.match(text, /Store 返回 \/ 新增.*7 \/ 5/);
  assert.match(text, /Store 空批次 \/ 停滞.*0 \/ 1/);
  assert.match(text, /加载器回退.*simulated store failure/);
  assert.match(text, /界面打开诊断.*search-input-scan.*搜索不可用/);
  assert.doesNotMatch(text, /secret-raw-value|secret-dom-value|\[object Object\]/);
  assert.match(functionSource("renderArchiveInfoDialog"), /createHistoryDiagnosticsSection\(archive\.extractionManifest\)/);
});

test("source keeps asynchronous ownership guards and removes silent search caps", () => {
  assert.match(source, /const loadToken = \+\+state\.archiveLoadToken/);
  assert.match(source, /loadToken !== state\.archiveLoadToken/);
  assert.match(source, /avatarRequestTokens\.get\(container\) !== requestToken/);
  assert.doesNotMatch(source, /messageMatches\.length >= 100/);
  assert.doesNotMatch(source, /\.slice\(0, 200\)/);
  assert.match(source, /const MESSAGE_WINDOW_MAX = 480/);
});

test("a slower previous archive load cannot replace a newer archive", async () => {
  const parseResolvers = new Map();
  const adopted = [];
  const loadingStates = [];
  const context = {
    ArrayBuffer,
    Parser: {
      parseArchive(_buffer, _zip, options) {
        return new Promise((resolve) => parseResolvers.set(options.sourceName, resolve));
      },
      digestSha512: async () => "digest",
    },
    window: { JSZip: {}, crypto: {} },
    state: { archiveLoadToken: 0 },
    elements: { zipInput: { value: "chosen.zip" } },
    clearArchiveForReplacement() {},
    setLoading(visible) { loadingStates.push(visible); },
    adoptArchive(archive) { adopted.push(archive.marker); },
    archiveIntegrityToastSuffix() { return ""; },
    showToast() {},
    friendlyError(error) { return String(error); },
    console: { error() {} },
  };
  const loadArchive = vm.runInNewContext(`${functionSource("loadArchive")}\nloadArchive;`, context);
  const oldLoad = loadArchive(new ArrayBuffer(1), "old.zip");
  const newLoad = loadArchive(new ArrayBuffer(2), "new.zip");

  parseResolvers.get("new.zip")({
    marker: "new",
    stats: { chatCount: 1, messageCount: 1, attachmentCount: 0 },
  });
  await newLoad;
  parseResolvers.get("old.zip")({
    marker: "old",
    stats: { chatCount: 9, messageCount: 9, attachmentCount: 9 },
  });
  await oldLoad;

  assert.deepEqual(adopted, ["new"]);
  assert.equal(context.elements.zipInput.value, "");
  assert.equal(loadingStates.at(-1), false);
});

test("an older avatar request cannot overwrite the latest container assignment", async () => {
  const urlResolvers = new Map();
  const container = {
    children: [],
    isConnected: true,
    style: { setProperty() {} },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
  };
  const context = {
    avatarRequestTokens: new WeakMap(),
    state: { generation: 1 },
    document: {
      createElement(tagName) {
        return {
          tagName,
          addEventListener(event, handler) {
            if (event === "load") queueMicrotask(handler);
          },
        };
      },
    },
    getObjectUrl(entryName) {
      return new Promise((resolve) => urlResolvers.set(entryName, resolve));
    },
    queueMicrotask,
  };
  const declarations = ["initials", "hashHue", "setAvatar"].map(functionSource).join("\n");
  const setAvatar = vm.runInNewContext(`${declarations}\nsetAvatar;`, context);
  setAvatar(container, { id: "a", title: "旧头像", avatarEntryName: "old.jpg" });
  setAvatar(container, { id: "b", title: "新头像", avatarEntryName: "new.jpg" });

  urlResolvers.get("new.jpg")("blob:new");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(container.children[0].src, "blob:new");

  urlResolvers.get("old.jpg")("blob:old");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(container.children[0].src, "blob:new");
});
