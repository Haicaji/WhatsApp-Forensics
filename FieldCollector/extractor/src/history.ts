FC.messageId = function messageId(message) {
  const helper = FC._activeEnv?.msgGetters;
  try {
    if (helper && typeof helper.getId === "function") {
      const id = FC.idString(helper.getId(message));
      if (id) return id;
    }
  } catch {}
  return FC.idString(FC.first(message, ["id", "key", "stanzaId"])) || `synthetic_${FC.timestamp(message)}_${Math.random()}`;
};

FC.liveChatModels = function liveChatModels(chat, env) {
  const id = FC.idString(FC.first(chat, ["id", "wid"]));
  const output = [];
  const add = candidate => {
    if (!candidate || FC.idString(FC.first(candidate, ["id", "wid"])) !== id || output.includes(candidate)) return;
    output.push(candidate);
  };
  add(chat);
  try { if (typeof env.chatCollection?.get === "function") add(env.chatCollection.get(id)); } catch {}
  FC.collectionValues(env.chatCollection).forEach(add);
  return output;
};

FC.mergeChatMessages = function mergeChatMessages(chat, env, messageMap) {
  let added = 0;
  for (const live of FC.liveChatModels(chat, env)) {
    const messages = FC.collectionValues(FC.first(live, ["msgs", "messages"]));
    for (const message of messages) {
      const id = FC.messageId(message);
      if (!messageMap.has(id)) added += 1;
      messageMap.set(id, message);
    }
  }
  return added;
};

FC.historySnapshot = function historySnapshot(messageMap) {
  let oldestTimestamp = null;
  let oldestMessageId = null;
  for (const [id, message] of messageMap.entries()) {
    const raw = Number(FC.first(message, ["t", "timestamp", "ts"]) || 0);
    if (oldestTimestamp === null || raw < oldestTimestamp || (raw === oldestTimestamp && id < oldestMessageId)) {
      oldestTimestamp = raw;
      oldestMessageId = id;
    }
  }
  return {count: messageMap.size, oldestTimestamp, oldestMessageId};
};

FC.historyProgressed = function historyProgressed(before, after) {
  return after.count > before.count || after.oldestTimestamp !== before.oldestTimestamp || after.oldestMessageId !== before.oldestMessageId;
};

FC.sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

FC.withTimeout = function withTimeout(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("history_loader_timeout")), milliseconds);
    Promise.resolve(promise).then(value => {
      clearTimeout(timer);
      resolve(value);
    }, error => {
      clearTimeout(timer);
      reject(error);
    });
  });
};

FC.historyLoader = function historyLoader(env) {
  const module = env.historyLoader;
  const owner = module?.default && typeof module.default.loadEarlierMsgs === "function" ? module.default : module;
  return owner && typeof owner.loadEarlierMsgs === "function" ? owner : null;
};

FC.tryStoreHistory = async function tryStoreHistory(chat, env, messageMap, report, isCancelled) {
  const loader = FC.historyLoader(env);
  if (!loader) return false;
  report.method = "WAWebChatLoadMessages.loadEarlierMsgs";
  let emptyRounds = 0;
  for (let round = 1; round <= 500 && !isCancelled(); round += 1) {
    const before = FC.historySnapshot(messageMap);
    const live = FC.liveChatModels(chat, env).at(-1) || chat;
    let result;
    try {
      result = await FC.withTimeout(loader.loadEarlierMsgs({chat: live}), 120_000);
    } catch (error) {
      report.storeFallbackReason = String(error?.message || error);
      return false;
    }
    const returned = FC.collectionValues(result);
    for (const message of returned) messageMap.set(FC.messageId(message), message);
    FC.mergeChatMessages(chat, env, messageMap);
    const after = FC.historySnapshot(messageMap);
    report.rounds = round;
    if (FC.historyProgressed(before, after)) {
      emptyRounds = 0;
      continue;
    }
    if (returned.length === 0) emptyRounds += 1;
    else return false;
    if (emptyRounds >= 2) {
      report.complete = true;
      report.reason = "history_end_confirmed_by_store_loader";
      return true;
    }
    await FC.sleep(250);
  }
  report.storeFallbackReason = "store_round_limit";
  return false;
};

FC.activeChatId = function activeChatId(env) {
  for (const key of ["activeChat", "selectedChat", "currentChat"]) {
    const active = FC.read(env.chatCollection, key);
    const id = FC.idString(FC.first(active, ["id", "wid"]));
    if (id) return id;
  }
  return null;
};

