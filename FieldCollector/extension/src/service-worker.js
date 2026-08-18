"use strict";

const PROTOCOL = "field-collector-extension/1";
const COLLECTOR_URL = "ws://127.0.0.1:17654";
const PAIRING_PATTERN = /^[2-9A-HJ-NP-Z]{10}$/;
const REQUEST_ID_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const DISPATCH_FUNCTION = "function(command){ return this.dispatch(command); }";
const NEXT_FUNCTION = "function(){ return JSON.stringify(this.next()); }";
const ACK_FUNCTION = "function(sequence){ return this.ack(sequence); }";
const CANCEL_FUNCTION = "function(){ return this.cancel(); }";
const ALLOWED_FUNCTIONS = new Set([DISPATCH_FUNCTION, NEXT_FUNCTION, ACK_FUNCTION, CANCEL_FUNCTION]);

let active = null;
let status = Object.freeze({phase: "idle", message: "等待连接"});

function setStatus(phase, message) {
  status = Object.freeze({phase, message});
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactWhatsAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "web.whatsapp.com" && url.port === "";
  } catch { return false; }
}

function browserIdentity() {
  const edge = /Edg\/([0-9.]+)/.exec(navigator.userAgent);
  if (edge) return {browserFamily: "edge", browserVersion: edge[1]};
  const chrome = /Chrome\/([0-9.]+)/.exec(navigator.userAgent);
  return {browserFamily: "chrome", browserVersion: chrome?.[1] || "unknown"};
}

function wireSend(socket, message) {
  const text = JSON.stringify(message);
  if (text.length > MAX_MESSAGE_BYTES || socket.readyState !== WebSocket.OPEN) throw new Error("wire_send_failed");
  socket.send(text);
}

function validCallFunction(params) {
  if (!exactKeys(params, ["functionDeclaration", "objectId", "arguments", "awaitPromise", "returnByValue", "userGesture"])) return false;
  if (!ALLOWED_FUNCTIONS.has(params.functionDeclaration) || typeof params.objectId !== "string" || params.objectId.length > 512) return false;
  if (!Array.isArray(params.arguments) || params.arguments.length > 1 || params.awaitPromise !== true || params.returnByValue !== true || params.userGesture !== false) return false;
  if (params.functionDeclaration === DISPATCH_FUNCTION) {
    const command = params.arguments[0]?.value;
    return params.arguments.length === 1 && command && ["probe", "start_full"].includes(command.command) && exactKeys(command, ["command"]);
  }
  if (params.functionDeclaration === ACK_FUNCTION) {
    return params.arguments.length === 1 && typeof params.arguments[0]?.value === "string" && REQUEST_ID_PATTERN.test(params.arguments[0].value);
  }
  return params.arguments.length === 0;
}

function validCommand(method, params, adapterText) {
  if (method === "Runtime.enable") return exactKeys(params, []);
  if (method === "Runtime.evaluate") {
    return exactKeys(params, ["expression", "awaitPromise", "returnByValue", "userGesture"])
      && params.expression === adapterText && params.awaitPromise === false
      && params.returnByValue === false && params.userGesture === false;
  }
  if (method === "Runtime.callFunctionOn") return validCallFunction(params);
  if (method === "Runtime.releaseObject") {
    return exactKeys(params, ["objectId"]) && typeof params.objectId === "string" && params.objectId.length <= 512;
  }
  return false;
}

async function detach(reason = "closed") {
  const previous = active;
  active = null;
  if (previous) {
    try { await chrome.debugger.detach({tabId: previous.tabId}); } catch {}
    try { previous.socket.close(1000, reason); } catch {}
  }
  setStatus("idle", "连接已关闭");
}

async function handleCollectorMessage(raw) {
  if (!active || typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) throw new Error("invalid_wire_message");
  const message = JSON.parse(raw);
  if (message.protocol !== PROTOCOL) throw new Error("protocol_mismatch");
  if (message.kind === "paired" && exactKeys(message, ["kind", "protocol"])) {
    setStatus("paired", "已连接 FieldCollector，可在本机程序开始提取");
    return;
  }
  if (message.kind === "detach" && exactKeys(message, ["kind", "protocol"])) {
    await detach("host_detach");
    return;
  }
  if (message.kind !== "cdp_command" || !exactKeys(message, ["kind", "protocol", "requestId", "method", "params"])) throw new Error("invalid_host_command");
  if (!REQUEST_ID_PATTERN.test(message.requestId) || !validCommand(message.method, message.params, active.adapterText)) throw new Error("command_rejected");
  try {
    const tab = await chrome.tabs.get(active.tabId);
    if (!exactWhatsAppUrl(tab.url)) throw new Error("tab_origin_changed");
    const result = await chrome.debugger.sendCommand({tabId: active.tabId}, message.method, message.params);
    wireSend(active.socket, {kind: "cdp_response", protocol: PROTOCOL, requestId: message.requestId, ok: true, result: result ?? null});
  } catch (error) {
    wireSend(active.socket, {kind: "cdp_response", protocol: PROTOCOL, requestId: message.requestId, ok: false, error: String(error?.message || error)});
  }
}

async function beginPairing(pairingCode) {
  if (active) return {ok: false, message: "已有连接，请先在本机程序完成或取消。"};
  if (!PAIRING_PATTERN.test(pairingCode)) return {ok: false, message: "配对码格式不正确。"};
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab?.id || !exactWhatsAppUrl(tab.url)) return {ok: false, message: "请先打开并选中 WhatsApp Web 标签页。"};
  setStatus("connecting", "正在连接本机程序");
  let socket;
  try {
    const adapterText = await (await fetch(chrome.runtime.getURL("adapter/collector.iife.js"))).text();
    await chrome.debugger.attach({tabId: tab.id}, "1.3");
    socket = new WebSocket(COLLECTOR_URL);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connection_timeout")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, {once: true});
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("connection_failed")); }, {once: true});
    });
    active = {tabId: tab.id, socket, adapterText};
    socket.addEventListener("message", event => void handleCollectorMessage(event.data).catch(() => void detach("protocol_error")));
    socket.addEventListener("close", () => void detach("socket_closed"));
    socket.addEventListener("error", () => void detach("socket_error"));
    const identity = browserIdentity();
    wireSend(socket, {
      kind: "hello", protocol: PROTOCOL, pairingCode, url: tab.url,
      extensionVersion: chrome.runtime.getManifest().version,
      browserFamily: identity.browserFamily, browserVersion: identity.browserVersion
    });
    return {ok: true, message: "连接请求已发送，请返回本机程序。"};
  } catch (error) {
    try { if (tab?.id) await chrome.debugger.detach({tabId: tab.id}); } catch {}
    try { socket?.close(); } catch {}
    active = null;
    setStatus("error", "连接失败，请确认本机程序正在等待配对");
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
  sendResponse({ok: false, message: "不支持的请求"});
  return false;
});

chrome.debugger.onDetach.addListener(source => {
  if (active && source.tabId === active.tabId) void detach("debugger_detached");
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (active && tabId === active.tabId) void detach("tab_closed");
});
