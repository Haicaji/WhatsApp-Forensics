"use strict";

let session = null;
let status = Object.freeze({phase: "idle", message: "等待连接"});

function setStatus(phase, message) {
  status = Object.freeze({phase, message});
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

async function detachSession(reason, notify = true) {
  const active = session;
  session = null;
  if (!active) {
    return;
  }
  if (typeof active.pairingReject === "function") {
    active.pairingReject(new Error("pairing_failed"));
    active.pairingResolve = null;
    active.pairingReject = null;
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
    if (typeof session.pairingResolve === "function") {
      session.pairingResolve();
      session.pairingResolve = null;
      session.pairingReject = null;
    }
    return;
  }
  if (message.kind === "heartbeat") {
    if (!session || !exactKeys(message, ["kind", "protocol", "nonce"])
        || !REQUEST_ID_PATTERN.test(message.nonce)) {
      throw new Error("command_rejected");
    }
    wireSend(session.socket, {
      kind: "heartbeat",
      protocol: PROTOCOL,
      nonce: message.nonce,
    });
    return;
  }
  if (message.kind === "cdp_command") {
    if (!exactKeys(message, ["kind", "protocol", "request_id", "method", "params"])) {
      throw new Error("command_rejected");
    }
    setStatus("collecting", "正在执行只读取证采集");
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
      active.expectedDetach = true;
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
    let pairingResolve;
    let pairingReject;
    const pairingConfirmed = new Promise((resolve, reject) => {
      pairingResolve = resolve;
      pairingReject = reject;
    });
    const pairingTimer = setTimeout(() => pairingReject(new Error("pairing_timeout")), 10000);
    session = {
      tabId: tab.id,
      initialUrl: tab.url,
      adapter,
      socket,
      sessionId: null,
      pairingResolve: () => {
        clearTimeout(pairingTimer);
        pairingResolve();
      },
      pairingReject: (error) => {
        clearTimeout(pairingTimer);
        pairingReject(error);
      },
      expectedDetach: false,
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
    await pairingConfirmed;
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
  if (session.expectedDetach) {
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