FC.openChat = async function openChat(chat, env, options = {}) {
  const id = FC.idString(FC.first(chat, ["id", "wid"]));
  const title = String(FC.first(chat, ["formattedTitle", "name", "title"]) || "").trim();
  if (!options.force && FC.activeChatId(env) === id && document.getElementById("main")) {
    return {opened: true, method: "already_open"};
  }
  const side = document.getElementById("pane-side");
  const candidates = Array.from(side?.querySelectorAll?.("[data-chat-id],[data-id],[role='listitem']") || []);
  const titleMatches = title
    ? candidates.filter(row => String(row.querySelector?.("span[title]")?.getAttribute?.("title") || row.textContent || "").trim() === title)
    : [];
  for (const row of candidates) {
    const rowId = row.getAttribute?.("data-chat-id") || row.getAttribute?.("data-id") || "";
    const rowTitle = String(row.querySelector?.("span[title]")?.getAttribute?.("title") || row.textContent || "").trim();
    const exactId = rowId === id;
    const uniqueTitleWithoutConflictingId = !rowId && titleMatches.length === 1 && rowTitle === title;
    if (!exactId && !uniqueTitleWithoutConflictingId) continue;
    row.scrollIntoView?.({block: "center"});
    row.dispatchEvent?.(new MouseEvent("mousedown", {bubbles: true, cancelable: true, view: window}));
    row.click?.();
    for (let wait = 0; wait < 30; wait += 1) {
      await FC.sleep(200);
      if (FC.activeChatId(env) === id && document.getElementById("main")) return {opened: true, method: exactId ? "row_id" : "unique_title"};
    }
  }
  return {opened: false, reason: "chat_row_not_found_or_identity_unverified"};
};

FC.refreshedMessageModel = function refreshedMessageModel(message, chat, env) {
  const targetId = FC.messageId(message);
  let refreshed = message;
  for (const live of FC.liveChatModels(chat, env)) {
    for (const candidate of FC.collectionValues(FC.first(live, ["msgs", "messages"]))) {
      if (FC.messageId(candidate) === targetId) refreshed = candidate;
    }
  }
  return refreshed;
};

FC.conversationPanel = function conversationPanel() {
  return document.querySelector?.("[data-testid='conversation-panel-messages']") ||
    document.getElementById("main")?.querySelector?.("[role='application']") || null;
};

FC.earlierControl = function earlierControl(panel) {
  const pattern = /(?:earlier|older)\s+messages?|(?:较早|更早).*消息|消息.*(?:较早|更早)/i;
  return Array.from(panel?.querySelectorAll?.("button,[role='button'],a,[tabindex]") || [])
    .find(node => pattern.test(String(node.textContent || node.getAttribute?.("aria-label") || "")) && !node.disabled) || null;
};

FC.tryUiHistory = async function tryUiHistory(chat, env, messageMap, report, isCancelled) {
  const opened = await FC.openChat(chat, env);
  report.open = opened;
  if (!opened.opened) {
    report.reason = opened.reason;
    return;
  }
  report.method = report.method ? `${report.method}+ui_fallback` : "ui_scroll";
  let stableRounds = 0;
  for (let round = 1; round <= 500 && !isCancelled(); round += 1) {
    const panel = FC.conversationPanel();
    if (!panel) {
      report.reason = "conversation_panel_unavailable";
      return;
    }
    const before = FC.historySnapshot(messageMap);
    panel.scrollTop = 0;
    panel.dispatchEvent?.(new Event("scroll", {bubbles: true}));
    const control = FC.earlierControl(panel);
    control?.click?.();
    await FC.sleep(1_500);
    FC.mergeChatMessages(chat, env, messageMap);
    const after = FC.historySnapshot(messageMap);
    report.rounds = round;
    if (FC.historyProgressed(before, after)) stableRounds = 0;
    else stableRounds += 1;
    if (stableRounds >= 2 && !FC.earlierControl(panel)) {
      report.complete = true;
      report.reason = "history_end_stable_without_control";
      return;
    }
  }
  report.reason ||= isCancelled() ? "cancelled" : "ui_round_limit";
};

FC.syncChatHistory = async function syncChatHistory(chat, env, isCancelled) {
  const messageMap = new Map();
  FC.mergeChatMessages(chat, env, messageMap);
  const report = {
    chatId: FC.idString(FC.first(chat, ["id", "wid"])),
    startedAt: new Date().toISOString(),
    initialMessageCount: messageMap.size,
    rounds: 0,
    complete: false,
    reason: null
  };
  const handled = await FC.tryStoreHistory(chat, env, messageMap, report, isCancelled);
  if (!handled && !isCancelled()) await FC.tryUiHistory(chat, env, messageMap, report, isCancelled);
  FC.mergeChatMessages(chat, env, messageMap);
  const messages = Array.from(messageMap.values()).sort((left, right) => {
    const leftTime = Number(FC.first(left, ["t", "timestamp", "ts"]) || 0);
    const rightTime = Number(FC.first(right, ["t", "timestamp", "ts"]) || 0);
    return leftTime - rightTime || FC.messageId(left).localeCompare(FC.messageId(right));
  });
  report.messageCount = messages.length;
  report.finishedAt = new Date().toISOString();
  return {messages, report};
};
