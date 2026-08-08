"use strict";

const PROTOCOL = "wafc-extension-relay/1";
const SUBPROTOCOL = "wafc-extension-v1";
const COLLECTOR_URL = "ws://127.0.0.1:17653/wafc-extension";
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const PAIRING_PATTERN = /^[2-9A-HJ-NP-Z]{10}$/;
const REQUEST_ID_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const SESSION_ID_PATTERN = /^wafc-session-[0-9a-f]{32}$/;
const ALLOWED_EVENTS = new Set([
  "Page.navigatedWithinDocument",
  "Page.frameNavigated",
  "Runtime.executionContextCreated",
  "Runtime.executionContextsCleared",
  "Inspector.detached",
  "Target.targetDestroyed",
  "Target.detachedFromTarget",
  "Target.targetInfoChanged",
]);
const SIMPLE_COMMANDS = new Set([
  "Runtime.enable",
  "Page.enable",
  "Page.getFrameTree",
]);
const ALLOWED_FUNCTIONS = new Set([
  "function(command){ return this.dispatch(command); }",
  "function(){ return this.next(); }",
  "function(sequence){ return this.ack(sequence); }",
  "function(){ return this.checkAccountBinding(); }",
]);

let session = null;
let status = Object.freeze({phase: "idle", message: "等待连接"});

function setStatus(phase, message) {
  status = Object.freeze({phase, message});
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactWhatsAppUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname === "web.whatsapp.com"
      && parsed.port === ""
      && parsed.username === ""
      && parsed.password === "";
  } catch {
    return false;
  }
}

function browserIdentity() {
  const agent = navigator.userAgent;
  const edge = /Edg\/([0-9.]+)/.exec(agent);
  if (edge) {
    return {browser_family: "edge", browser_version: `Edge/${edge[1]}`};
  }
  const chrome = /Chrome\/([0-9.]+)/.exec(agent);
  if (chrome) {
    return {browser_family: "chrome", browser_version: `Chrome/${chrome[1]}`};
  }
  throw new Error("unsupported_browser");
}

async function loadAdapter() {
  const manifestResponse = await fetch(chrome.runtime.getURL("adapter/adapter-manifest.json"));
  const adapterResponse = await fetch(chrome.runtime.getURL("adapter/collector.iife.js"));
  if (!manifestResponse.ok || !adapterResponse.ok) {
    throw new Error("adapter_unavailable");
  }
  const [adapterManifest, adapterText] = await Promise.all([
    manifestResponse.json(),
    adapterResponse.text(),
  ]);
  if (!exactKeys(adapterManifest, ["schemaVersion", "adapterId", "version", "sha256"])) {
    throw new Error("adapter_manifest_invalid");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(adapterText));
  const sha256 = `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (adapterManifest.schemaVersion !== "wafc-adapter-manifest/1"
      || adapterManifest.adapterId !== "wa-private-collections-v1"
      || adapterManifest.version !== "1.0.0"
      || adapterManifest.sha256 !== sha256) {
    throw new Error("adapter_hash_mismatch");
  }
  return Object.freeze({
    text: adapterText,
    id: adapterManifest.adapterId,
    version: adapterManifest.version,
    sha256,
  });
}

function wireSend(socket, value) {
  const encoded = JSON.stringify(value);
  if (encoded.length > MAX_MESSAGE_BYTES || socket.readyState !== WebSocket.OPEN) {
    throw new Error("wire_unavailable");
  }
  socket.send(encoded);
}

function fixedErrorCode(error) {
  const code = String(error?.message || "");
  if (code === "adapter_hash_mismatch") {
    return "adapter_mismatch";
  }
  if (code === "target_changed") {
    return "target_changed";
  }
  if (code === "debugger_detached") {
    return "debugger_detached";
  }
  if (code === "command_rejected") {
    return "command_rejected";
  }
  return "command_failed";
}

async function currentTab() {
  const tabs = await chrome.tabs.query({active: true, currentWindow: true});
  if (tabs.length !== 1 || !Number.isInteger(tabs[0].id) || !exactWhatsAppUrl(tabs[0].url)) {
    throw new Error("target_changed");
  }
  return tabs[0];
}

function validateEvaluate(params, adapterText) {
  if (!exactKeys(params, ["expression", "awaitPromise", "returnByValue", "userGesture"])) {
    return false;
  }
  if (params.userGesture !== false || params.awaitPromise !== false) {
    return false;
  }
  if (params.expression === adapterText) {
    return params.returnByValue === false;
  }
  return params.expression === "window.location.origin" && params.returnByValue === true;
}

function validateCallFunction(params) {
  if (!exactKeys(params, [
    "functionDeclaration",
    "arguments",
    "awaitPromise",
    "returnByValue",
    "userGesture",
    "objectId",
  ])) {
    return false;
  }
  return ALLOWED_FUNCTIONS.has(params.functionDeclaration)
    && typeof params.objectId === "string"
    && params.objectId.length > 0
    && params.objectId.length <= 512
    && Array.isArray(params.arguments)
    && params.arguments.length <= 1
    && JSON.stringify(params.arguments).length <= 1024
    && params.awaitPromise === true
    && params.returnByValue === true
    && params.userGesture === false;
}

function validateRelease(params) {
  return exactKeys(params, ["objectId"])
    && typeof params.objectId === "string"
    && params.objectId.length > 0
    && params.objectId.length <= 512;
}

function validateCommand(method, params, adapterText) {
  if (SIMPLE_COMMANDS.has(method)) {
    return exactKeys(params, []);
  }
  if (method === "Runtime.evaluate") {
    return validateEvaluate(params, adapterText);
  }
  if (method === "Runtime.callFunctionOn") {
    return validateCallFunction(params);
  }
  if (method === "Runtime.releaseObject") {
    return validateRelease(params);
  }
  return false;
}

async function detachSession(reason, notify = true) {
  const active = session;
  session = null;
  if (!active) {
    return;
  }
  try {
    await chrome.debugger.detach({tabId: active.tabId});
  } catch {
    // Detach may already have been completed by Chrome; never expose raw text.
  }
  if (notify && active.socket.readyState === WebSocket.OPEN) {
    try {
      wireSend(active.socket, {kind: "detached", protocol: PROTOCOL, reason});
    } catch {
      // The Collector independently detects channel closure.
    }
  }
  try {
    active.socket.close(1000, "finished");
  } catch {
    // Closed already.
  }
}

async function executeCommand(message) {
  const active = session;
  if (!active
      || message.protocol !== PROTOCOL
      || !REQUEST_ID_PATTERN.test(message.request_id)
      || typeof message.method !== "string"
      || !validateCommand(message.method, message.params, active.adapter.text)) {
    throw new Error("command_rejected");
  }
  const tab = await chrome.tabs.get(active.tabId);
  if (!exactWhatsAppUrl(tab.url)) {
    throw new Error("target_changed");
  }
  return chrome.debugger.sendCommand({tabId: active.tabId}, message.method, message.params);
}

async function handleCollectorMessage(raw) {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) {
    throw new Error("command_rejected");
  }
  const message = JSON.parse(raw);
  if (!message || typeof message !== "object" || message.protocol !== PROTOCOL) {
    throw new Error("command_rejected");
  }
  if (message.kind === "paired") {
    if (!session || !exactKeys(message, ["kind", "protocol", "session_id"])
        || !SESSION_ID_PATTERN.test(message.session_id)) {
      throw new Error("command_rejected");
    }
    session.sessionId = message.session_id;
    setStatus("paired", "已连接 Field Collector");
    return;
  }
  if (message.kind === "cdp_command") {
    if (!exactKeys(message, ["kind", "protocol", "request_id", "method", "params"])) {
      throw new Error("command_rejected");
    }
    try {
      const result = await executeCommand(message);
      wireSend(session.socket, {
        kind: "cdp_response",
        protocol: PROTOCOL,
        request_id: message.request_id,
        ok: true,
        result: result || {},
      });
    } catch (error) {
      if (session?.socket?.readyState === WebSocket.OPEN) {
        wireSend(session.socket, {
          kind: "cdp_response",
          protocol: PROTOCOL,
          request_id: message.request_id,
          ok: false,
          error_code: fixedErrorCode(error),
        });
      }
      if (fixedErrorCode(error) === "target_changed") {
        await detachSession("target_closed");
      }
    }
    return;
  }
  if (message.kind === "detach") {
    if (!session || !exactKeys(message, ["kind", "protocol", "request_id"])
        || !REQUEST_ID_PATTERN.test(message.request_id)) {
      throw new Error("command_rejected");
    }
    const active = session;
    try {
      await chrome.debugger.detach({tabId: active.tabId});
      wireSend(active.socket, {
        kind: "cdp_response",
        protocol: PROTOCOL,
        request_id: message.request_id,
        ok: true,
        result: {},
      });
      session = null;
      setStatus("completed", "只读连接已安全结束");
    } catch {
      wireSend(active.socket, {
        kind: "cdp_response",
        protocol: PROTOCOL,
        request_id: message.request_id,
        ok: false,
        error_code: "debugger_detached",
      });
    }
    return;
  }
  if (message.kind === "abort") {
    if (!exactKeys(message, ["kind", "protocol", "reason"])) {
      throw new Error("command_rejected");
    }
    await detachSession("collector_requested", false);
    setStatus("completed", "Collector 已结束连接");
    return;
  }
  throw new Error("command_rejected");
}

async function beginPairing(pairingCode) {
  if (session) {
    return {ok: false, message: "已有采集连接，请先返回 Collector 完成或取消。"};
  }
  if (!PAIRING_PATTERN.test(pairingCode)) {
    return {ok: false, message: "一次性配对码格式不正确。"};
  }
  setStatus("connecting", "正在连接 Field Collector");
  let tab;
  let adapter;
  let socket;
  try {
    tab = await currentTab();
    adapter = await loadAdapter();
    await chrome.debugger.attach({tabId: tab.id}, "1.3");
    socket = new WebSocket(COLLECTOR_URL, SUBPROTOCOL);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("pairing_timeout")), 10000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, {once: true});
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("pairing_failed"));
      }, {once: true});
    });
    const browser = browserIdentity();
    session = {
      tabId: tab.id,
      initialUrl: tab.url,
      adapter,
      socket,
      sessionId: null,
    };
    socket.addEventListener("message", (event) => {
      void handleCollectorMessage(event.data).catch(async () => {
        setStatus("failed", "Collector 命令未通过安全校验，连接已停止。");
        await detachSession("canceled_by_user");
      });
    });
    socket.addEventListener("close", () => {
      if (session?.socket === socket) {
        void detachSession("collector_requested", false);
        setStatus("failed", "Collector 连接已关闭。");
      }
    });
    wireSend(socket, {
      kind: "hello",
      protocol: PROTOCOL,
      pairing_code: pairingCode,
      extension_version: EXTENSION_VERSION,
      adapter_id: adapter.id,
      adapter_sha256: adapter.sha256,
      browser_family: browser.browser_family,
      browser_version: browser.browser_version,
      tab_url: tab.url,
    });
    return {ok: true};
  } catch {
    if (Number.isInteger(tab?.id)) {
      try {
        await chrome.debugger.detach({tabId: tab.id});
      } catch {
        // No raw diagnostic leaves the extension.
      }
    }
    try {
      socket?.close();
    } catch {
      // Closed already.
    }
    session = null;
    setStatus("failed", "连接未完成。请确认当前是 WhatsApp 页面且 Collector 正在等待。");
    return {ok: false, message: status.message};
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind === "get_status") {
    sendResponse(status);
    return false;
  }
  if (message?.kind === "begin_pairing" && exactKeys(message, ["kind", "pairingCode"])) {
    void beginPairing(String(message.pairingCode || "").toUpperCase()).then(sendResponse);
    return true;
  }
  sendResponse({ok: false, message: "不支持的连接请求。"});
  return false;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!session || source.tabId !== session.tabId || !ALLOWED_EVENTS.has(method)) {
    return;
  }
  try {
    wireSend(session.socket, {
      kind: "cdp_event",
      protocol: PROTOCOL,
      method,
      params: params || {},
    });
  } catch {
    void detachSession("debugger_detached", false);
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!session || source.tabId !== session.tabId) {
    return;
  }
  const mapped = reason === "target_closed" ? "target_closed" : "canceled_by_user";
  const active = session;
  session = null;
  if (active.socket.readyState === WebSocket.OPEN) {
    try {
      wireSend(active.socket, {kind: "detached", protocol: PROTOCOL, reason: mapped});
    } catch {
      // Collector also observes channel closure.
    }
  }
  try {
    active.socket.close(1000, "detached");
  } catch {
    // Closed already.
  }
  setStatus("failed", "浏览器已结束当前只读连接。");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!session || tabId !== session.tabId || typeof changeInfo.url !== "string") {
    return;
  }
  if (changeInfo.url !== session.initialUrl || !exactWhatsAppUrl(changeInfo.url)) {
    setStatus("failed", "目标页面已发生变化，连接已停止。");
    void detachSession("target_closed");
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (session && tabId === session.tabId) {
    setStatus("failed", "目标页面已关闭，连接已停止。");
    void detachSession("target_closed");
  }
});
