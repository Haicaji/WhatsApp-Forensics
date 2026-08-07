(function () {
  "use strict";

  const Parser = window.ShowMessageParser;
  const DateTime = window.ShowMessageDateTime;
  const $ = (id) => document.getElementById(id);
  const elements = {
    app: $("app"),
    mediaLibraryButton: $("mediaLibraryButton"),
    mobileSettingsButton: $("mobileSettingsButton"),
    settingsView: $("settingsView"),
    settingsBackButton: $("settingsBackButton"),
    settingsViewContent: $("settingsViewContent"),
    profileButton: $("profileButton"),
    profileView: $("profileView"),
    profileBackButton: $("profileBackButton"),
    profileViewContent: $("profileViewContent"),
    headerOpenButton: $("headerOpenButton"),
    archiveInfoButton: $("archiveInfoButton"),
    chatSearch: $("chatSearch"),
    filterRow: $("filterRow"),
    chatList: $("chatList"),
    chatListEmpty: $("chatListEmpty"),
    emptyResetButton: $("emptyResetButton"),
    welcomePanel: $("welcomePanel"),
    conversationView: $("conversationView"),
    backToChats: $("backToChats"),
    conversationAvatar: $("conversationAvatar"),
    conversationSearchButton: $("conversationSearchButton"),
    conversationTitle: $("conversationTitle"),
    conversationSubtitle: $("conversationSubtitle"),
    messagesBody: $("messagesBody"),
    messageList: $("messageList"),
    floatingDate: $("floatingDate"),
    detailPanel: $("detailPanel"),
    detailPanelClose: $("detailPanelClose"),
    detailPanelTitle: $("detailPanelTitle"),
    detailPanelContent: $("detailPanelContent"),
    zipInput: $("zipInput"),
    dropOverlay: $("dropOverlay"),
    loadingOverlay: $("loadingOverlay"),
    loadingTitle: $("loadingTitle"),
    loadingProgress: $("loadingProgress"),
    loadingDetail: $("loadingDetail"),
    mediaDialog: $("mediaDialog"),
    mediaDialogTitle: $("mediaDialogTitle"),
    mediaDialogMeta: $("mediaDialogMeta"),
    mediaDialogCounter: $("mediaDialogCounter"),
    mediaDownloadButton: $("mediaDownloadButton"),
    mediaCloseButton: $("mediaCloseButton"),
    mediaPreviousButton: $("mediaPreviousButton"),
    mediaNextButton: $("mediaNextButton"),
    mediaDialogContent: $("mediaDialogContent"),
    libraryDialog: $("libraryDialog"),
    libraryDialogTitle: $("libraryDialogTitle"),
    libraryDialogSubtitle: $("libraryDialogSubtitle"),
    libraryDialogClose: $("libraryDialogClose"),
    libraryTabs: $("libraryTabs"),
    libraryDialogContent: $("libraryDialogContent"),
    archiveInfoDialog: $("archiveInfoDialog"),
    archiveInfoDialogClose: $("archiveInfoDialogClose"),
    archiveInfoDialogContent: $("archiveInfoDialogContent"),
    toast: $("toast"),
    themeColor: document.querySelector('meta[name="theme-color"]'),
  };

  const state = {
    archive: null,
    activeChatId: "",
    filter: "all",
    query: "",
    generation: 0,
    urls: new Map(),
    urlPromises: new Map(),
    transientUrls: new Set(),
    videoFramePreviews: new Map(),
    videoFramePreviewPromises: new Map(),
    videoFramePreviewConsumers: new Map(),
    activeAudio: null,
    audioPlayRequestToken: 0,
    dialogMedia: null,
    dialogObjectUrl: "",
    dialogItems: [],
    dialogIndex: -1,
    dialogRequestToken: 0,
    toastTimer: 0,
    dragDepth: 0,
    detailMode: "",
    detailMediaTab: "media",
    detailReturnFocus: null,
    libraryTab: "media",
    libraryChatId: "",
    floatingDateFrame: 0,
    floatingDateRevealPending: false,
    floatingDateHideTimer: 0,
    floatingDateCleanupTimer: 0,
    highlightTimer: 0,
    closeDatePicker: null,
    timeZone: initialTimeZone(),
    archiveLoadToken: 0,
    chatSearchLimit: 50,
    messageWindow: { chatId: "", start: 0, end: 0 },
  };
  const DEFAULT_TIME_ZONE = DateTime ? DateTime.DEFAULT_TIME_ZONE : "Asia/Shanghai";
  const TIME_ZONE_STORAGE_KEY = "showmesssage-time-zone";
  const FLOATING_DATE_HIDE_DELAY = 720;
  const FLOATING_DATE_FADE_CLEANUP_DELAY = 190;
  const FLOATING_DATE_ANCHOR_OFFSET = 42;
  const FLOATING_DATE_COLLISION_OFFSET = 72;
  const CHAT_SEARCH_PAGE_SIZE = 50;
  const DETAIL_SEARCH_PAGE_SIZE = 50;
  const MESSAGE_WINDOW_SIZE = 160;
  const MESSAGE_WINDOW_CONTEXT = 64;
  const MESSAGE_WINDOW_MAX = 480;
  const MAX_VIDEO_FRAME_SOURCE_BYTES = 96 * 1024 * 1024;
  const MAX_VIDEO_FRAME_WIDTH = 640;
  const MAX_VIDEO_FRAME_HEIGHT = 360;
  const MAX_CACHED_OBJECT_URLS = 96;
  const avatarRequestTokens = new WeakMap();
  let lazyMediaObserver = null;
  let videoFrameQueue = Promise.resolve();

  const COMMON_TIME_ZONES = [
    "Asia/Shanghai",
    "Asia/Hong_Kong",
    "Asia/Taipei",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Asia/Seoul",
    "Asia/Kolkata",
    "Europe/London",
    "Europe/Paris",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "Australia/Sydney",
    "Pacific/Auckland",
    "UTC",
  ];
  const TIME_ZONE_NAMES = {
    "Asia/Shanghai": "中国标准时间",
    "Asia/Hong_Kong": "香港时间",
    "Asia/Taipei": "台北时间",
    "Asia/Singapore": "新加坡时间",
    "Asia/Tokyo": "日本标准时间",
    "Asia/Seoul": "韩国标准时间",
    "Asia/Kolkata": "印度标准时间",
    "Europe/London": "伦敦时间",
    "Europe/Paris": "巴黎时间",
    "America/New_York": "纽约时间",
    "America/Chicago": "芝加哥时间",
    "America/Denver": "丹佛时间",
    "America/Los_Angeles": "洛杉矶时间",
    "Australia/Sydney": "悉尼时间",
    "Pacific/Auckland": "奥克兰时间",
    UTC: "协调世界时",
  };
  let dateFormatter;
  let timeFormatter;
  let accessibleDateFormatter;

  function rebuildDateTimeFormatters() {
    const timeZone = state.timeZone || DEFAULT_TIME_ZONE;
    dateFormatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    timeFormatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    accessibleDateFormatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "UTC",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
    });
  }

  rebuildDateTimeFormatters();

  function icon(name, className) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", className || "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#icon-${name}`);
    svg.append(use);
    return svg;
  }

  function setTheme(theme, persist) {
    const next = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    const themeToggle = $("themeToggle");
    if (themeToggle) {
      themeToggle.setAttribute(
        "aria-label",
        next === "dark" ? "切换到浅色主题" : "切换到深色主题",
      );
    }
    elements.themeColor.setAttribute("content", next === "dark" ? "#161717" : "#F7F5F3");
    if (persist) {
      try {
        localStorage.setItem("showmesssage-theme", next);
      } catch (_error) {
        // file:// 隐私模式可能禁用 localStorage；主题本身仍然可用。
      }
    }
  }

  function initialTheme() {
    try {
      return localStorage.getItem("showmesssage-theme") || "dark";
    } catch (_error) {
      return "dark";
    }
  }

  function initialTimeZone() {
    let stored = "";
    try {
      stored = localStorage.getItem("showmesssage-time-zone") || "";
    } catch (_error) {
      stored = "";
    }
    if (DateTime) return DateTime.normalizeTimeZone(stored || DateTime.DEFAULT_TIME_ZONE);
    return "Asia/Shanghai";
  }

  function timeZoneOffsetLabel(timestamp) {
    if (!DateTime) return state.timeZone === "UTC" ? "UTC+00:00" : "UTC+08:00";
    return DateTime.offsetLabel(state.timeZone, timestamp);
  }

  function timeZoneFriendlyName(timeZone) {
    return TIME_ZONE_NAMES[timeZone] || String(timeZone || DEFAULT_TIME_ZONE).replaceAll("_", " ");
  }

  function timeZoneContextLabel(timestamp) {
    return `${timeZoneOffsetLabel(timestamp)}（${state.timeZone}）`;
  }

  function formatTimestampTitle(timestamp) {
    if (!timestamp) return `时间未知 · ${timeZoneContextLabel()}`;
    const date = new Date(timestamp * 1000);
    return `${dateFormatter.format(date)} ${formatTime(timestamp)} · ${timeZoneContextLabel(timestamp)}`;
  }

  function updateConversationSubtitle(chat) {
    if (!chat) return;
    const zoneLabel = timeZoneOffsetLabel(Date.now() / 1000);
    const integrity = chatIntegrityView(chat, state.archive);
    const integrityLabel = integrity.incomplete ? ` · ${integrity.label}${integrity.reason ? `（${integrity.reason}）` : ""}` : "";
    elements.conversationSubtitle.textContent = `${chat.messages.length} 条消息 · 本地只读 · 时间 ${zoneLabel}${integrityLabel}`;
    elements.conversationSubtitle.classList.toggle("is-incomplete", integrity.incomplete);
    elements.conversationSubtitle.title = integrity.incomplete
      ? `提取清单提示：${integrity.reason || "无法确认此会话的全部历史记录"}`
      : `消息日期和时间按 ${state.timeZone}（当前 ${zoneLabel}）显示，可在设置中更改`;
  }

  function persistTimeZone(timeZone) {
    try {
      localStorage.setItem(TIME_ZONE_STORAGE_KEY, timeZone);
    } catch (_error) {
      // file:// 隐私模式可能禁用 localStorage；本次设置仍然有效。
    }
  }

  function captureMessageScrollAnchor() {
    const listBounds = elements.messageList.getBoundingClientRect();
    const rows = elements.messageList.querySelectorAll(".message-row[data-message-id]");
    for (const row of rows) {
      const bounds = row.getBoundingClientRect();
      if (bounds.bottom >= listBounds.top + 8) {
        return {
          id: row.dataset.messageId,
          offset: bounds.top - listBounds.top,
        };
      }
    }
    return null;
  }

  function refreshTimeZonePresentation() {
    const chat = getActiveChat();
    const anchor = chat ? captureMessageScrollAnchor() : null;
    const wasNearBottom = chat
      ? elements.messageList.scrollHeight - elements.messageList.scrollTop - elements.messageList.clientHeight < 72
      : false;
    renderChatList();
    if (!chat) return;
    updateConversationSubtitle(chat);
    elements.messageList.classList.add("is-positioning");
    renderMessages(chat, { preserveWindow: true });
    requestAnimationFrame(() => {
      if (wasNearBottom) {
        elements.messageList.scrollTop = elements.messageList.scrollHeight;
      } else if (anchor) {
        const row = elements.messageList.querySelector(`[data-message-id="${cssEscape(anchor.id)}"]`);
        if (row) {
          const listBounds = elements.messageList.getBoundingClientRect();
          elements.messageList.scrollTop += row.getBoundingClientRect().top - listBounds.top - anchor.offset;
        }
      }
      elements.messageList.classList.remove("is-positioning");
      updateFloatingDate(false);
    });
    if (!elements.detailPanel.hidden) {
      if (state.detailMode === "search") renderConversationSearchPanel();
      else if (state.detailMode === "media") renderChatMediaPanel();
      else if (state.detailMode === "contact") renderContactPanel();
    }
  }

  function setTimeZone(timeZone, persist) {
    const next = DateTime ? DateTime.normalizeTimeZone(timeZone) : DEFAULT_TIME_ZONE;
    if (next === state.timeZone) return false;
    state.timeZone = next;
    rebuildDateTimeFormatters();
    if (persist) persistTimeZone(next);
    refreshTimeZonePresentation();
    return true;
  }

  function showToast(message) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, 3600);
  }

  function setLoading(visible, title, detail, percent) {
    elements.loadingOverlay.hidden = !visible;
    elements.app.setAttribute("aria-busy", visible ? "true" : "false");
    if (title) elements.loadingTitle.textContent = title;
    if (detail) elements.loadingDetail.textContent = detail;
    const bounded = Math.max(0, Math.min(100, Number(percent || 0)));
    elements.loadingProgress.style.width = `${bounded}%`;
  }

  function openPicker() {
    elements.zipInput.click();
  }

  function isZipFile(file) {
    return Boolean(file && (/\.zip$/i.test(file.name || "") || /zip/i.test(file.type || "")));
  }

  function friendlyError(error) {
    const messages = {
      INVALID_ZIP: "无法打开这个文件：它不是有效的 ZIP。",
      MISSING_JSON: "ZIP 中缺少 chats.json。请使用完整的 ZAPiXWEB 导出包。",
      MISSING_CHATS: "ZIP 中没有 Chat <id>.json 消息文件。",
      INVALID_JSON: error && error.message ? error.message : "导出包中的 JSON 已损坏。",
      EMPTY_ARCHIVE: "ZIP 中没有可显示的会话。",
      NO_ZIP_LIBRARY: "本地 ZIP 组件未加载，请确认 vendor 文件完整。",
      NO_WEB_CRYPTO: "当前浏览器无法计算 ZIP 的 SHA-512。",
    };
    return messages[error && error.code] || (error && error.message) || "载入聊天记录时发生未知错误。";
  }

  function formatHistoryReason(reason) {
    const value = String(reason || "").trim();
    if (!value) return "";
    const labels = {
      "history-end-confirmed-by-store-loader": "Store 历史加载器已确认到达历史起点",
      "maximum-store-loader-rounds-reached-without-end-evidence": "Store 历史加载器达到轮次上限，且没有找到历史起点证据",
      "store-loader-returned-repeated-batches-without-progress": "Store 历史加载器重复返回相同批次，没有新增消息",
      "maximum-sync-rounds-reached": "达到同步轮次上限",
      "maximum-sync-rounds-reached-without-end-evidence": "达到同步轮次上限，且没有找到历史起点证据",
      "sync-made-no-progress": "同步未继续取得进展",
      "earlier-messages-control-absent": "未发现更早消息控件",
      "conversation-panel-unavailable-or-scroll-failed": "会话面板不可用或无法滚动到更早消息",
      "missing-chat-identity": "会话缺少可验证的身份标识",
      "chat-id-not-found": "未找到对应的会话 ID",
      "ambiguous-title": "存在同名会话，无法唯一确认目标",
      "search-unavailable": "WhatsApp 会话搜索不可用",
      "not-found": "未找到目标会话",
      "open-timeout": "打开会话超时",
      "unverifiable-duplicate-title": "存在同名会话，无法确认目标",
      "open-failed": "无法打开会话",
    };
    if (labels[value]) return labels[value];
    if (value.startsWith("unrecognized-store-loader-result:")) {
      return `Store 历史加载器返回了无法识别的结果（${value.slice(33) || "未知类型"}）`;
    }
    if (/timed out after \d+ms/i.test(value)) {
      return value.replace(/timed out after (\d+)ms/i, "等待超时（$1 毫秒）");
    }
    if (value.startsWith("exception:")) return `提取异常：${value.slice(10).trim() || "未知错误"}`;
    return value;
  }

  function formatHistoryLoaderFallback(fallback) {
    if (!fallback) return "未触发";
    if (typeof fallback === "string") return formatHistoryReason(fallback) || "已触发（原因未记录）";
    if (typeof fallback !== "object" || Array.isArray(fallback)) return "已触发（详情格式无效）";
    const safeText = (value, limit) => (
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, limit)
        : ""
    );
    const parts = [];
    const moduleName = safeText(fallback.moduleName, 160);
    const round = Number(fallback.round);
    const error = safeText(fallback.error, 320);
    if (moduleName) parts.push(`模块 ${moduleName}`);
    if (Number.isFinite(round) && round >= 0) parts.push(`第 ${Math.floor(round)} 轮`);
    if (fallback.timedOut === true) parts.push("等待超时");
    if (error) parts.push(formatHistoryReason(error));
    return parts.join("；") || "已触发（原因未记录）";
  }

  function formatOpenDiagnostic(diagnostic, index) {
    if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return "";
    const safeText = (value, limit) => (
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, limit)
        : ""
    );
    const phase = safeText(diagnostic.phase, 120) || `阶段 ${Number(index || 0) + 1}`;
    const parts = [];
    if (diagnostic.surfaceMounted === true) parts.push("会话界面已挂载");
    else if (diagnostic.surfaceMounted === false) parts.push("会话界面未挂载");
    if (diagnostic.observedChatIdMatches === true) parts.push("会话 ID 匹配");
    else if (diagnostic.observedChatIdMatches === false) parts.push("会话 ID 不匹配");
    else if (diagnostic.observedChatIdPresent === true) parts.push("检测到会话 ID，但无法比对");
    if (diagnostic.observedTitleMatches === true) parts.push("标题匹配");
    else if (diagnostic.observedTitleMatches === false) parts.push("标题不匹配");
    else if (diagnostic.observedTitlePresent === true) parts.push("检测到标题，但无法比对");
    const activation = diagnostic.activation;
    if (activation && typeof activation === "object" && !Array.isArray(activation)) {
      if (activation.activated === true) parts.push("已触发交互");
      else if (activation.activated === false) parts.push("未能触发交互");
      const target = safeText(activation.target, 96);
      const reason = safeText(activation.reason, 240);
      const matches = Number(activation.matches);
      if (target) parts.push(`目标 ${target}`);
      if (Number.isFinite(matches) && matches >= 0) parts.push(`候选 ${Math.floor(matches)} 个`);
      if (activation.available === true) parts.push("搜索可用");
      else if (activation.available === false) parts.push("搜索不可用");
      if (activation.chatIdValid === true) parts.push("目标 ID 有效");
      else if (activation.chatIdValid === false) parts.push("目标 ID 无效");
      if (activation.titlePresent === true) parts.push("目标标题存在");
      else if (activation.titlePresent === false) parts.push("目标标题缺失");
      if (reason) parts.push(`原因 ${formatHistoryReason(reason)}`);
    }
    return `${phase}：${parts.join("；") || "没有记录更多状态"}`;
  }

  function historyDiagnosticsView(report) {
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      return { available: false, title: "", fields: [], openDiagnostics: [] };
    }
    const keys = [
      "historyAccessMethod",
      "historyLoaderFallback",
      "storeLoadRounds",
      "storeReturnedMessages",
      "storeAddedMessages",
      "storeEmptyRounds",
      "storeStalledRounds",
      "openDiagnostics",
    ];
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(report, key);
    const available = report.hasHistoryDiagnostics === true
      || (report.hasHistoryDiagnostics !== false && keys.some(hasOwn));
    if (!available) return { available: false, title: "", fields: [], openDiagnostics: [] };
    const safeText = (value, limit) => (
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, limit)
        : ""
    );
    const countText = (value) => {
      if (value == null || value === "") return "未记录";
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? String(Math.floor(number)) : "无效值";
    };
    const accessMethod = safeText(report.historyAccessMethod, 160) || "未记录（使用界面回退或旧版 Hook）";
    const title = safeText(report.chatTitle, 160) || "未命名会话";
    const openDiagnostics = Array.isArray(report.openDiagnostics)
      ? report.openDiagnostics.map(formatOpenDiagnostic).filter(Boolean)
      : [];
    return {
      available: true,
      title,
      complete: report.complete === true ? true : report.complete === false ? false : null,
      fields: [
        { label: "历史访问方式", value: accessMethod, monospace: true },
        { label: "Store 加载轮次", value: countText(report.storeLoadRounds) },
        {
          label: "Store 返回 / 新增",
          value: `${countText(report.storeReturnedMessages)} / ${countText(report.storeAddedMessages)}`,
        },
        {
          label: "Store 空批次 / 停滞",
          value: `${countText(report.storeEmptyRounds)} / ${countText(report.storeStalledRounds)}`,
        },
        { label: "加载器回退", value: formatHistoryLoaderFallback(report.historyLoaderFallback) },
      ],
      openDiagnostics,
    };
  }

  function chatIntegrityView(chat, archive) {
    const extraction = (chat && (chat.extraction || chat.extractionReport)) || {};
    const reported = extraction.reported === true
      || chat?.historyComplete === true
      || chat?.historyComplete === false;
    const complete = extraction.complete ?? chat?.historyComplete ?? null;
    const messageCountMatches = extraction.messageCountMatches ?? chat?.messageCountMatches ?? null;
    const manifestPresent = Boolean(archive && (
      archive.integrity?.manifestPresent
      || archive.extractionManifest
    ));
    const unverified = manifestPresent && complete !== true;
    const incomplete = complete === false || messageCountMatches === false || unverified;
    const label = complete === false || messageCountMatches === false ? "历史可能不完整" : "历史完整性未确认";
    let reason = formatHistoryReason(extraction.reason || chat?.historyReason);
    if (messageCountMatches === false) {
      const expected = extraction.expectedMessageCount ?? chat?.reportedMessageCount;
      const parsed = extraction.parsedMessageCount ?? chat?.messages?.length;
      const mismatch = Number.isFinite(Number(expected))
        ? `清单记录 ${Number(expected)} 条，实际解析 ${Number(parsed || 0)} 条`
        : "清单消息数与实际解析结果不一致";
      reason = reason ? `${reason}；${mismatch}` : mismatch;
    }
    if (!reason && unverified) {
      reason = reported ? "清单没有确认此会话已完整提取" : "提取清单未报告此会话";
    }
    return { reported, complete, messageCountMatches, incomplete, label, reason };
  }

  function formatIntegrityIssue(issue) {
    if (typeof issue === "string") return issue;
    if (!issue || typeof issue !== "object") return String(issue || "未知完整性问题");
    const parts = [];
    if (issue.code) parts.push(`[${issue.code}]`);
    if (issue.chatId) parts.push(`会话 ${issue.chatId}`);
    if (issue.reason) parts.push(formatHistoryReason(issue.reason));
    const expected = issue.expected ?? issue.expectedCount ?? issue.expectedMessageCount;
    const actual = issue.actual ?? issue.actualCount ?? issue.parsedMessageCount;
    if (expected !== undefined || actual !== undefined) {
      parts.push(`预期 ${expected ?? "未知"}，实际 ${actual ?? "未知"}`);
    }
    if (issue.message) parts.push(String(issue.message));
    return parts.filter(Boolean).join(" · ") || JSON.stringify(issue);
  }

  function archiveIntegrityView(archive) {
    const raw = (archive && archive.integrity) || {};
    const manifest = archive && (
      archive.extractionManifest
      || raw.extractionManifest
      || (raw.manifest && raw.manifest.chatReports ? raw.manifest : null)
    );
    const reports = Array.isArray(manifest?.chatReports) ? manifest.chatReports : [];
    const incompleteFromReports = reports.filter((report) => report && report.complete === false).length;
    const completeFromReports = reports.filter((report) => report && report.complete === true).length;
    const incompleteChatCount = Number.isFinite(Number(raw.incompleteChatCount))
      ? Number(raw.incompleteChatCount)
      : Number(manifest?.incompleteHistoryChats || incompleteFromReports || 0);
    const completeChatCount = Number.isFinite(Number(raw.completeChatCount))
      ? Number(raw.completeChatCount)
      : Number(manifest?.completeHistoryChats || completeFromReports || 0);
    const parsedChatCount = Number(raw.parsedChatCount ?? archive?.stats?.chatCount ?? archive?.chats?.length ?? 0);
    const parsedMessageCount = Number(raw.parsedMessageCount ?? archive?.stats?.messageCount ?? 0);
    const expectedChatCount = Number(raw.expectedChatCount ?? manifest?.chatCount ?? 0);
    const expectedMessageCount = Number(raw.expectedMessageCount ?? manifest?.totalMessages ?? 0);
    let status = String(raw.status || "");
    if (!status) {
      if (!manifest) status = "no-manifest";
      else if (incompleteChatCount > 0) status = "incomplete";
      else if (
        (expectedChatCount && expectedChatCount !== parsedChatCount)
        || (expectedMessageCount && expectedMessageCount !== parsedMessageCount)
      ) status = "mismatch";
      else status = reports.length ? "complete" : "unverified";
    }
    return {
      manifestPresent: raw.manifestPresent ?? Boolean(manifest),
      status,
      complete: raw.complete ?? (status === "complete" ? true : status === "incomplete" || status === "mismatch" ? false : null),
      expectedMessageCount,
      parsedMessageCount,
      totalMessagesMatch: raw.totalMessagesMatch ?? (!expectedMessageCount || expectedMessageCount === parsedMessageCount),
      expectedChatCount,
      parsedChatCount,
      chatCountMatch: raw.chatCountMatch ?? (!expectedChatCount || expectedChatCount === parsedChatCount),
      reportedChatCount: Number(raw.reportedChatCount ?? reports.length),
      completeChatCount,
      incompleteChatCount,
      unknownChatCount: Number(raw.unknownChatCount || 0),
      unreportedChatCount: Number(raw.unreportedChatCount || 0),
      messageCountMismatchChatCount: Number(raw.messageCountMismatchChatCount || 0),
      missingChatCount: Number(raw.missingChatCount || 0),
      issues: Array.isArray(raw.issues) ? raw.issues.map(formatIntegrityIssue) : [],
    };
  }

  function integrityStatusLabel(status) {
    return {
      complete: "完整性清单校验通过",
      incomplete: "清单确认存在历史不完整的会话",
      mismatch: "清单与 ZIP 解析数量不一致",
      unverified: "已找到清单，但无法完成校验",
      "no-manifest": "ZIP 未包含提取完整性清单",
    }[status] || "完整性状态未知";
  }

  function archiveIntegrityToastSuffix(archive) {
    const integrity = archiveIntegrityView(archive);
    if (integrity.status === "complete") return "；完整性校验通过";
    const notices = [];
    if (integrity.incompleteChatCount > 0) notices.push(`${integrity.incompleteChatCount} 个会话历史可能不完整`);
    if (integrity.status === "mismatch") notices.push("警告：清单与解析数量不一致");
    if (notices.length) return `；${notices.join("；")}`;
    if (integrity.status === "no-manifest") return "；未包含完整性清单";
    return "；完整性尚未确认";
  }

  async function loadArchive(source, sourceName) {
    if (!Parser || !window.JSZip) {
      showToast("ZIP 解析组件未加载，请检查本地文件是否完整。");
      return;
    }

    const loadToken = ++state.archiveLoadToken;
    clearArchiveForReplacement();
    setLoading(true, "正在读取 ZIP…", "正在计算 SHA-512，所有数据都留在本机", 1);
    try {
      const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
      if (loadToken !== state.archiveLoadToken) return;
      const parsePromise = Parser.parseArchive(buffer, window.JSZip, {
        sourceName,
        onProgress(progress) {
          if (loadToken !== state.archiveLoadToken) return;
          const label = progress.stage === "zip" ? "正在读取 ZIP…" : "正在整理聊天记录…";
          setLoading(true, label, progress.message || "所有数据都留在本机", progress.percent);
        },
      });
      const [parsed, sha512] = await Promise.all([
        parsePromise,
        Parser.digestSha512(buffer, window.crypto),
      ]);
      if (loadToken !== state.archiveLoadToken) return;
      parsed.sha512 = sha512;
      parsed.sourceSize = buffer.byteLength;
      adoptArchive(parsed);
      const { chatCount, messageCount, attachmentCount } = parsed.stats;
      showToast(
        `已载入 ${chatCount} 个会话、${messageCount} 条消息、${attachmentCount} 个附件${archiveIntegrityToastSuffix(parsed)}`,
      );
    } catch (error) {
      if (loadToken !== state.archiveLoadToken) return;
      console.error(error);
      showToast(friendlyError(error));
    } finally {
      if (loadToken === state.archiveLoadToken) {
        setLoading(false);
        elements.zipInput.value = "";
      }
    }
  }

  function clearArchiveForReplacement() {
    closeMediaDialog();
    closeLibraryDialog();
    closeArchiveInfoDialog();
    closeDetailPanel();
    hideProfileView();
    hideSettingsView(false);
    stopActiveAudio();
    revokeObjectUrls();
    state.archive = null;
    state.activeChatId = "";
    state.query = "";
    state.filter = "all";
    state.chatSearchLimit = CHAT_SEARCH_PAGE_SIZE;
    state.messageWindow = { chatId: "", start: 0, end: 0 };
    state.generation += 1;
    elements.chatSearch.value = "";
    elements.chatSearch.disabled = true;
    elements.messageList.replaceChildren();
    concealFloatingDate(true);
    setNavAvailability(false);
    renderProfileButton();
    updateFilterButtons();
    renderChatList();
    showWelcome();
  }

  function setNavAvailability(available) {
    const hasUser = Boolean(available && state.archive && state.archive.currentUser);
    elements.mediaLibraryButton.setAttribute("aria-disabled", available ? "false" : "true");
    elements.profileButton.setAttribute("aria-disabled", hasUser ? "false" : "true");
    elements.archiveInfoButton.disabled = !available;
    elements.archiveInfoButton.dataset.tooltip = available
      ? "ZIP 文件信息"
      : "载入 ZIP 后查看文件信息";
    elements.mediaLibraryButton.dataset.tooltip = available
      ? "影音内容"
      : "载入 ZIP 后查看影音内容";
    elements.profileButton.dataset.tooltip = hasUser
      ? "自己"
      : available
        ? "此 ZIP 未包含当前用户信息"
        : "载入 ZIP 后查看当前用户";
  }

  function adoptArchive(archive) {
    state.archive = archive;
    state.activeChatId = "";
    state.query = "";
    state.filter = "all";
    state.chatSearchLimit = CHAT_SEARCH_PAGE_SIZE;
    state.messageWindow = { chatId: "", start: 0, end: 0 };
    elements.chatSearch.value = "";
    elements.chatSearch.disabled = false;
    setNavAvailability(true);
    renderProfileButton();
    updateFilterButtons();
    renderChatList();

    if (archive.chats.length && window.innerWidth > 824) {
      selectChat(archive.chats[0].id, false);
    } else {
      showWelcome();
    }
  }

  function getActiveChat() {
    if (!state.archive) return null;
    return state.archive.chats.find((chat) => chat.id === state.activeChatId) || null;
  }

  function filteredChats() {
    if (!state.archive) return [];
    return state.archive.chats.filter((chat) => {
      if (state.filter === "unread" && !chat.unreadCount) return false;
      if (state.filter === "favorites" && !chat.isFavorite) return false;
      if (state.filter === "groups" && !chat.isGroup) return false;
      return true;
    });
  }

  function renderChatList() {
    elements.chatList.replaceChildren();
    const chats = filteredChats();
    const fragment = document.createDocumentFragment();
    const query = state.query.trim().toLocaleLowerCase("zh-CN");
    let resultCount = 0;
    if (!query) {
      for (const chat of chats) fragment.append(createChatRow(chat));
      resultCount = chats.length;
    } else {
      const conversationMatches = chats.filter((chat) =>
        `${chat.title}\n${chat.contactName || ""}\n${chat.contactId || ""}`
          .toLocaleLowerCase("zh-CN")
          .includes(query),
      );
      const messageMatches = [];
      for (const chat of chats) {
        for (const message of chat.messages) {
          if (messageSearchText(message).toLocaleLowerCase("zh-CN").includes(query)) {
            messageMatches.push({ chat, message });
          }
        }
      }
      if (conversationMatches.length) {
        fragment.append(createSearchSectionTitle("对话"));
        for (const chat of conversationMatches) fragment.append(createChatRow(chat));
      }
      if (messageMatches.length) {
        const visibleMatches = messageMatches.slice(0, state.chatSearchLimit);
        fragment.append(createSearchSectionTitle(`消息（显示 ${visibleMatches.length}/${messageMatches.length}）`));
        for (const match of visibleMatches) fragment.append(createSearchMessageRow(match.chat, match.message));
        if (visibleMatches.length < messageMatches.length) {
          const loadMore = document.createElement("button");
          loadMore.type = "button";
          loadMore.className = "search-load-more";
          loadMore.textContent = `加载更多（还剩 ${messageMatches.length - visibleMatches.length} 条）`;
          loadMore.addEventListener("click", () => {
            const scrollParent = elements.chatList.closest(".chat-list-scroll");
            const previousScrollTop = scrollParent ? scrollParent.scrollTop : 0;
            const firstNewResultIndex = visibleMatches.length;
            state.chatSearchLimit += CHAT_SEARCH_PAGE_SIZE;
            renderChatList();
            if (scrollParent) scrollParent.scrollTop = previousScrollTop;
            const firstNewResult = elements.chatList.querySelectorAll(".search-message-row")[firstNewResultIndex];
            if (firstNewResult) firstNewResult.focus({ preventScroll: true });
          });
          fragment.append(loadMore);
        }
      }
      resultCount = conversationMatches.length + messageMatches.length;
    }
    elements.chatList.append(fragment);

    const hasArchive = Boolean(state.archive);
    elements.chatListEmpty.hidden = !hasArchive || resultCount > 0;
  }

  function createSearchSectionTitle(label) {
    const heading = document.createElement("div");
    heading.className = "search-section-title";
    heading.setAttribute("role", "presentation");
    heading.textContent = label;
    return heading;
  }

  function createSearchMessageRow(chat, message) {
    const row = createChatRow(chat, {
      preview: messageSearchText(message),
      time: formatSearchResultDate(message.timestamp),
      messageId: message.id,
    });
    row.classList.add("search-message-row");
    return row;
  }

  function messageSearchText(message) {
    if (!message) return "";
    const parts = [message.body || ""];
    if (message.type === "poll_creation") {
      parts.push((message.poll && message.poll.name) || "投票");
      for (const option of (message.poll && message.poll.options) || []) {
        parts.push(typeof option === "string" ? option : option && option.name);
      }
    } else if (message.type === "event_creation") {
      parts.push((message.event && message.event.name) || "活动");
      parts.push(message.event && message.event.description);
    }
    if (message.media && message.media.downloadName) parts.push(message.media.downloadName);
    const text = parts.filter(Boolean).join(" ").trim();
    return text || message.type || "消息";
  }

  function createChatRow(chat, options) {
    const settings = options || {};
    const row = document.createElement("button");
    row.type = "button";
    row.className = "chat-row";
    row.dataset.chatId = chat.id;
    if (settings.messageId) row.dataset.messageId = settings.messageId;
    row.setAttribute("role", "option");
    const selected = !settings.messageId && chat.id === state.activeChatId;
    row.setAttribute("aria-selected", selected ? "true" : "false");
    if (selected) row.classList.add("is-active");

    const avatar = document.createElement("div");
    avatar.className = "avatar chat-avatar";
    setAvatar(avatar, chat);

    const title = document.createElement("span");
    title.className = "chat-title";
    title.textContent = chat.title;
    const chatIntegrity = chatIntegrityView(chat, state.archive);
    if (chatIntegrity.incomplete) {
      const warning = document.createElement("span");
      warning.className = "chat-integrity-warning";
      warning.textContent = chatIntegrity.label;
      warning.title = chatIntegrity.reason || "无法确认已提取全部历史记录";
      title.append(" ", warning);
      row.classList.add("has-incomplete-history");
      row.setAttribute("aria-label", `${chat.title}，${chatIntegrity.label}`);
    }
    const time = document.createElement("span");
    time.className = "chat-time";
    time.textContent = settings.time || formatChatTime(chat.timestamp);
    if (chat.timestamp) time.title = formatTimestampTitle(chat.timestamp);
    const preview = document.createElement("span");
    preview.className = "chat-preview";
    preview.textContent = settings.preview || chat.preview || "暂无消息";

    row.append(avatar, title, time, preview);
    if (chat.unreadCount && !settings.messageId) {
      const badge = document.createElement("span");
      badge.className = "chat-badge";
      badge.textContent = chat.unreadCount > 99 ? "99+" : String(chat.unreadCount);
      row.append(badge);
    }
    row.addEventListener("click", () => selectChat(chat.id, true, settings.messageId || ""));
    return row;
  }

  function initials(title) {
    const clean = String(title || "?").trim();
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length > 1) return `${Array.from(words[0])[0] || ""}${Array.from(words[1])[0] || ""}`.toUpperCase();
    return Array.from(clean).slice(0, 2).join("").toUpperCase() || "?";
  }

  function hashHue(value) {
    let hash = 0;
    for (const character of String(value)) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
    return [173, 205, 236, 265, 318, 18, 42, 146][hash % 8];
  }

  function setAvatar(container, chat) {
    const requestToken = (avatarRequestTokens.get(container) || 0) + 1;
    avatarRequestTokens.set(container, requestToken);
    container.replaceChildren();
    container.style.setProperty("--avatar-hue", String(hashHue(chat.id || chat.title)));
    const fallback = document.createElement("span");
    fallback.textContent = initials(chat.title);
    container.append(fallback);
    if (!chat.avatarEntryName) return;

    const generation = state.generation;
    getObjectUrl(chat.avatarEntryName, "image/jpeg")
      .then((url) => {
        if (
          generation !== state.generation
          || avatarRequestTokens.get(container) !== requestToken
          || !container.isConnected
        ) return;
        const image = document.createElement("img");
        image.alt = "";
        image.decoding = "async";
        image.src = url;
        image.addEventListener("load", () => {
          if (avatarRequestTokens.get(container) === requestToken && container.isConnected) {
            container.replaceChildren(image);
          }
        }, { once: true });
      })
      .catch(() => {});
  }

  function renderProfileButton() {
    const user = state.archive && state.archive.currentUser;
    elements.profileButton.replaceChildren();
    elements.profileButton.classList.toggle("has-user", Boolean(user));
    if (!user) {
      elements.profileButton.append(icon("user"));
      return;
    }
    const profile = {
      id: user.id || "current-user",
      title: user.name || "当前用户",
      avatarEntryName: user.avatarEntryName || "",
    };
    const fallback = document.createElement("span");
    fallback.textContent = initials(profile.title === "当前用户" ? "我" : profile.title);
    elements.profileButton.style.setProperty("--avatar-hue", String(hashHue(profile.id)));
    elements.profileButton.append(fallback);
    if (profile.avatarEntryName) {
      const generation = state.generation;
      getObjectUrl(profile.avatarEntryName, "image/jpeg")
        .then((url) => {
          if (generation !== state.generation || !elements.profileButton.isConnected) return;
          const image = document.createElement("img");
          image.alt = "";
          image.src = url;
          elements.profileButton.replaceChildren(image);
        })
        .catch(() => {});
    }
  }

  function selectChat(chatId, focusConversation, targetMessageId) {
    if (!state.archive) return;
    const chat = state.archive.chats.find((item) => item.id === chatId);
    if (!chat) return;
    hideProfileView();
    hideSettingsView(false);
    closeDetailPanel();
    stopActiveAudio();
    state.activeChatId = chatId;
    document.title = `${chat.title} · ShowMesssage`;
    elements.welcomePanel.hidden = true;
    elements.conversationView.hidden = false;
    const chatIntegrity = chatIntegrityView(chat, state.archive);
    elements.conversationTitle.replaceChildren(document.createTextNode(chat.title));
    if (chatIntegrity.incomplete) {
      const warning = document.createElement("span");
      warning.className = "conversation-integrity-warning";
      warning.textContent = chatIntegrity.label;
      warning.title = chatIntegrity.reason || "无法确认已提取全部历史记录";
      elements.conversationTitle.append(" ", warning);
    }
    updateConversationSubtitle(chat);
    elements.conversationAvatar.setAttribute("aria-label", `查看 ${chat.title} 的联系人信息`);
    setAvatar(elements.conversationAvatar, chat);
    renderMessages(chat, { reset: true });
    renderChatList();
    elements.app.classList.add("show-conversation");
    elements.messageList.classList.add("is-positioning");
    requestAnimationFrame(() => {
      if (targetMessageId) {
        jumpToMessage(targetMessageId, false);
      } else {
        elements.messageList.scrollTop = elements.messageList.scrollHeight;
      }
      requestAnimationFrame(() => {
        if (targetMessageId) jumpToMessage(targetMessageId, false);
        else elements.messageList.scrollTop = elements.messageList.scrollHeight;
        elements.messageList.classList.remove("is-positioning");
        updateFloatingDate(false);
      });
      if (focusConversation && window.innerWidth <= 824) elements.backToChats.focus();
    });
  }

  function showWelcome() {
    elements.app.classList.remove("show-conversation");
    elements.conversationView.hidden = true;
    elements.welcomePanel.hidden = false;
    concealFloatingDate(true);
    document.title = "ShowMesssage · WhatsApp 聊天记录查看器";
  }

  function showChatList() {
    closeDetailPanel();
    elements.app.classList.remove("show-conversation");
    const activeRow = elements.chatList.querySelector(`[data-chat-id="${cssEscape(state.activeChatId)}"]`);
    if (activeRow) activeRow.focus();
  }

  function showProfileView() {
    if (!state.archive || !state.archive.currentUser) {
      showToast(state.archive ? "这个 ZIP 未包含当前用户信息。" : "请先载入 ZAPiXWEB ZIP。");
      return;
    }
    closeDetailPanel();
    hideSettingsView(false);
    renderProfileView();
    elements.profileView.hidden = false;
    elements.profileButton.setAttribute("aria-pressed", "true");
    if (window.innerWidth <= 824) elements.app.classList.remove("show-conversation");
  }

  function hideProfileView() {
    elements.profileView.hidden = true;
    elements.profileButton.removeAttribute("aria-pressed");
  }

  function setSettingsNavigationState(open) {
    elements.mobileSettingsButton.setAttribute("aria-pressed", open ? "true" : "false");
  }

  function availableTimeZones() {
    if (typeof Intl.supportedValuesOf !== "function") return COMMON_TIME_ZONES.slice();
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch (_error) {
      return COMMON_TIME_ZONES.slice();
    }
  }

  function timeZoneOptionLabel(timeZone, includeOffset) {
    const name = timeZoneFriendlyName(timeZone);
    const offset = includeOffset ? ` · ${DateTime.offsetLabel(timeZone, Date.now() / 1000)}` : "";
    return `${name}${offset} · ${timeZone}`;
  }

  function appendTimeZoneOptions(select) {
    const commonGroup = document.createElement("optgroup");
    commonGroup.label = "常用时区";
    const included = new Set();
    for (const timeZone of COMMON_TIME_ZONES) {
      if (!DateTime.isValidTimeZone(timeZone)) continue;
      const option = document.createElement("option");
      option.value = timeZone;
      option.textContent = timeZoneOptionLabel(timeZone, true);
      commonGroup.append(option);
      included.add(timeZone);
    }

    const allGroup = document.createElement("optgroup");
    allGroup.label = "全部时区";
    const allZones = availableTimeZones().slice().sort((left, right) => left.localeCompare(right, "zh-CN"));
    for (const timeZone of allZones) {
      if (included.has(timeZone)) continue;
      const option = document.createElement("option");
      option.value = timeZone;
      option.textContent = timeZoneOptionLabel(timeZone, false);
      allGroup.append(option);
      included.add(timeZone);
    }
    if (!included.has(state.timeZone)) {
      const option = document.createElement("option");
      option.value = state.timeZone;
      option.textContent = timeZoneOptionLabel(state.timeZone, true);
      commonGroup.append(option);
    }
    select.append(commonGroup);
    if (allGroup.childElementCount) select.append(allGroup);
  }

  function renderSettingsView() {
    elements.settingsViewContent.replaceChildren();

    const timeSection = document.createElement("section");
    timeSection.className = "settings-section";
    const timeHeading = document.createElement("h3");
    timeHeading.className = "settings-section-title";
    timeHeading.textContent = "日期与时间";
    const timeField = document.createElement("div");
    timeField.className = "settings-field";
    timeField.append(icon("clock", "icon settings-field-icon"));
    const timeLabel = document.createElement("label");
    timeLabel.className = "settings-field-label";
    timeLabel.htmlFor = "timeZoneSelect";
    const timeName = document.createElement("strong");
    timeName.textContent = "显示时区";
    timeLabel.append(timeName);
    const select = document.createElement("select");
    select.id = "timeZoneSelect";
    select.className = "settings-select";
    appendTimeZoneOptions(select);
    select.value = state.timeZone;
    select.addEventListener("change", () => {
      const changed = setTimeZone(select.value, true);
      select.value = state.timeZone;
      if (changed) showToast(`显示时区已改为 ${timeZoneContextLabel(Date.now() / 1000)}`);
    });
    timeField.append(timeLabel, select);
    timeSection.append(timeHeading, timeField);

    const appearanceSection = document.createElement("section");
    appearanceSection.className = "settings-section";
    const appearanceHeading = document.createElement("h3");
    appearanceHeading.className = "settings-section-title";
    appearanceHeading.textContent = "外观";
    const themeButton = document.createElement("button");
    themeButton.type = "button";
    themeButton.className = "settings-action-button";
    const updateThemeButton = () => {
      const currentTheme = document.documentElement.dataset.theme;
      themeButton.replaceChildren();
      themeButton.setAttribute("aria-label", currentTheme === "dark" ? "切换到浅色主题" : "切换到深色主题");
      themeButton.append(icon(currentTheme === "dark" ? "sun" : "moon"));
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = "查看器主题";
      const value = document.createElement("small");
      value.textContent = currentTheme === "dark" ? "当前为深色，点击切换到浅色" : "当前为浅色，点击切换到深色";
      copy.append(name, value);
      themeButton.append(copy, icon("chevron-right", "icon settings-action-chevron"));
    };
    updateThemeButton();
    themeButton.addEventListener("click", () => {
      setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
      updateThemeButton();
    });
    appearanceSection.append(appearanceHeading, themeButton);

    const notice = document.createElement("p");
    notice.className = "settings-notice";
    notice.append(
      icon("lock", "mini-icon"),
      document.createTextNode("这些设置仅保存在当前浏览器，不会写入 ZIP，也不会上传。"),
    );
    elements.settingsViewContent.append(timeSection, appearanceSection, notice);
  }

  function showSettingsView() {
    closeDetailPanel();
    hideProfileView();
    renderSettingsView();
    elements.settingsView.hidden = false;
    setSettingsNavigationState(true);
    if (window.innerWidth <= 824) elements.app.classList.remove("show-conversation");
    requestAnimationFrame(() => elements.settingsBackButton.focus());
  }

  function hideSettingsView(restoreFocus) {
    if (!elements.settingsView) return;
    const wasOpen = !elements.settingsView.hidden;
    elements.settingsView.hidden = true;
    setSettingsNavigationState(false);
    if (wasOpen && restoreFocus) elements.mobileSettingsButton.focus();
  }

  function formatPhoneNumber(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (!digits) return "";
    if (/^86\d{11}$/.test(digits)) {
      return `+86 ${digits.slice(2, 5)} ${digits.slice(5, 9)} ${digits.slice(9)}`;
    }
    if (/^1\d{10}$/.test(digits)) {
      return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
    }
    if (/^61\d{9}$/.test(digits)) {
      return `+61 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
    }
    if (/^64\d{8,10}$/.test(digits)) {
      const national = digits.slice(2);
      if (/^2\d{7,9}$/.test(national)) {
        const subscriber = national.slice(2);
        const split = subscriber.length > 7 ? 4 : 3;
        return `+64 ${national.slice(0, 2)} ${subscriber.slice(0, split)} ${subscriber.slice(split)}`;
      }
      return `+64 ${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5)}`;
    }
    return `+${digits.replace(/(\d{3})(?=\d)/g, "$1 ")}`;
  }

  async function copyText(value, label) {
    const text = String(value || "");
    if (!text) return;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(text);
    } catch (_error) {
      const input = document.createElement("textarea");
      input.value = text;
      input.className = "visually-hidden";
      input.setAttribute("readonly", "");
      document.body.append(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      if (!copied) {
        showToast(`无法复制${label}。`);
        return;
      }
    }
    showToast(`${label}已复制。`);
  }

  function renderProfileView() {
    const user = state.archive.currentUser || {};
    elements.profileViewContent.replaceChildren();
    const hero = document.createElement("div");
    hero.className = "profile-hero";
    const avatar = document.createElement("div");
    avatar.className = "avatar profile-avatar";
    setAvatar(avatar, {
      id: user.id || "current-user",
      title: user.name && user.name !== "当前用户" ? user.name : "我",
      avatarEntryName: user.avatarEntryName || "",
    });
    hero.append(avatar);
    elements.profileViewContent.append(hero);
    const details = document.createElement("div");
    details.className = "profile-details";
    details.append(createProfileField("姓名", user.name || "当前用户"));
    const phoneNumber = formatPhoneNumber(user.phoneNumber);
    details.append(
      createProfileField("电话号码", phoneNumber || "导出包未包含电话号码", {
        iconName: "phone",
        muted: !phoneNumber,
        actionLabel: phoneNumber ? "复制电话号码" : "",
        onAction: phoneNumber ? () => copyText(`+${user.phoneNumber}`, "电话号码") : null,
      }),
    );
    if (user.status) details.append(createProfileField("关于", user.status));
    elements.profileViewContent.append(details);
  }

  function createProfileField(label, value, options) {
    const settings = options || {};
    const field = document.createElement("div");
    field.className = "profile-field";
    const caption = document.createElement("p");
    caption.className = "profile-field-label";
    caption.textContent = label;
    const row = document.createElement("div");
    row.className = "profile-field-row";
    if (settings.iconName) row.append(icon(settings.iconName, "icon profile-field-icon"));
    const content = document.createElement("strong");
    if (settings.muted) content.className = "is-muted";
    content.textContent = String(value || "未知");
    row.append(content);
    if (settings.onAction) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "icon-button profile-field-action";
      action.setAttribute("aria-label", settings.actionLabel || `复制${label}`);
      action.title = settings.actionLabel || `复制${label}`;
      action.append(icon("copy"));
      action.addEventListener("click", settings.onAction);
      row.append(action);
    }
    field.append(caption, row);
    return field;
  }

  function createArchiveInfoField(label, value, options) {
    const settings = options || {};
    const field = document.createElement("div");
    field.className = "archive-info-field";
    const caption = document.createElement("span");
    caption.textContent = label;
    const valueRow = document.createElement("div");
    valueRow.className = "archive-info-value-row";
    const content = document.createElement(settings.monospace ? "code" : "strong");
    content.textContent = String(value || "未知");
    valueRow.append(content);
    if (settings.copyValue) {
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "icon-button archive-info-copy";
      copyButton.setAttribute("aria-label", `复制${label}`);
      copyButton.title = `复制${label}`;
      copyButton.append(icon("copy"));
      copyButton.addEventListener("click", () => copyText(settings.copyValue, label));
      valueRow.append(copyButton);
    }
    field.append(caption, valueRow);
    return field;
  }

  function createHistoryDiagnosticsSection(manifest) {
    const reports = Array.isArray(manifest?.chatReports) ? manifest.chatReports : [];
    const diagnostics = reports.map(historyDiagnosticsView).filter((item) => item.available);
    const extractorBuildId = typeof manifest?.extractorBuildId === "string"
      ? manifest.extractorBuildId.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 120)
      : "";
    if (!diagnostics.length && !extractorBuildId) return null;

    const section = document.createElement("section");
    section.className = "archive-info-section history-diagnostics-section";
    const heading = document.createElement("h3");
    heading.textContent = "历史同步诊断";
    const introduction = document.createElement("p");
    introduction.className = "history-diagnostics-introduction";
    introduction.textContent = "以下信息来自新版 Hook 的提取清单，用于判断直接加载及界面回退发生在哪一步。观察到的会话 ID、标题和原始对象不会在这里展示。";
    section.append(heading, introduction);
    if (extractorBuildId) {
      section.append(createArchiveInfoField("Hook 构建版本", extractorBuildId, { monospace: true }));
    }

    for (const diagnostic of diagnostics) {
      const details = document.createElement("details");
      details.className = "history-diagnostic-report";
      details.open = diagnostic.complete === false;
      const summary = document.createElement("summary");
      const title = document.createElement("span");
      title.textContent = diagnostic.title;
      const status = document.createElement("small");
      status.textContent = diagnostic.complete === true
        ? "历史完整"
        : diagnostic.complete === false
          ? "需要检查"
          : "完整性未确认";
      summary.append(title, status);
      const body = document.createElement("div");
      body.className = "history-diagnostic-body";
      for (const field of diagnostic.fields) {
        body.append(createArchiveInfoField(field.label, field.value, { monospace: field.monospace }));
      }
      if (diagnostic.openDiagnostics.length) {
        const openHeading = document.createElement("h4");
        openHeading.textContent = "界面打开诊断";
        const openList = document.createElement("ol");
        openList.className = "history-open-diagnostics";
        for (const line of diagnostic.openDiagnostics) {
          const item = document.createElement("li");
          item.textContent = line;
          openList.append(item);
        }
        body.append(openHeading, openList);
      } else {
        body.append(createArchiveInfoField("界面打开诊断", "未执行或未记录（直接加载成功时无需打开界面）"));
      }
      details.append(summary, body);
      section.append(details);
    }
    return section;
  }

  function renderArchiveInfoDialog() {
    const archive = state.archive;
    if (!archive) return;
    elements.archiveInfoDialogContent.replaceChildren();
    const integrity = archiveIntegrityView(archive);
    const metadata = document.createElement("section");
    metadata.className = "archive-info-section";
    metadata.append(
      createArchiveInfoField("来源 ZIP", archive.sourceName),
      createArchiveInfoField("文件大小", formatBytes(archive.sourceSize) || "未知"),
      createArchiveInfoField("SHA-512", archive.sha512, {
        monospace: true,
        copyValue: archive.sha512,
      }),
    );
    const user = archive.currentUser || {};
    if (user.id || user.type || user.phoneId) {
      const account = document.createElement("section");
      account.className = "archive-info-section";
      const heading = document.createElement("h3");
      heading.textContent = "导出账户元数据";
      account.append(heading);
      if (user.id) account.append(createArchiveInfoField("WhatsApp ID", user.id, { monospace: true }));
      if (user.type) account.append(createArchiveInfoField("账号类型", user.type));
      if (user.phoneId) account.append(createArchiveInfoField("设备号码标识", user.phoneId, { monospace: true }));
      metadata.append(account);
    }

    const integritySection = document.createElement("section");
    integritySection.className = `archive-info-section archive-integrity is-${integrity.status}`;
    const integrityHeading = document.createElement("h3");
    integrityHeading.textContent = "提取完整性";
    const integritySummary = document.createElement("p");
    integritySummary.className = "archive-integrity-summary";
    integritySummary.append(icon(integrity.complete ? "check" : "alert", "mini-icon"));
    integritySummary.append(document.createTextNode(integrityStatusLabel(integrity.status)));
    integritySection.append(integrityHeading, integritySummary);
    integritySection.append(
      createArchiveInfoField("清单状态", integrity.manifestPresent ? "已读取 extraction_manifest.json" : "未提供"),
      createArchiveInfoField(
        "会话数量",
        integrity.expectedChatCount
          ? `${integrity.parsedChatCount}（清单 ${integrity.expectedChatCount}）`
          : String(integrity.parsedChatCount),
      ),
      createArchiveInfoField(
        "消息数量",
        integrity.expectedMessageCount
          ? `${integrity.parsedMessageCount}（清单 ${integrity.expectedMessageCount}）`
          : String(integrity.parsedMessageCount),
      ),
    );
    if (integrity.manifestPresent) {
      integritySection.append(
        createArchiveInfoField("确认完整的会话", String(integrity.completeChatCount)),
        createArchiveInfoField("历史可能不完整", String(integrity.incompleteChatCount)),
      );
      if (integrity.unreportedChatCount || integrity.unknownChatCount) {
        integritySection.append(
          createArchiveInfoField(
            "未报告 / 无法确认",
            `${integrity.unreportedChatCount} / ${integrity.unknownChatCount}`,
          ),
        );
      }
      if (integrity.messageCountMismatchChatCount || integrity.missingChatCount) {
        integritySection.append(
          createArchiveInfoField(
            "数量不符 / 缺失会话",
            `${integrity.messageCountMismatchChatCount} / ${integrity.missingChatCount}`,
          ),
        );
      }
    }
    if (integrity.issues.length) {
      const issueList = document.createElement("ul");
      issueList.className = "archive-integrity-issues";
      for (const issue of integrity.issues) {
        const item = document.createElement("li");
        item.textContent = issue;
        issueList.append(item);
      }
      integritySection.append(issueList);
    }

    const diagnosticsSection = createHistoryDiagnosticsSection(archive.extractionManifest);
    const notice = document.createElement("p");
    notice.className = "archive-info-notice";
    notice.append(icon("info", "mini-icon"), document.createTextNode("这些内容用于说明本地提取包，不属于 WhatsApp 原始网页信息。"));
    elements.archiveInfoDialogContent.append(metadata, integritySection);
    if (diagnosticsSection) elements.archiveInfoDialogContent.append(diagnosticsSection);
    elements.archiveInfoDialogContent.append(notice);
  }

  function openArchiveInfoDialog() {
    if (!state.archive) {
      showToast("请先载入 ZAPiXWEB ZIP。");
      return;
    }
    renderArchiveInfoDialog();
    if (!elements.archiveInfoDialog.open) elements.archiveInfoDialog.showModal();
  }

  function closeArchiveInfoDialog() {
    if (!elements.archiveInfoDialog) return;
    if (elements.archiveInfoDialog.open) elements.archiveInfoDialog.close();
    elements.archiveInfoDialogContent.replaceChildren();
  }

  function jumpToMessage(messageId, smooth) {
    let row = elements.messageList.querySelector(`[data-message-id="${cssEscape(messageId)}"]`);
    if (!row) {
      const chat = getActiveChat();
      const targetIndex = chat ? chat.messages.findIndex((message) => message.id === messageId) : -1;
      if (chat && targetIndex >= 0) {
        let start = Math.max(0, targetIndex - MESSAGE_WINDOW_CONTEXT);
        let end = Math.min(chat.messages.length, targetIndex + MESSAGE_WINDOW_CONTEXT + 1);
        if (end - start < MESSAGE_WINDOW_SIZE) {
          start = Math.max(0, Math.min(start, chat.messages.length - MESSAGE_WINDOW_SIZE));
          end = Math.min(chat.messages.length, start + MESSAGE_WINDOW_SIZE);
        }
        state.messageWindow = { chatId: chat.id, start, end };
        renderMessages(chat, { preserveWindow: true });
        row = elements.messageList.querySelector(`[data-message-id="${cssEscape(messageId)}"]`);
      }
    }
    if (!row) return false;
    window.clearTimeout(state.highlightTimer);
    row.scrollIntoView({
      block: "center",
      behavior: smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto",
    });
    row.classList.remove("is-highlighted");
    requestAnimationFrame(() => row.classList.add("is-highlighted"));
    state.highlightTimer = window.setTimeout(() => row.classList.remove("is-highlighted"), 1900);
    scheduleFloatingDateUpdate(true);
    return true;
  }

  function clearFloatingDateTimers() {
    window.clearTimeout(state.floatingDateHideTimer);
    window.clearTimeout(state.floatingDateCleanupTimer);
    state.floatingDateHideTimer = 0;
    state.floatingDateCleanupTimer = 0;
  }

  function concealFloatingDate(immediate) {
    clearFloatingDateTimers();
    elements.floatingDate.classList.remove("is-visible");
    if (immediate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      elements.floatingDate.hidden = true;
      return;
    }
    state.floatingDateCleanupTimer = window.setTimeout(() => {
      if (!elements.floatingDate.classList.contains("is-visible")) {
        elements.floatingDate.hidden = true;
      }
      state.floatingDateCleanupTimer = 0;
    }, FLOATING_DATE_FADE_CLEANUP_DELAY);
  }

  function revealFloatingDate() {
    clearFloatingDateTimers();
    elements.floatingDate.hidden = false;
    elements.floatingDate.classList.add("is-visible");
    state.floatingDateHideTimer = window.setTimeout(() => {
      state.floatingDateHideTimer = 0;
      elements.floatingDate.classList.remove("is-visible");
      const cleanupDelay = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? 0
        : FLOATING_DATE_FADE_CLEANUP_DELAY;
      state.floatingDateCleanupTimer = window.setTimeout(() => {
        if (!elements.floatingDate.classList.contains("is-visible")) {
          elements.floatingDate.hidden = true;
        }
        state.floatingDateCleanupTimer = 0;
      }, cleanupDelay);
    }, FLOATING_DATE_HIDE_DELAY);
  }

  function scheduleFloatingDateUpdate(reveal) {
    state.floatingDateRevealPending ||= Boolean(reveal);
    if (state.floatingDateFrame) return;
    state.floatingDateFrame = requestAnimationFrame(() => {
      state.floatingDateFrame = 0;
      const shouldReveal = state.floatingDateRevealPending;
      state.floatingDateRevealPending = false;
      if (elements.messageList.classList.contains("is-positioning")) {
        concealFloatingDate(true);
        return;
      }
      updateFloatingDate(shouldReveal);
    });
  }

  function updateFloatingDate(reveal) {
    const chat = getActiveChat();
    if (!chat || elements.conversationView.hidden || !chat.messages.length) {
      concealFloatingDate(true);
      return;
    }
    const dividers = elements.messageList.querySelectorAll(".date-divider[data-timestamp]");
    if (!dividers.length) {
      concealFloatingDate(true);
      return;
    }
    const listRect = elements.messageList.getBoundingClientRect();
    const dateAnchor = listRect.top + FLOATING_DATE_ANCHOR_OFFSET;
    const collisionBottom = listRect.top + FLOATING_DATE_COLLISION_OFFSET;
    let current = dividers[0];
    let inlineDividerNearTop = false;
    for (const divider of dividers) {
      const dividerRect = divider.getBoundingClientRect();
      if (dividerRect.top <= dateAnchor) current = divider;
      const labelRect = (divider.firstElementChild || divider).getBoundingClientRect();
      if (labelRect.bottom > listRect.top && labelRect.top < collisionBottom) {
        inlineDividerNearTop = true;
      }
      if (dividerRect.top > collisionBottom) break;
    }
    elements.floatingDate.textContent = formatDateDividerLabel(Number(current.dataset.timestamp || 0));
    if (inlineDividerNearTop) {
      concealFloatingDate(true);
      return;
    }
    if (reveal) revealFloatingDate();
  }

  function openDetailPanel(mode) {
    if (!getActiveChat()) return;
    const wasHidden = elements.detailPanel.hidden;
    if (wasHidden && document.activeElement instanceof HTMLElement) {
      state.detailReturnFocus = document.activeElement;
    }
    state.detailMode = mode;
    if (mode === "media") state.detailMediaTab = "media";
    elements.detailPanel.hidden = false;
    elements.detailPanel.dataset.mode = mode;
    if (mode === "search") renderConversationSearchPanel();
    else if (mode === "media") renderChatMediaPanel();
    else renderContactPanel();
    if (mode === "media") {
      const selected = elements.detailPanelContent.querySelector('.detail-media-tab[aria-selected="true"]');
      if (selected) selected.focus({ preventScroll: true });
    } else elements.detailPanelClose.focus({ preventScroll: true });
    syncDetailPanelModality();
  }

  function closeDetailPanel() {
    if (state.closeDatePicker) state.closeDatePicker();
    const returnFocus = state.detailReturnFocus;
    state.detailReturnFocus = null;
    state.detailMode = "";
    elements.detailPanel.hidden = true;
    elements.detailPanel.removeAttribute("data-mode");
    syncDetailPanelModality();
    cleanupLazyMedia(elements.detailPanelContent);
    elements.detailPanelContent.replaceChildren();
    requestAnimationFrame(() => {
      const fallback = elements.conversationAvatar;
      const target = returnFocus && returnFocus.isConnected && !returnFocus.disabled ? returnFocus : fallback;
      if (target && target.isConnected && !target.disabled) target.focus({ preventScroll: true });
    });
  }

  function syncDetailPanelModality() {
    const overlay = !elements.detailPanel.hidden && window.matchMedia("(max-width: 1135px)").matches;
    elements.conversationView.inert = overlay;
    if (overlay) elements.conversationView.setAttribute("aria-hidden", "true");
    else elements.conversationView.removeAttribute("aria-hidden");
  }

  function renderConversationSearchPanel() {
    const chat = getActiveChat();
    if (!chat) return;
    elements.detailPanelTitle.textContent = "搜索消息";
    cleanupLazyMedia(elements.detailPanelContent);
    elements.detailPanelContent.replaceChildren();

    const tools = document.createElement("div");
    tools.className = "detail-search-tools";
    const datePickerWrap = document.createElement("div");
    datePickerWrap.className = "detail-date-picker-wrap";
    const dateButton = document.createElement("button");
    dateButton.type = "button";
    dateButton.className = "detail-date-picker";
    dateButton.title = `跳转到日期（${timeZoneOffsetLabel(Date.now() / 1000)}）`;
    dateButton.setAttribute("aria-label", `跳转到日期，当前时区 ${timeZoneContextLabel(Date.now() / 1000)}`);
    dateButton.setAttribute("aria-haspopup", "dialog");
    dateButton.setAttribute("aria-expanded", "false");
    dateButton.setAttribute("aria-controls", "conversationDatePicker");
    dateButton.append(icon("calendar"));
    const datePopover = document.createElement("div");
    datePopover.id = "conversationDatePicker";
    datePopover.className = "date-picker-popover";
    datePopover.setAttribute("role", "dialog");
    datePopover.setAttribute("aria-label", `选择日期，当前时区 ${timeZoneContextLabel(Date.now() / 1000)}`);
    datePopover.hidden = true;
    datePickerWrap.append(dateButton, datePopover);

    const searchLabel = document.createElement("label");
    searchLabel.className = "detail-search-box";
    searchLabel.append(icon("search"));
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.placeholder = "搜索消息";
    searchInput.autocomplete = "off";
    searchLabel.append(searchInput);
    tools.append(datePickerWrap, searchLabel);

    const results = document.createElement("div");
    results.className = "detail-results";
    const empty = document.createElement("p");
    empty.className = "detail-empty";
    empty.textContent = "输入文字搜索此对话，或用日历跳转到指定日期。";
    results.append(empty);
    elements.detailPanelContent.append(tools, results);

    let visibleResultLimit = DETAIL_SEARCH_PAGE_SIZE;
    let previousQuery = "";
    const renderResults = () => {
      const query = searchInput.value.trim().toLocaleLowerCase("zh-CN");
      if (query !== previousQuery) {
        visibleResultLimit = DETAIL_SEARCH_PAGE_SIZE;
        previousQuery = query;
      }
      results.replaceChildren();
      if (!query) {
        const prompt = document.createElement("p");
        prompt.className = "detail-empty";
        prompt.textContent = "输入文字搜索此对话，或用日历跳转到指定日期。";
        results.append(prompt);
        return;
      }
      const matches = chat.messages
        .filter((message) => messageSearchText(message).toLocaleLowerCase("zh-CN").includes(query))
        .slice()
        .reverse();
      if (!matches.length) {
        const noResults = document.createElement("p");
        noResults.className = "detail-empty";
        noResults.textContent = "未找到消息";
        results.append(noResults);
        return;
      }
      const visibleMatches = matches.slice(0, visibleResultLimit);
      const summary = document.createElement("p");
      summary.className = "detail-search-summary";
      summary.setAttribute("role", "status");
      summary.textContent = `找到 ${matches.length} 条，当前显示 ${visibleMatches.length} 条`;
      results.append(summary);
      for (const message of visibleMatches) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "detail-result";
        const date = document.createElement("strong");
        date.textContent = formatSearchResultDate(message.timestamp);
        const time = document.createElement("time");
        time.dateTime = new Date(message.timestamp * 1000).toISOString();
        time.textContent = formatTime(message.timestamp);
        time.title = formatTimestampTitle(message.timestamp);
        const snippet = document.createElement("span");
        snippet.textContent = messageSearchText(message) || "消息";
        button.append(date, time, snippet);
        button.addEventListener("click", () => jumpToMessage(message.id, true));
        results.append(button);
      }
      if (visibleMatches.length < matches.length) {
        const loadMore = document.createElement("button");
        loadMore.type = "button";
        loadMore.className = "search-load-more detail-load-more";
        loadMore.textContent = `加载更多（还剩 ${matches.length - visibleMatches.length} 条）`;
        loadMore.addEventListener("click", () => {
          const firstNewResultIndex = visibleMatches.length;
          visibleResultLimit += DETAIL_SEARCH_PAGE_SIZE;
          renderResults();
          const firstNewResult = results.querySelectorAll(".detail-result")[firstNewResultIndex];
          if (firstNewResult) firstNewResult.focus({ preventScroll: true });
        });
        results.append(loadMore);
      }
    };

    searchInput.addEventListener("input", renderResults);
    const datedMessages = chat.messages
      .filter((message) => message.timestamp > 0)
      .slice()
      .sort((left, right) => left.timestamp - right.timestamp || left.rowId - right.rowId);
    const messagesByDate = new Map();
    for (const message of datedMessages) {
      const key = dateInputValue(message.timestamp);
      if (!messagesByDate.has(key)) messagesByDate.set(key, []);
      messagesByDate.get(key).push(message);
    }
    const todayKey = dateInputValue(Date.now() / 1000);
    const today = DateTime.calendarDateFromKey(todayKey);
    const firstMessageKey = datedMessages.length ? dateInputValue(datedMessages[0].timestamp) : todayKey;
    const firstMessageDate = DateTime.calendarDateFromKey(firstMessageKey) || today;
    const earliestMonth = new Date(Date.UTC(firstMessageDate.getUTCFullYear(), firstMessageDate.getUTCMonth(), 1));
    const currentMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    let visibleMonth = new Date(currentMonth.getTime());
    let selectedDateKey = todayKey;
    const dateGroups = Array.from(messagesByDate.entries()).map(([key, messages]) => {
      const date = DateTime.calendarDateFromKey(key);
      return { key, messages, time: date.getTime() };
    });
    const nearestMessageForDate = (date) => {
      const exactMessages = messagesByDate.get(DateTime.calendarDateKey(date));
      if (exactMessages?.length) return exactMessages[0];
      let nearest = null;
      for (const group of dateGroups) {
        const distance = Math.abs(group.time - date.getTime());
        if (
          !nearest
          || distance < nearest.distance
          || (distance === nearest.distance && group.time < nearest.time)
        ) {
          nearest = { ...group, distance };
        }
      }
      return nearest?.messages[0] || null;
    };
    dateButton.disabled = !datedMessages.length;
    if (!datedMessages.length) {
      dateButton.title = "此对话没有可跳转的日期";
      dateButton.setAttribute("aria-label", "此对话没有可跳转的日期");
    }
    const closeDatePicker = () => {
      datePopover.hidden = true;
      dateButton.setAttribute("aria-expanded", "false");
      if (state.closeDatePicker === closeDatePicker) state.closeDatePicker = null;
    };

    const renderDatePicker = (focusNavigation) => {
      datePopover.replaceChildren();
      const header = document.createElement("div");
      header.className = "date-picker-header";
      const titleGroup = document.createElement("div");
      titleGroup.className = "date-picker-title";
      const title = document.createElement("h3");
      title.textContent = `${visibleMonth.getUTCFullYear()}年${visibleMonth.getUTCMonth() + 1}月`;
      const zone = document.createElement("small");
      zone.textContent = `显示时区 ${timeZoneContextLabel(Date.now() / 1000)}`;
      titleGroup.append(title, zone);
      const navigation = document.createElement("div");
      navigation.className = "date-picker-navigation";
      const previous = document.createElement("button");
      previous.type = "button";
      previous.className = "date-picker-nav-button";
      previous.setAttribute("aria-label", "上个月");
      previous.disabled = visibleMonth.getTime() <= earliestMonth.getTime();
      previous.append(icon("chevron-left"));
      const next = document.createElement("button");
      next.type = "button";
      next.className = "date-picker-nav-button";
      next.setAttribute("aria-label", "下个月");
      next.disabled = visibleMonth.getTime() >= currentMonth.getTime();
      next.append(icon("chevron-right"));
      navigation.append(previous, next);
      header.append(titleGroup, navigation);

      const grid = document.createElement("div");
      grid.className = "date-picker-grid";
      grid.setAttribute("role", "grid");
      grid.setAttribute("aria-label", "选择日期");
      const weekdays = document.createElement("div");
      weekdays.className = "date-picker-weekdays";
      weekdays.setAttribute("role", "row");
      for (const weekday of ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]) {
        const label = document.createElement("span");
        label.setAttribute("role", "columnheader");
        label.textContent = weekday;
        weekdays.append(label);
      }
      grid.append(weekdays);

      const year = visibleMonth.getUTCFullYear();
      const month = visibleMonth.getUTCMonth();
      const firstDay = new Date(Date.UTC(year, month, 1));
      const mondayOffset = (firstDay.getUTCDay() + 6) % 7;
      const lastDay = new Date(Date.UTC(year, month + 1, 0));
      const totalCells = Math.ceil((mondayOffset + lastDay.getUTCDate()) / 7) * 7;
      const gridStart = new Date(Date.UTC(year, month, 1 - mondayOffset));
      for (let cell = 0; cell < totalCells; cell += 7) {
        const week = document.createElement("div");
        week.className = "date-picker-week";
        week.setAttribute("role", "row");
        for (let weekday = 0; weekday < 7; weekday += 1) {
          const date = new Date(gridStart.getTime());
          date.setUTCDate(gridStart.getUTCDate() + cell + weekday);
          const key = DateTime.calendarDateKey(date);
          const dayMessages = messagesByDate.get(key) || [];
          const isCurrentMonth = date.getUTCMonth() === month;
          const hasMessages = dayMessages.length > 0;
          const isFuture = date.getTime() > today.getTime();
          const dayDescription = isFuture
            ? "未来日期不可选择"
            : hasMessages
              ? `${dayMessages.length} 条消息`
              : "将跳转到最近消息";
          const day = document.createElement("button");
          day.type = "button";
          day.className = "date-picker-day";
          day.setAttribute("role", "gridcell");
          day.setAttribute(
            "aria-label",
            `${accessibleDateFormatter.format(date)}，${dayDescription}`,
          );
          day.setAttribute(
            "aria-selected",
            !isFuture && key === selectedDateKey ? "true" : "false",
          );
          day.textContent = String(date.getUTCDate());
          day.disabled = isFuture;
          day.dataset.messageCount = String(dayMessages.length);
          if (!isCurrentMonth) day.classList.add("is-outside-month");
          if (!isFuture && key === selectedDateKey) day.classList.add("is-selected");
          if (!isFuture) {
            day.addEventListener("click", () => {
              const targetMessage = nearestMessageForDate(date);
              if (!targetMessage) return;
              selectedDateKey = key;
              closeDetailPanel();
              jumpToMessage(targetMessage.id, true);
            });
          }
          week.append(day);
        }
        grid.append(week);
      }
      previous.addEventListener("click", () => {
        visibleMonth = new Date(Date.UTC(visibleMonth.getUTCFullYear(), visibleMonth.getUTCMonth() - 1, 1));
        renderDatePicker("previous");
      });
      next.addEventListener("click", () => {
        visibleMonth = new Date(Date.UTC(visibleMonth.getUTCFullYear(), visibleMonth.getUTCMonth() + 1, 1));
        renderDatePicker("next");
      });
      datePopover.append(header, grid);
      if (focusNavigation) {
        requestAnimationFrame(() => {
          const preferred = focusNavigation === "previous" ? previous : next;
          const fallback = focusNavigation === "previous" ? next : previous;
          (preferred.disabled ? fallback : preferred).focus();
        });
      }
    };

    dateButton.addEventListener("click", () => {
      if (!datePopover.hidden) {
        closeDatePicker();
        return;
      }
      if (state.closeDatePicker && state.closeDatePicker !== closeDatePicker) state.closeDatePicker();
      renderDatePicker();
      datePopover.hidden = false;
      dateButton.setAttribute("aria-expanded", "true");
      state.closeDatePicker = closeDatePicker;
      requestAnimationFrame(() => {
        const selected = datePopover.querySelector('.date-picker-day[aria-selected="true"]');
        const firstAvailable = datePopover.querySelector(".date-picker-day:not(:disabled)");
        if (selected) selected.focus();
        else if (firstAvailable) firstAvailable.focus();
      });
    });
    requestAnimationFrame(() => searchInput.focus());
  }

  function renderContactPanel() {
    const chat = getActiveChat();
    if (!chat) return;
    elements.detailPanelTitle.textContent = chat.isGroup ? "群组信息" : "联系人信息";
    cleanupLazyMedia(elements.detailPanelContent);
    elements.detailPanelContent.replaceChildren();

    const hero = document.createElement("section");
    hero.className = "contact-hero";
    const avatar = document.createElement("div");
    avatar.className = "avatar contact-avatar";
    setAvatar(avatar, chat);
    const title = document.createElement("h3");
    title.textContent = chat.title;
    const identifier = document.createElement("p");
    identifier.className = "contact-identifier";
    const displayPhoneNumber = chat.isGroup ? "" : formatPhoneNumber(chat.phoneNumber);
    identifier.textContent = chat.isGroup
      ? chat.id
      : displayPhoneNumber || "手机号未包含在导出包";
    if (!chat.isGroup && !displayPhoneNumber) identifier.classList.add("is-unavailable");
    hero.append(avatar, title, identifier);

    const actions = document.createElement("div");
    actions.className = "contact-actions";
    actions.append(
      createContactAction("phone", "语音", true),
      createContactAction("video-call", "视频", true),
      createContactAction("search", "搜索", false, () => openDetailPanel("search")),
    );
    hero.append(actions);
    elements.detailPanelContent.append(hero);

    const allItems = collectLibraryItems(chat.id);
    const mediaItems = allItems.media;
    const mediaSection = document.createElement("section");
    mediaSection.className = "detail-section";
    const mediaButton = document.createElement("button");
    mediaButton.type = "button";
    mediaButton.className = "detail-section-button";
    mediaButton.append(icon("image"));
    const mediaLabel = document.createElement("strong");
    mediaLabel.textContent = "影音内容、链接和文档";
    const mediaCount = document.createElement("span");
    mediaCount.textContent = String(allItems.media.length + allItems.documents.length + allItems.links.length);
    mediaButton.append(mediaLabel, mediaCount);
    mediaButton.addEventListener("click", () => openDetailPanel("media"));
    mediaSection.append(mediaButton);
    if (mediaItems.length) {
      const preview = document.createElement("div");
      preview.className = "contact-media-preview";
      for (const item of mediaItems.slice(0, 3)) preview.append(createContactMediaTile(item, mediaItems));
      mediaSection.append(preview);
    }
    elements.detailPanelContent.append(mediaSection);

    const aboutSection = document.createElement("section");
    aboutSection.className = "detail-section";
    const aboutLabel = document.createElement("p");
    aboutLabel.className = "detail-section-label";
    aboutLabel.textContent = "简介";
    const about = document.createElement("p");
    about.className = "detail-about";
    about.textContent = chat.contactStatus || "导出包未包含个人简介";
    aboutSection.append(aboutLabel, about);

    const identitySection = document.createElement("section");
    identitySection.className = "detail-section contact-identity-section";
    const identityLabel = document.createElement("p");
    identityLabel.className = "detail-section-label";
    identityLabel.textContent = chat.isGroup ? "群组标识" : "号码与标识";
    identitySection.append(identityLabel);
    if (!chat.isGroup) {
      identitySection.append(
        createContactIdentityRow(
          "phone",
          "手机号",
          displayPhoneNumber || "当前导出包未包含可还原的手机号",
          chat.phoneNumber ? `+${String(chat.phoneNumber).replace(/\D/g, "")}` : "",
          !displayPhoneNumber,
        ),
      );
    }
    identitySection.append(
      createContactIdentityRow(
        "info",
        "WhatsApp 内部标识",
        chat.contactId || chat.id,
        chat.contactId || chat.id,
      ),
    );

    const securitySection = document.createElement("section");
    securitySection.className = "detail-section";
    const security = document.createElement("div");
    security.className = "detail-static-row";
    security.append(icon("lock"));
    const securityCopy = document.createElement("div");
    const securityTitle = document.createElement("strong");
    securityTitle.textContent = "本地只读记录";
    const securityText = document.createElement("span");
    securityText.textContent = "内容来自所选 ZIP，不会连接 WhatsApp。";
    securityCopy.append(securityTitle, securityText);
    security.append(securityCopy);
    securitySection.append(security);
    elements.detailPanelContent.append(aboutSection, identitySection, securitySection);
  }

  function createContactIdentityRow(iconName, label, value, copyValue, muted) {
    const row = document.createElement("div");
    row.className = "detail-static-row contact-identity-row";
    row.append(icon(iconName));
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = label;
    const detail = document.createElement("span");
    detail.textContent = value;
    if (muted) detail.classList.add("is-unavailable");
    content.append(title, detail);
    row.append(content);
    if (copyValue) {
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "icon-button contact-identity-copy";
      copyButton.setAttribute("aria-label", `复制${label}`);
      copyButton.title = `复制${label}`;
      copyButton.append(icon("copy"));
      copyButton.addEventListener("click", () => copyText(copyValue, label));
      row.append(copyButton);
    }
    return row;
  }

  function createContactAction(iconName, label, disabled, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "contact-action";
    if (disabled) {
      button.setAttribute("aria-disabled", "true");
      button.dataset.offline = "";
      button.title = `${label} · 离线 ZIP 不支持`;
    }
    const circle = document.createElement("span");
    circle.className = "action-circle";
    circle.append(icon(iconName));
    const text = document.createElement("span");
    text.textContent = label;
    button.append(circle, text);
    if (handler) button.addEventListener("click", handler);
    return button;
  }

  function createContactMediaTile(item, sequence) {
    const tile = createLibraryMediaTile(item, sequence);
    tile.classList.remove("library-media-tile");
    tile.classList.add("contact-media-tile");
    return tile;
  }

  function libraryTabDefinitions() {
    return [
      { id: "media", label: "影音内容" },
      { id: "documents", label: "文档" },
      { id: "links", label: "链接" },
    ];
  }

  function renderChatMediaPanel() {
    const chat = getActiveChat();
    if (!chat) return;
    const items = collectLibraryItems(chat.id);
    const definitions = libraryTabDefinitions();
    if (!definitions.some((definition) => definition.id === state.detailMediaTab)) {
      state.detailMediaTab = "media";
    }
    elements.detailPanelTitle.textContent = "影音内容、链接和文档";
    cleanupLazyMedia(elements.detailPanelContent);
    elements.detailPanelContent.replaceChildren();

    const panel = document.createElement("section");
    panel.className = "chat-media-panel";
    const tabs = document.createElement("div");
    tabs.className = "detail-media-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", `${chat.title} 的附件类型`);
    const content = document.createElement("div");
    content.id = "detailMediaPanelContent";
    content.className = "detail-media-content";
    content.setAttribute("role", "tabpanel");

    const tabButtons = [];
    const renderSelected = (focusSelected) => {
      const selectedDefinition = definitions.find((definition) => definition.id === state.detailMediaTab);
      for (const button of tabButtons) {
        const selected = button.dataset.detailMediaTab === state.detailMediaTab;
        button.classList.toggle("is-active", selected);
        button.setAttribute("aria-selected", selected ? "true" : "false");
        button.tabIndex = selected ? 0 : -1;
      }
      content.setAttribute("aria-labelledby", `detailMediaTab-${state.detailMediaTab}`);
      cleanupLazyMedia(content);
      content.replaceChildren();
      renderLibraryCategory(content, items, state.detailMediaTab);
      if (focusSelected) {
        requestAnimationFrame(() => {
          const selected = tabButtons.find((button) => button.dataset.detailMediaTab === state.detailMediaTab);
          if (selected) selected.focus();
        });
      }
      if (selectedDefinition) content.dataset.category = selectedDefinition.id;
    };

    definitions.forEach((definition, index) => {
      const button = document.createElement("button");
      button.id = `detailMediaTab-${definition.id}`;
      button.type = "button";
      button.className = "detail-media-tab";
      button.dataset.detailMediaTab = definition.id;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", content.id);
      const count = (items[definition.id] || []).length;
      button.textContent = `${definition.label} ${count}`;
      button.addEventListener("click", () => {
        state.detailMediaTab = definition.id;
        renderSelected(false);
      });
      button.addEventListener("keydown", (event) => {
        let nextIndex = -1;
        if (event.key === "ArrowLeft") nextIndex = (index + definitions.length - 1) % definitions.length;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % definitions.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = definitions.length - 1;
        if (nextIndex < 0) return;
        event.preventDefault();
        state.detailMediaTab = definitions[nextIndex].id;
        renderSelected(true);
      });
      tabButtons.push(button);
      tabs.append(button);
    });

    const allChatsButton = document.createElement("button");
    allChatsButton.type = "button";
    allChatsButton.className = "detail-media-all-button";
    allChatsButton.append(
      icon("image"),
      document.createTextNode("查看所有聊天的影音内容、链接和文档"),
      icon("chevron-right", "icon detail-media-all-chevron"),
    );
    allChatsButton.addEventListener("click", () => openLibraryDialog(""));
    panel.append(tabs, content, allChatsButton);
    elements.detailPanelContent.append(panel);
    renderSelected(false);
  }

  function collectLibraryItems(chatId) {
    const result = { media: [], documents: [], links: [] };
    if (!state.archive) return result;
    const chats = chatId ? state.archive.chats.filter((chat) => chat.id === chatId) : state.archive.chats;
    for (const chat of chats) {
      for (const message of chat.messages) {
        if (["image", "video", "sticker"].includes(message.type) && message.media && !message.media.missing) {
          result.media.push({ chat, message });
        }
        if (["document", "vcard"].includes(message.type) && message.media && !message.media.missing) {
          result.documents.push({ chat, message });
        }
        for (const url of extractSafeLinks(messageSearchText(message))) {
          result.links.push({ chat, message, url });
        }
      }
    }
    const byNewest = (left, right) => right.message.timestamp - left.message.timestamp;
    result.media.sort(byNewest);
    result.documents.sort(byNewest);
    result.links.sort(byNewest);
    return result;
  }

  function collectMediaTimeline(chatId) {
    return collectLibraryItems(chatId).media.slice().sort((left, right) => (
      left.message.timestamp - right.message.timestamp
      || left.message.rowId - right.message.rowId
    ));
  }

  function extractSafeLinks(text) {
    const links = [];
    const expression = /https?:\/\/[^\s<>"']+/gi;
    for (const match of String(text || "").matchAll(expression)) {
      const candidate = splitUrlAndSuffix(match[0]).clean;
      try {
        const url = new URL(candidate);
        if (url.protocol === "http:" || url.protocol === "https:") links.push(url.href);
      } catch (_error) {
        // Ignore malformed URLs from exported message text.
      }
    }
    return links;
  }

  function openLibraryDialog(chatId) {
    if (!state.archive) {
      showToast("请先载入 ZAPiXWEB ZIP。");
      return;
    }
    state.libraryChatId = chatId || "";
    state.libraryTab = "media";
    renderLibraryDialog();
    if (!elements.libraryDialog.open) elements.libraryDialog.showModal();
  }

  function closeLibraryDialog() {
    if (!elements.libraryDialog) return;
    state.libraryChatId = "";
    if (elements.libraryDialog.open) elements.libraryDialog.close();
    cleanupLazyMedia(elements.libraryDialogContent);
    elements.libraryDialogContent.replaceChildren();
  }

  function renderLibraryDialog() {
    const chat = state.libraryChatId && state.archive
      ? state.archive.chats.find((item) => item.id === state.libraryChatId)
      : null;
    const items = collectLibraryItems(state.libraryChatId);
    elements.libraryDialogTitle.textContent = chat ? "影音内容、链接和文档" : "所有聊天的影音内容、链接和文档";
    elements.libraryDialogSubtitle.textContent = chat ? chat.title : "按当前分类查看全部已提取内容";
    for (const tab of elements.libraryTabs.querySelectorAll("[data-library-tab]")) {
      const selected = tab.dataset.libraryTab === state.libraryTab;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
      if (selected) elements.libraryDialogContent.setAttribute("aria-labelledby", tab.id);
    }
    cleanupLazyMedia(elements.libraryDialogContent);
    elements.libraryDialogContent.replaceChildren();
    renderLibraryCategory(elements.libraryDialogContent, items, state.libraryTab);
  }

  function renderLibraryCategory(container, items, tab) {
    const selectedItems = items[tab] || [];
    if (!selectedItems.length) {
      const empty = document.createElement("p");
      empty.className = "detail-empty library-empty";
      empty.textContent = {
        media: "没有可用的图片或视频",
        documents: "没有可用的文档",
        links: "没有找到链接",
      }[tab];
      container.append(empty);
      return;
    }
    if (tab === "media") {
      const grid = document.createElement("div");
      grid.className = "library-grid";
      for (const item of selectedItems) grid.append(createLibraryMediaTile(item, selectedItems));
      container.append(grid);
      return;
    }
    if (tab === "documents") {
      const list = document.createElement("div");
      list.className = "library-document-list";
      for (const item of selectedItems) list.append(createLibraryDocumentItem(item));
      container.append(list);
      return;
    }
    const list = document.createElement("div");
    list.className = "library-link-list";
    for (const item of selectedItems) list.append(createLibraryLink(item));
    container.append(list);
  }

  function createLibraryDocumentItem(item) {
    const wrapper = document.createElement("div");
    wrapper.className = "library-document-item";
    wrapper.append(createDocumentCard(item.message));
    const meta = document.createElement("p");
    meta.className = "library-item-meta";
    meta.textContent = `${item.chat.title} · ${formatDateLabel(item.message.timestamp)}`;
    wrapper.append(meta);
    return wrapper;
  }

  function createLibraryLink(item) {
    const anchor = document.createElement("a");
    anchor.className = "library-link";
    anchor.href = item.url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer nofollow";
    anchor.append(icon("link"));
    const copy = document.createElement("span");
    copy.className = "library-link-copy";
    const value = document.createElement("strong");
    value.textContent = item.url;
    const meta = document.createElement("small");
    meta.textContent = `${item.chat.title} · ${formatDateLabel(item.message.timestamp)}`;
    copy.append(value, meta);
    anchor.append(copy);
    return anchor;
  }

  function createLibraryMediaTile(item, sequence) {
    const { message, chat } = item;
    const previewOnly = message.type === "video" && isPreviewOnlyVideo(message.media);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "library-media-tile";
    button.setAttribute(
      "aria-label",
      `${previewOnly ? "视频仅有缩略图，原视频缺失" : message.type === "video" ? "播放视频" : "预览图片"} · ${chat.title} · ${formatDateLabel(message.timestamp)}`,
    );
    button.title = `${chat.title} · ${formatSearchResultDate(message.timestamp)} ${formatTime(message.timestamp)}`;
    const media = message.media;
    button.append(createMediaPlaceholder(message.type === "video" ? "play" : "image"));
    hydrateMediaPreview(button, message, message.type === "sticker");
    if (message.type === "video" && !previewOnly) {
      const play = document.createElement("span");
      play.className = "play-overlay";
      play.append(icon("play"));
      button.append(play);
    }
    if (previewOnly) {
      button.classList.add("is-preview-only");
      button.disabled = true;
      const warning = document.createElement("span");
      warning.className = "preview-only-warning";
      warning.textContent = "原视频缺失";
      button.append(warning);
    } else {
      button.addEventListener("click", () => openMediaDialog(message, sequence));
    }
    return button;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function updateFilterButtons() {
    for (const button of elements.filterRow.querySelectorAll("[data-filter]")) {
      const selected = button.dataset.filter === state.filter;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
    }
  }

  function createMessageWindowControl(chat, direction, hiddenCount) {
    const wrapper = document.createElement("div");
    wrapper.className = `message-window-control is-${direction}`;
    const button = document.createElement("button");
    button.type = "button";
    const batchCount = Math.min(MESSAGE_WINDOW_SIZE, hiddenCount);
    button.textContent = direction === "earlier"
      ? `加载更早的 ${batchCount} 条消息（上方还有 ${hiddenCount} 条）`
      : `加载后续 ${batchCount} 条消息（下方还有 ${hiddenCount} 条）`;
    button.addEventListener("click", () => loadMessageWindow(chat, direction));
    wrapper.append(button);
    return wrapper;
  }

  function loadMessageWindow(chat, direction) {
    if (!chat || state.messageWindow.chatId !== chat.id) return;
    const anchor = captureMessageScrollAnchor();
    const previousHeight = elements.messageList.scrollHeight;
    const previousTop = elements.messageList.scrollTop;
    if (direction === "earlier") {
      state.messageWindow.start = Math.max(0, state.messageWindow.start - MESSAGE_WINDOW_SIZE);
      if (state.messageWindow.end - state.messageWindow.start > MESSAGE_WINDOW_MAX) {
        state.messageWindow.end = state.messageWindow.start + MESSAGE_WINDOW_MAX;
      }
    } else {
      state.messageWindow.end = Math.min(chat.messages.length, state.messageWindow.end + MESSAGE_WINDOW_SIZE);
      if (state.messageWindow.end - state.messageWindow.start > MESSAGE_WINDOW_MAX) {
        state.messageWindow.start = state.messageWindow.end - MESSAGE_WINDOW_MAX;
      }
    }
    elements.messageList.classList.add("is-positioning");
    renderMessages(chat, { preserveWindow: true });
    requestAnimationFrame(() => {
      const anchorRow = anchor
        ? elements.messageList.querySelector(`[data-message-id="${cssEscape(anchor.id)}"]`)
        : null;
      if (anchor && anchorRow) {
        const listBounds = elements.messageList.getBoundingClientRect();
        elements.messageList.scrollTop += anchorRow.getBoundingClientRect().top - listBounds.top - anchor.offset;
      } else if (direction === "earlier") {
        elements.messageList.scrollTop = previousTop + elements.messageList.scrollHeight - previousHeight;
      } else {
        elements.messageList.scrollTop = previousTop;
      }
      elements.messageList.classList.remove("is-positioning");
      updateFloatingDate(false);
    });
  }

  function renderMessages(chat, options) {
    const settings = options || {};
    concealFloatingDate(true);
    cleanupLazyMedia(elements.messageList);
    elements.messageList.replaceChildren();
    const messageCount = chat.messages.length;
    if (
      settings.reset
      || state.messageWindow.chatId !== chat.id
      || state.messageWindow.start < 0
      || state.messageWindow.end > messageCount
      || state.messageWindow.start >= state.messageWindow.end
    ) {
      state.messageWindow = {
        chatId: chat.id,
        start: Math.max(0, messageCount - MESSAGE_WINDOW_SIZE),
        end: messageCount,
      };
    } else if (!settings.preserveWindow) {
      state.messageWindow = {
        chatId: chat.id,
        start: Math.max(0, messageCount - MESSAGE_WINDOW_SIZE),
        end: messageCount,
      };
    }
    const { start, end } = state.messageWindow;
    const fragment = document.createDocumentFragment();
    if (start > 0) fragment.append(createMessageWindowControl(chat, "earlier", start));
    let previous = null;
    let previousDate = "";
    for (let index = start; index < end; index += 1) {
      const message = chat.messages[index];
      const dateKey = localDateKey(message.timestamp);
      if (dateKey !== previousDate) {
        fragment.append(createDateDivider(message.timestamp));
        previousDate = dateKey;
        previous = null;
      }
      const groupStart =
        !previous ||
        previous.fromMe !== message.fromMe ||
        previous.from !== message.from ||
        Math.abs(message.timestamp - previous.timestamp) > 300;
      fragment.append(createMessage(message, chat, groupStart));
      previous = message;
    }
    if (end < messageCount) {
      fragment.append(createMessageWindowControl(chat, "later", messageCount - end));
    }
    elements.messageList.append(fragment);
    updateFloatingDate(false);
  }

  function createDateDivider(timestamp) {
    const wrapper = document.createElement("div");
    wrapper.className = "date-divider";
    wrapper.dataset.timestamp = String(timestamp || 0);
    wrapper.dataset.dateKey = localDateKey(timestamp);
    wrapper.title = `日期按 ${timeZoneContextLabel(timestamp)} 显示`;
    const label = document.createElement("span");
    label.textContent = formatDateDividerLabel(timestamp);
    wrapper.append(label);
    return wrapper;
  }

  function createMessage(message, chat, groupStart) {
    const row = document.createElement("div");
    row.className = `message-row ${message.fromMe ? "outgoing" : "incoming"}${groupStart ? " group-start" : ""}`;
    row.dataset.messageId = message.id;
    row.dataset.timestamp = String(message.timestamp || 0);
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    if (["image", "video"].includes(message.type) && !message.body) {
      bubble.classList.add("is-media-only");
    }

    if (chat.isGroup && !message.fromMe && groupStart && message.senderName) {
      const sender = document.createElement("p");
      sender.className = "sender-name";
      sender.textContent = message.senderName;
      bubble.append(sender);
    }
    if (message.forwarded) {
      const forwarded = document.createElement("p");
      forwarded.className = "forwarded-label";
      forwarded.append(icon("forward", "mini-icon"), document.createTextNode("已转发"));
      bubble.append(forwarded);
    }

    appendMessageContent(bubble, message);
    bubble.append(createMessageMeta(message));
    row.append(bubble);
    return row;
  }

  function appendMessageContent(bubble, message) {
    switch (message.type) {
      case "chat":
        bubble.append(createTextBlock(message.body || ""));
        break;
      case "image":
      case "sticker":
        bubble.append(createImageCard(message));
        appendCaption(bubble, message.body);
        break;
      case "video":
        bubble.append(createVideoCard(message));
        appendCaption(bubble, message.body);
        break;
      case "ptt":
      case "audio":
        bubble.append(createAudioPlayer(message));
        appendCaption(bubble, message.body);
        break;
      case "document":
      case "vcard":
        bubble.append(createDocumentCard(message));
        appendCaption(bubble, message.body);
        break;
      case "poll_creation":
        bubble.append(createPollCard(message));
        break;
      case "event_creation":
        bubble.append(createEventCard(message));
        break;
      case "revoked":
        bubble.append(createTextBlock("此消息已被删除"));
        break;
      default:
        bubble.append(createUnknownCard(message));
        break;
    }
  }

  function createTextBlock(text) {
    const paragraph = document.createElement("p");
    paragraph.className = "message-text";
    appendSafeText(paragraph, String(text || ""));
    return paragraph;
  }

  function appendCaption(container, text) {
    if (!text) return;
    const caption = document.createElement("p");
    caption.className = "media-caption message-text";
    appendSafeText(caption, text);
    container.append(caption);
  }

  function splitUrlAndSuffix(rawValue) {
    const raw = String(rawValue || "");
    let end = raw.length;
    const pairs = { ")": "(", "]": "[", "}": "{" };
    while (end > 0) {
      const character = raw[end - 1];
      if (pairs[character]) {
        const candidate = raw.slice(0, end);
        const openerCount = candidate.split(pairs[character]).length - 1;
        const closerCount = candidate.split(character).length - 1;
        if (closerCount > openerCount) {
          end -= 1;
          continue;
        }
        break;
      }
      if (/[.,!?，。！？；;:：]/u.test(character)) {
        end -= 1;
        continue;
      }
      break;
    }
    return { clean: raw.slice(0, end), suffix: raw.slice(end) };
  }

  function appendSafeText(container, text) {
    const expression = /https?:\/\/[^\s<>"']+/gi;
    let cursor = 0;
    for (const match of text.matchAll(expression)) {
      const index = Number(match.index || 0);
      if (index > cursor) appendTextWithBreaks(container, text.slice(cursor, index));
      const raw = match[0];
      const { clean, suffix } = splitUrlAndSuffix(raw);
      let valid = false;
      try {
        const url = new URL(clean);
        valid = url.protocol === "http:" || url.protocol === "https:";
      } catch (_error) {
        valid = false;
      }
      if (valid) {
        const anchor = document.createElement("a");
        anchor.href = clean;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer nofollow";
        anchor.textContent = clean;
        container.append(anchor);
      } else {
        appendTextWithBreaks(container, clean);
      }
      if (suffix) container.append(document.createTextNode(suffix));
      cursor = index + raw.length;
    }
    if (cursor < text.length) appendTextWithBreaks(container, text.slice(cursor));
  }

  function appendTextWithBreaks(container, text) {
    const lines = String(text).split("\n");
    lines.forEach((line, index) => {
      if (index) container.append(document.createElement("br"));
      if (line) container.append(document.createTextNode(line));
    });
  }

  function createImageCard(message) {
    const media = message.media;
    if (!media || media.missing) return createMissingMedia(message.type === "sticker" ? "贴纸不可用" : "图片附件缺失");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `media-card${message.type === "sticker" ? " is-sticker" : ""}`;
    button.setAttribute("aria-label", message.type === "sticker" ? "预览贴纸" : "预览图片");
    const placeholder = createMediaPlaceholder("image");
    button.append(placeholder);
    hydrateMediaPreview(button, message, message.type === "sticker");
    button.addEventListener("click", () => {
      const chat = findMessageChat(message);
      openMediaDialog(message, collectMediaTimeline(chat && chat.id));
    });
    return button;
  }

  function createVideoCard(message) {
    const media = message.media;
    if (!media || (media.missing && !media.previewAvailable)) return createMissingMedia("视频附件缺失");
    if (isPreviewOnlyVideo(media)) {
      const preview = document.createElement("div");
      preview.className = "media-card preview-only-video";
      preview.setAttribute("role", "img");
      preview.setAttribute("aria-label", "仅保存了视频缩略图，原视频缺失");
      preview.append(createMediaPlaceholder("image"));
      hydrateMediaPreview(preview, message, false);
      const warning = document.createElement("span");
      warning.className = "preview-only-warning";
      warning.append(icon("alert", "mini-icon"), document.createTextNode("仅有缩略图 · 原视频缺失"));
      preview.append(warning);
      return preview;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "media-card";
    button.setAttribute("aria-label", "播放视频");
    button.append(createMediaPlaceholder("image"));
    hydrateMediaPreview(button, message, false);
    const play = document.createElement("span");
    play.className = "play-overlay";
    play.append(icon("play"));
    button.append(play);
    if (media.duration) button.append(createVideoDurationBadge(media.duration));
    button.addEventListener("click", () => {
      const chat = findMessageChat(message);
      openMediaDialog(message, collectMediaTimeline(chat && chat.id));
    });
    return button;
  }

  function createVideoDurationBadge(duration) {
    const badge = document.createElement("span");
    badge.className = "video-duration-badge";
    badge.textContent = formatDuration(duration);
    return badge;
  }

  function isPreviewOnlyVideo(media) {
    if (!media) return false;
    if (media.previewOnly === true) return true;
    return media.originalMissing === true
      && media.previewAvailable === true
      && Boolean(media.previewEntryName);
  }

  function createMediaPlaceholder(iconName) {
    const placeholder = document.createElement("span");
    placeholder.className = "media-placeholder";
    placeholder.append(icon(iconName));
    return placeholder;
  }

  function observeWhenVisible(element, callback) {
    let finished = false;
    const run = () => {
      if (finished) return;
      finished = true;
      callback();
    };
    if (!("IntersectionObserver" in window)) {
      run();
      return;
    }
    if (!lazyMediaObserver) {
      lazyMediaObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (lazyMediaObserver) lazyMediaObserver.unobserve(entry.target);
          entry.target.removeAttribute("data-lazy-media-pending");
          const activate = entry.target.__showMessageActivate;
          delete entry.target.__showMessageActivate;
          if (activate) activate();
        }
      }, { rootMargin: "320px 0px" });
    }
    element.__showMessageActivate = run;
    element.dataset.lazyMediaPending = "true";
    requestAnimationFrame(() => {
      if (!finished && element.isConnected && lazyMediaObserver) lazyMediaObserver.observe(element);
    });
  }

  function cleanupLazyMedia(root) {
    if (!root) return;
    if (lazyMediaObserver) {
      for (const element of root.querySelectorAll("[data-lazy-media-pending]")) {
        lazyMediaObserver.unobserve(element);
        delete element.__showMessageActivate;
        element.removeAttribute("data-lazy-media-pending");
      }
    }
    releaseTransientMediaInRoot(root);
  }

  function mediaPreviewSource(message) {
    const media = message && message.media;
    if (!media) return null;
    if (media.previewEntryName) {
      return { entryName: media.previewEntryName, mime: media.previewMime || "image/jpeg", dataUrl: "" };
    }
    if (media.previewDataUrl) {
      return { entryName: "", mime: media.previewMime || "image/jpeg", dataUrl: media.previewDataUrl };
    }
    if (message.type !== "video" && media.entryName) {
      return { entryName: media.entryName, mime: media.mime, dataUrl: "" };
    }
    return null;
  }

  function shouldUseVideoFrameFallback(message) {
    const media = message && message.media;
    const size = Number((media && media.size) || 0);
    return Boolean(
      message
      && message.type === "video"
      && media
      && media.entryName
      && !media.missing
      && !isPreviewOnlyVideo(media)
      && size > 0
      && size <= MAX_VIDEO_FRAME_SOURCE_BYTES
    );
  }

  function hydrateMediaPreview(container, message, contain) {
    const source = mediaPreviewSource(message);
    if (!source) {
      if (shouldUseVideoFrameFallback(message)) {
        hydrateVideoFrame(container, message);
        return true;
      }
      const placeholder = container.querySelector(".media-placeholder");
      if (placeholder) {
        const mediaSize = Number((message.media && message.media.size) || 0);
        placeholder.title = mediaSize > MAX_VIDEO_FRAME_SOURCE_BYTES
          ? "视频较大，点击后可直接播放"
          : "导出包未包含可生成的缩略图";
      }
      return false;
    }
    hydrateImage(container, source, contain);
    return true;
  }

  function hydrateVideoFrame(container, message) {
    const media = message.media;
    const requestToken = String((Number(container.dataset.mediaRequestToken) || 0) + 1);
    container.dataset.mediaRequestToken = requestToken;
    observeWhenVisible(container, () => {
      const generation = state.generation;
      getVideoFramePreview(media, { container, requestToken })
        .then((dataUrl) => {
          if (
            generation !== state.generation
            || container.dataset.mediaRequestToken !== requestToken
            || !container.isConnected
          ) return;
          installMediaImage(container, dataUrl, false, requestToken);
        })
        .catch(() => markMediaPreviewFailed(container, requestToken));
    });
  }

  function hasActiveVideoFrameConsumer(key) {
    const consumers = state.videoFramePreviewConsumers.get(key);
    if (!consumers) return false;
    for (const consumer of Array.from(consumers)) {
      if (
        !consumer.container.isConnected
        || consumer.container.dataset.mediaRequestToken !== consumer.requestToken
      ) consumers.delete(consumer);
    }
    if (!consumers.size) state.videoFramePreviewConsumers.delete(key);
    return consumers.size > 0;
  }

  function getVideoFramePreview(media, consumer) {
    const key = `${state.generation}\u0000${media.entryName}`;
    if (state.videoFramePreviews.has(key)) {
      return Promise.resolve(state.videoFramePreviews.get(key));
    }
    if (!state.videoFramePreviewConsumers.has(key)) {
      state.videoFramePreviewConsumers.set(key, new Set());
    }
    state.videoFramePreviewConsumers.get(key).add(consumer);
    if (state.videoFramePreviewPromises.has(key)) return state.videoFramePreviewPromises.get(key);
    const archive = state.archive;
    const generation = state.generation;
    const task = videoFrameQueue
      .catch(() => undefined)
      .then(() => {
        if (!hasActiveVideoFrameConsumer(key)) throw new Error("缩略图已离开可见区域");
        return generateVideoFramePreview(archive, generation, media);
      })
      .then((dataUrl) => {
        if (generation !== state.generation || archive !== state.archive) {
          throw new Error("聊天记录已切换");
        }
        state.videoFramePreviews.set(key, dataUrl);
        return dataUrl;
      });
    videoFrameQueue = task.catch(() => undefined);
    state.videoFramePreviewPromises.set(key, task);
    task.finally(() => {
      if (state.videoFramePreviewPromises.get(key) === task) {
        state.videoFramePreviewPromises.delete(key);
      }
      state.videoFramePreviewConsumers.delete(key);
    }).catch(() => undefined);
    return task;
  }

  async function generateVideoFramePreview(archive, generation, media) {
    const size = Number(media.size || 0);
    if (!archive || !media.entryName || size <= 0 || size > MAX_VIDEO_FRAME_SOURCE_BYTES) {
      throw new Error("视频不适合自动生成缩略图");
    }
    const blob = await Parser.readEntryAsBlob(archive, media.entryName, media.mime);
    if (generation !== state.generation || archive !== state.archive) {
      throw new Error("聊天记录已切换");
    }
    const url = URL.createObjectURL(blob);
    try {
      return await captureVideoFrame(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function captureVideoFrame(url) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.playsInline = true;
      let settled = false;
      const timeout = window.setTimeout(() => finish(new Error("生成视频缩略图超时")), 15000);
      const releaseVideo = () => {
        video.pause();
        video.removeAttribute("src");
        video.load();
      };
      const finish = (error, dataUrl) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        releaseVideo();
        if (error) reject(error);
        else resolve(dataUrl);
      };
      const capture = () => {
        try {
          const sourceWidth = Number(video.videoWidth || 0);
          const sourceHeight = Number(video.videoHeight || 0);
          if (!sourceWidth || !sourceHeight) throw new Error("视频没有可解码的画面");
          const scale = Math.min(
            1,
            MAX_VIDEO_FRAME_WIDTH / sourceWidth,
            MAX_VIDEO_FRAME_HEIGHT / sourceHeight,
          );
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(sourceWidth * scale));
          canvas.height = Math.max(1, Math.round(sourceHeight * scale));
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("浏览器无法生成视频缩略图");
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.76);
          if (!/^data:image\/jpeg;base64,/i.test(dataUrl)) {
            throw new Error("视频缩略图编码失败");
          }
          finish(null, dataUrl);
        } catch (error) {
          finish(error);
        }
      };
      video.addEventListener("loadeddata", capture, { once: true });
      video.addEventListener("error", () => finish(new Error("视频首帧解码失败")), { once: true });
      video.src = url;
      video.load();
    });
  }

  function markMediaPreviewFailed(container, requestToken) {
    if (container.dataset.mediaRequestToken !== requestToken || !container.isConnected) return;
    const placeholder = container.querySelector(".media-placeholder");
    if (!placeholder) return;
    placeholder.classList.add("is-error");
    placeholder.title = "无法解码该缩略图";
    placeholder.replaceChildren(icon("alert"));
  }

  function installMediaImage(container, url, contain, requestToken, releaseSource) {
    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    image.loading = "eager";
    if (contain) image.style.objectFit = "contain";
    let settled = false;
    let released = false;
    const release = () => {
      if (released || !releaseSource) return;
      released = true;
      releaseSource();
    };
    const showImage = () => {
      if (settled) return;
      settled = true;
      if (container.dataset.mediaRequestToken === requestToken && container.isConnected) {
        const placeholder = container.querySelector(".media-placeholder");
        if (placeholder) placeholder.replaceWith(image);
        else container.prepend(image);
      }
      release();
    };
    const showError = () => {
      if (settled) return;
      settled = true;
      markMediaPreviewFailed(container, requestToken);
      release();
    };
    image.addEventListener("load", showImage, { once: true });
    image.addEventListener("error", showError, { once: true });
    image.src = url;
    if (image.complete) queueMicrotask(() => (image.naturalWidth ? showImage() : showError()));
  }

  function hydrateImage(container, source, contain) {
    const requestToken = String((Number(container.dataset.mediaRequestToken) || 0) + 1);
    container.dataset.mediaRequestToken = requestToken;
    observeWhenVisible(container, () => {
      const generation = state.generation;
      const transient = !source.dataUrl;
      const sourcePromise = source.dataUrl
        ? Promise.resolve(source.dataUrl)
        : createTransientObjectUrl(source.entryName, source.mime);
      sourcePromise
        .then((url) => {
          if (
            generation !== state.generation
            || container.dataset.mediaRequestToken !== requestToken
            || !container.isConnected
          ) {
            if (transient) revokeTransientObjectUrl(url);
            return;
          }
          installMediaImage(
            container,
            url,
            contain,
            requestToken,
            transient ? () => revokeTransientObjectUrl(url) : null,
          );
        })
        .catch(() => markMediaPreviewFailed(container, requestToken));
    });
  }

  function createMissingMedia(label) {
    const card = document.createElement("div");
    card.className = "missing-media";
    card.append(icon("alert"));
    const info = document.createElement("div");
    info.className = "document-info";
    const strong = document.createElement("strong");
    strong.textContent = label;
    const small = document.createElement("span");
    small.textContent = "原导出包中没有找到对应附件";
    info.append(strong, small);
    card.append(info);
    return card;
  }

  function createDocumentCard(message) {
    const media = message.media;
    if (!media || media.missing) return createMissingMedia("文件附件缺失");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "document-card";
    button.setAttribute("aria-label", `下载 ${media.downloadName}`);
    const fileIcon = document.createElement("span");
    fileIcon.className = "document-icon";
    fileIcon.append(icon("file"));
    const info = document.createElement("span");
    info.className = "document-info";
    const name = document.createElement("strong");
    name.textContent = media.downloadName;
    const details = document.createElement("span");
    details.textContent = [fileTypeLabel(media.mime), formatBytes(media.size)].filter(Boolean).join(" · ");
    info.append(name, details);
    const downloadIcon = icon("download", "icon document-download");
    button.append(fileIcon, info, downloadIcon);
    button.addEventListener("click", () => downloadMedia(media));
    return button;
  }

  function createAudioPlayer(message) {
    const media = message.media;
    if (!media || media.missing) return createMissingMedia("语音附件缺失");
    const wrapper = document.createElement("div");
    wrapper.className = "audio-player";
    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "audio-play-button";
    playButton.setAttribute("aria-label", "载入并播放语音");
    playButton.append(icon("play"));
    const track = document.createElement("div");
    track.className = "audio-track-wrap";
    const range = document.createElement("input");
    range.className = "audio-range";
    range.type = "range";
    range.min = "0";
    range.max = String(Math.max(1, media.duration || 1));
    range.step = "0.05";
    range.value = "0";
    range.disabled = true;
    range.setAttribute("aria-label", "语音播放进度");
    const time = document.createElement("span");
    time.className = "audio-time";
    time.textContent = formatDuration(media.duration || 0);
    track.append(range, time);
    const voice = document.createElement("span");
    voice.className = "voice-avatar";
    voice.append(icon("mic"));
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    wrapper.append(playButton, track, voice, audio);

    let readyPromise = null;
    const releaseReadyAudio = () => {
      if (state.activeAudio === audio) state.activeAudio = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (wrapper.__showMessageObjectUrl) {
        revokeTransientObjectUrl(wrapper.__showMessageObjectUrl);
        wrapper.__showMessageObjectUrl = "";
      }
      readyPromise = null;
      range.disabled = true;
      range.value = "0";
      time.textContent = formatDuration(media.duration || 0);
    };
    wrapper.__showMessageReleaseAudio = releaseReadyAudio;
    const ensureReady = () => {
      if (!readyPromise) {
        const generation = state.generation;
        readyPromise = createTransientObjectUrl(media.entryName, media.mime).then((url) => {
          if (generation !== state.generation || !wrapper.isConnected) {
            revokeTransientObjectUrl(url);
            throw new Error("语音所在的消息已离开当前视图");
          }
          wrapper.__showMessageObjectUrl = url;
          audio.src = url;
          return audio;
        });
      }
      return readyPromise;
    };
    const prepareAudio = () => ensureReady()
      .then(() => {
        if (!wrapper.isConnected) return;
        range.disabled = false;
        playButton.setAttribute("aria-label", "播放语音");
        return audio;
      })
      .catch((error) => {
        console.error(error);
        playButton.setAttribute("aria-label", "语音不可用");
        throw error;
      });
    playButton.addEventListener("click", async () => {
      const playRequestToken = ++state.audioPlayRequestToken;
      if (audio.src && !audio.paused) {
        audio.pause();
        return;
      }
      if (!audio.src) {
        playButton.setAttribute("aria-label", "正在载入语音");
        playButton.disabled = true;
        try {
          await prepareAudio();
        } catch (_error) {
          if (playRequestToken === state.audioPlayRequestToken) showToast("无法读取这条语音。");
          return;
        } finally {
          playButton.disabled = false;
        }
        if (playRequestToken !== state.audioPlayRequestToken) {
          releaseReadyAudio();
          return;
        }
      }
      if (playRequestToken !== state.audioPlayRequestToken) return;
      if (audio.paused) {
        if (state.activeAudio && state.activeAudio !== audio) {
          const previousWrapper = state.activeAudio.closest(".audio-player");
          if (previousWrapper && typeof previousWrapper.__showMessageReleaseAudio === "function") {
            previousWrapper.__showMessageReleaseAudio();
          } else state.activeAudio.pause();
        }
        state.activeAudio = audio;
        const playback = audio.play();
        if (playback && typeof playback.catch === "function") {
          playback.catch((error) => {
            if (
              (error && error.name === "AbortError")
              || playRequestToken !== state.audioPlayRequestToken
              || state.activeAudio !== audio
            ) return;
            console.error(error);
            releaseReadyAudio();
            showToast("无法播放这条语音。");
          });
        }
      } else {
        audio.pause();
      }
    });
    range.addEventListener("input", () => {
      if (audio.src) audio.currentTime = Number(range.value);
    });
    audio.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(audio.duration)) range.max = String(audio.duration);
      time.textContent = formatDuration(Number.isFinite(audio.duration) ? audio.duration : media.duration);
    });
    audio.addEventListener("timeupdate", () => {
      range.value = String(audio.currentTime || 0);
      const duration = Number.isFinite(audio.duration) ? audio.duration : media.duration;
      time.textContent = `${formatDuration(audio.currentTime)} / ${formatDuration(duration)}`;
    });
    audio.addEventListener("play", () => {
      playButton.replaceChildren(icon("pause"));
      playButton.setAttribute("aria-label", "暂停语音");
    });
    const setPaused = () => {
      playButton.replaceChildren(icon("play"));
      playButton.setAttribute("aria-label", "播放语音");
    };
    audio.addEventListener("pause", setPaused);
    audio.addEventListener("ended", () => {
      setPaused();
      releaseReadyAudio();
    });
    return wrapper;
  }

  function createPollCard(message) {
    const card = document.createElement("div");
    card.className = "poll-card";
    const title = document.createElement("p");
    title.className = "poll-title";
    title.textContent = (message.poll && message.poll.name) || "投票";
    card.append(title);
    const options = (message.poll && message.poll.options) || [];
    if (!options.length) {
      const option = document.createElement("div");
      option.className = "poll-option";
      option.textContent = "投票选项未包含在导出数据中";
      card.append(option);
    } else {
      for (const item of options) {
        const option = document.createElement("div");
        option.className = "poll-option";
        const circle = document.createElement("span");
        circle.className = "poll-circle";
        option.append(circle, document.createTextNode(item.name));
        card.append(option);
      }
    }
    return card;
  }

  function createEventCard(message) {
    const event = message.event || {};
    const card = document.createElement("div");
    card.className = "event-card";
    const visual = document.createElement("span");
    visual.className = "event-icon";
    visual.append(icon("calendar"));
    const content = document.createElement("div");
    const title = document.createElement("p");
    title.className = "event-title";
    title.textContent = event.name || "活动";
    content.append(title);
    if (event.startTime) {
      const time = document.createElement("p");
      time.textContent = `${dateFormatter.format(new Date(event.startTime * 1000))} ${formatTime(event.startTime)}`;
      time.title = formatTimestampTitle(event.startTime);
      content.append(time);
    }
    if (event.description) {
      const description = document.createElement("p");
      description.textContent = event.description;
      content.append(description);
    }
    if (event.canceled) {
      const canceled = document.createElement("p");
      canceled.className = "event-canceled";
      canceled.textContent = "活动已取消";
      content.append(canceled);
    }
    card.append(visual, content);
    return card;
  }

  function createUnknownCard(message) {
    const card = document.createElement("div");
    card.className = "unknown-card";
    const type = document.createElement("strong");
    type.textContent = `暂不支持：${message.type || "unknown"}`;
    const body = document.createElement("p");
    body.textContent = message.body || "这类消息无法在当前版本中预览。";
    card.append(type, body);
    return card;
  }

  function createMessageMeta(message) {
    const meta = document.createElement("span");
    meta.className = "message-meta";
    const time = document.createElement("time");
    if (message.timestamp) time.dateTime = new Date(message.timestamp * 1000).toISOString();
    time.textContent = formatTime(message.timestamp);
    time.title = formatTimestampTitle(message.timestamp);
    time.setAttribute("aria-label", formatTimestampTitle(message.timestamp));
    meta.append(time);
    if (message.fromMe) {
      const ackName = message.ack >= 2 ? "check-double" : "check";
      const ack = icon(ackName, `ack-icon${message.ack >= 3 ? " is-read" : ""}`);
      meta.append(ack);
    }
    return meta;
  }

  function mediaDialogItemKey(item) {
    const message = item && item.message;
    const chat = item && item.chat;
    if (!message) return "";
    return `${(chat && chat.id) || message.chatId || ""}\u0000${message.key || message.id || message.rowId || ""}`;
  }

  function canOpenMediaItem(item) {
    const message = item && item.message;
    const media = message && message.media;
    if (!message || !media || media.missing) return false;
    if (message.type === "video") return Boolean(media.entryName) && !isPreviewOnlyVideo(media);
    return Boolean(media.entryName || media.previewEntryName || media.previewDataUrl);
  }

  function normalizeMediaDialogItems(items) {
    const result = [];
    const seen = new Set();
    for (const item of Array.isArray(items) ? items : []) {
      if (!canOpenMediaItem(item)) continue;
      const key = mediaDialogItemKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  }

  function mediaNavigationState(index, total) {
    const count = Math.max(0, Number(total || 0));
    const current = Number(index);
    return {
      hasMultiple: count > 1,
      canPrevious: count > 1 && current > 0,
      canNext: count > 1 && current >= 0 && current < count - 1,
    };
  }

  async function createTransientObjectUrl(entryName, mime) {
    if (!state.archive || !entryName) throw new Error("附件不存在");
    const archive = state.archive;
    const generation = state.generation;
    const blob = await Parser.readEntryAsBlob(archive, entryName, mime);
    if (generation !== state.generation || archive !== state.archive) {
      throw new Error("聊天记录已切换");
    }
    const url = URL.createObjectURL(blob);
    state.transientUrls.add(url);
    return url;
  }

  function revokeTransientObjectUrl(url) {
    if (!url) return;
    URL.revokeObjectURL(url);
    state.transientUrls.delete(url);
  }

  function releaseTransientMediaInRoot(root) {
    for (const wrapper of root.querySelectorAll(".audio-player")) {
      if (typeof wrapper.__showMessageReleaseAudio === "function") {
        wrapper.__showMessageReleaseAudio();
        continue;
      }
      const audio = wrapper.querySelector("audio");
      if (audio) {
        if (state.activeAudio === audio) state.activeAudio = null;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      if (wrapper.__showMessageObjectUrl) {
        revokeTransientObjectUrl(wrapper.__showMessageObjectUrl);
        wrapper.__showMessageObjectUrl = "";
      }
    }
  }

  async function mediaDialogSource(message) {
    const media = message && message.media;
    if (!media) throw new Error("附件不存在");
    if (message.type === "video" || media.entryName) {
      return { url: await createTransientObjectUrl(media.entryName, media.mime), transient: true };
    }
    if (media.previewEntryName) {
      return {
        url: await createTransientObjectUrl(media.previewEntryName, media.previewMime || "image/jpeg"),
        transient: true,
      };
    }
    if (media.previewDataUrl) return { url: media.previewDataUrl, transient: false };
    throw new Error("附件不存在");
  }

  function revokeDialogObjectUrl() {
    if (!state.dialogObjectUrl) return;
    revokeTransientObjectUrl(state.dialogObjectUrl);
    state.dialogObjectUrl = "";
  }

  function findMessageChat(message) {
    if (!state.archive || !message) return getActiveChat();
    return state.archive.chats.find((chat) => chat.messages.includes(message))
      || state.archive.chats.find((chat) => chat.id === message.chatId)
      || getActiveChat();
  }

  function openMediaDialog(message, sequence) {
    const media = message && message.media;
    if (!media || media.missing) return;
    if (message.type === "video" && isPreviewOnlyVideo(media)) {
      showToast("导出包只保存了视频缩略图，原视频文件缺失。");
      return;
    }
    const chat = findMessageChat(message);
    const fallback = chat ? [{ chat, message }] : [];
    const items = normalizeMediaDialogItems(Array.isArray(sequence) && sequence.length ? sequence : fallback);
    const key = mediaDialogItemKey({ chat, message });
    let index = items.findIndex((item) => item.message === message || mediaDialogItemKey(item) === key);
    if (index < 0 && canOpenMediaItem({ chat, message })) {
      items.push({ chat, message });
      index = items.length - 1;
    }
    if (index < 0) return;
    state.dialogItems = items;
    state.dialogIndex = index;
    if (!elements.mediaDialog.open) elements.mediaDialog.showModal();
    renderMediaDialogItem();
    requestAnimationFrame(() => elements.mediaCloseButton.focus({ preventScroll: true }));
  }

  function maintainMediaDialogFocus() {
    const active = document.activeElement;
    if (active === elements.mediaPreviousButton && elements.mediaPreviousButton.disabled) {
      (elements.mediaNextButton.disabled ? elements.mediaCloseButton : elements.mediaNextButton)
        .focus({ preventScroll: true });
    } else if (active === elements.mediaNextButton && elements.mediaNextButton.disabled) {
      (elements.mediaPreviousButton.disabled ? elements.mediaCloseButton : elements.mediaPreviousButton)
        .focus({ preventScroll: true });
    } else if (active === elements.mediaDownloadButton && elements.mediaDownloadButton.disabled) {
      elements.mediaCloseButton.focus({ preventScroll: true });
    }
  }

  async function renderMediaDialogItem() {
    const item = state.dialogItems[state.dialogIndex];
    if (!item || !canOpenMediaItem(item)) return;
    const { message, chat } = item;
    const media = message.media;
    const requestToken = ++state.dialogRequestToken;
    const existingVideo = elements.mediaDialogContent.querySelector("video");
    if (existingVideo) existingVideo.pause();
    revokeDialogObjectUrl();
    state.dialogMedia = media;
    elements.mediaDialogTitle.textContent = media.downloadName || (message.type === "video" ? "视频" : "图片");
    elements.mediaDialogMeta.textContent = [
      chat && chat.title,
      formatDateLabel(message.timestamp),
      formatTime(message.timestamp),
      fileTypeLabel(media.mime),
      formatBytes(media.size),
    ].filter(Boolean).join(" · ");
    elements.mediaDialogCounter.textContent = `${state.dialogIndex + 1} / ${state.dialogItems.length}`;
    const navigation = mediaNavigationState(state.dialogIndex, state.dialogItems.length);
    elements.mediaPreviousButton.hidden = !navigation.hasMultiple;
    elements.mediaNextButton.hidden = !navigation.hasMultiple;
    elements.mediaPreviousButton.disabled = !navigation.canPrevious;
    elements.mediaNextButton.disabled = !navigation.canNext;
    const downloadable = Boolean(media.entryName) && !(message.type === "video" && media.originalMissing);
    elements.mediaDownloadButton.disabled = !downloadable;
    elements.mediaDownloadButton.title = downloadable ? "下载" : "原文件不可用";
    elements.mediaDownloadButton.setAttribute("aria-label", downloadable ? "下载文件" : "原文件不可用");
    maintainMediaDialogFocus();
    elements.mediaDialogContent.replaceChildren(createMediaPlaceholder(message.type === "video" ? "play" : "image"));
    let source = null;
    try {
      source = await mediaDialogSource(message);
      if (
        requestToken !== state.dialogRequestToken
        || state.dialogItems[state.dialogIndex] !== item
        || !elements.mediaDialog.open
      ) {
        if (source.transient) revokeTransientObjectUrl(source.url);
        return;
      }
      if (source.transient) state.dialogObjectUrl = source.url;
      const node = document.createElement(message.type === "video" ? "video" : "img");
      if (node instanceof HTMLVideoElement) {
        node.controls = true;
        node.preload = "metadata";
        node.playsInline = true;
      } else {
        node.alt = media.downloadName || "图片预览";
      }
      node.src = source.url;
      elements.mediaDialogContent.replaceChildren(node);
    } catch (error) {
      if (source && source.transient && state.dialogObjectUrl !== source.url) {
        revokeTransientObjectUrl(source.url);
      }
      if (requestToken !== state.dialogRequestToken) return;
      console.error(error);
      const failed = createMediaPlaceholder("alert");
      failed.classList.add("is-error");
      failed.title = "无法读取这个媒体附件";
      elements.mediaDialogContent.replaceChildren(failed);
      showToast("无法读取这个媒体附件，可继续查看前后项目。");
    }
  }

  function navigateMediaDialog(delta) {
    if (!elements.mediaDialog.open) return false;
    const nextIndex = state.dialogIndex + Number(delta || 0);
    if (nextIndex < 0 || nextIndex >= state.dialogItems.length || nextIndex === state.dialogIndex) return false;
    state.dialogIndex = nextIndex;
    renderMediaDialogItem();
    return true;
  }

  function closeMediaDialog() {
    if (!elements.mediaDialog) return;
    const video = elements.mediaDialogContent.querySelector("video");
    if (video) video.pause();
    revokeDialogObjectUrl();
    state.dialogRequestToken += 1;
    state.dialogMedia = null;
    state.dialogItems = [];
    state.dialogIndex = -1;
    elements.mediaDialogCounter.textContent = "";
    elements.mediaDialogContent.replaceChildren();
    if (elements.mediaDialog.open) elements.mediaDialog.close();
  }

  async function downloadMedia(media) {
    if (!media || media.missing || !media.entryName) return;
    let url = "";
    try {
      url = await createTransientObjectUrl(media.entryName, media.mime);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = media.downloadName || "附件";
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      const completedUrl = url;
      url = "";
      window.setTimeout(() => revokeTransientObjectUrl(completedUrl), 30000);
    } catch (error) {
      if (url) revokeTransientObjectUrl(url);
      console.error(error);
      showToast("无法下载这个附件。");
    }
  }

  function getObjectUrl(entryName, mime) {
    if (!state.archive || !entryName) return Promise.reject(new Error("附件不存在"));
    const key = `${entryName}\u0000${mime || ""}`;
    if (state.urls.has(key)) {
      const url = state.urls.get(key);
      state.urls.delete(key);
      state.urls.set(key, url);
      return Promise.resolve(url);
    }
    if (state.urlPromises.has(key)) return state.urlPromises.get(key);
    const archive = state.archive;
    const generation = state.generation;
    const promise = Parser.readEntryAsBlob(archive, entryName, mime)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        if (generation !== state.generation || archive !== state.archive) {
          URL.revokeObjectURL(url);
          throw new Error("聊天记录已切换");
        }
        const previousUrl = state.urls.get(key);
        if (previousUrl && previousUrl !== url) URL.revokeObjectURL(previousUrl);
        state.urls.set(key, url);
        while (state.urls.size > MAX_CACHED_OBJECT_URLS) {
          const oldest = state.urls.entries().next().value;
          if (!oldest) break;
          state.urls.delete(oldest[0]);
          URL.revokeObjectURL(oldest[1]);
        }
        if (state.urlPromises.get(key) === promise) state.urlPromises.delete(key);
        return url;
      })
      .catch((error) => {
        if (state.urlPromises.get(key) === promise) state.urlPromises.delete(key);
        throw error;
      });
    state.urlPromises.set(key, promise);
    return promise;
  }

  function revokeObjectUrls() {
    revokeDialogObjectUrl();
    if (lazyMediaObserver) {
      lazyMediaObserver.disconnect();
      lazyMediaObserver = null;
    }
    for (const url of state.urls.values()) URL.revokeObjectURL(url);
    state.urls.clear();
    state.urlPromises.clear();
    for (const url of state.transientUrls) URL.revokeObjectURL(url);
    state.transientUrls.clear();
    state.videoFramePreviews.clear();
    state.videoFramePreviewPromises.clear();
    state.videoFramePreviewConsumers.clear();
    videoFrameQueue = Promise.resolve();
  }

  function stopActiveAudio() {
    state.audioPlayRequestToken += 1;
    if (state.activeAudio) {
      const wrapper = state.activeAudio.closest(".audio-player");
      if (wrapper && typeof wrapper.__showMessageReleaseAudio === "function") {
        wrapper.__showMessageReleaseAudio();
      } else {
        state.activeAudio.pause();
        state.activeAudio = null;
      }
    }
  }

  function localDateKey(timestamp) {
    if (!timestamp) return "unknown";
    return DateTime.dateKey(timestamp, state.timeZone) || "unknown";
  }

  function formatDateLabel(timestamp) {
    if (!timestamp) return "日期未知";
    return dateFormatter.format(new Date(timestamp * 1000));
  }

  function formatDateDividerLabel(timestamp) {
    if (!timestamp) return "日期未知";
    return DateTime.appendOffsetLabel(formatDateLabel(timestamp), state.timeZone, timestamp);
  }

  function formatSearchResultDate(timestamp) {
    return formatDateLabel(timestamp);
  }

  function dateInputValue(timestamp) {
    return timestamp ? DateTime.dateKey(timestamp, state.timeZone) : "";
  }

  function formatTime(timestamp) {
    return timestamp ? timeFormatter.format(new Date(timestamp * 1000)) : "--:--";
  }

  function formatChatTime(timestamp) {
    return timestamp ? formatDateLabel(timestamp) : "";
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds || 0)));
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, "0")}`;
  }

  function formatBytes(bytes) {
    const size = Number(bytes || 0);
    if (!size) return "";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`;
    return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function fileTypeLabel(mime) {
    if (!mime || mime === "application/octet-stream") return "文件";
    const labels = {
      "text/markdown": "Markdown",
      "text/plain": "文本",
      "application/pdf": "PDF",
      "video/mp4": "MP4 视频",
      "audio/ogg": "OGG 音频",
      "audio/ogg; codecs=opus": "OPUS 语音",
      "audio/opus": "OPUS 语音",
      "image/jpeg": "JPEG 图片",
      "image/png": "PNG 图片",
      "image/webp": "WebP 图片",
    };
    return labels[mime.toLowerCase()] || mime.split("/").pop().toUpperCase();
  }

  function bindEvents() {
    elements.headerOpenButton.addEventListener("click", openPicker);
    elements.archiveInfoButton.addEventListener("click", openArchiveInfoDialog);
    elements.mobileSettingsButton.addEventListener("click", showSettingsView);
    elements.settingsBackButton.addEventListener("click", () => hideSettingsView(true));
    elements.mediaLibraryButton.addEventListener("click", () => {
      if (elements.mediaLibraryButton.getAttribute("aria-disabled") === "true") {
        showToast("请先载入 ZAPiXWEB ZIP。");
        return;
      }
      openLibraryDialog("");
    });
    elements.profileButton.addEventListener("click", () => {
      if (elements.profileButton.getAttribute("aria-disabled") === "true") {
        showToast(state.archive ? "这个 ZIP 未包含当前用户信息。" : "请先载入 ZAPiXWEB ZIP。");
        return;
      }
      if (elements.profileView.hidden) showProfileView();
      else hideProfileView();
    });
    elements.profileBackButton.addEventListener("click", hideProfileView);
    elements.zipInput.addEventListener("change", () => {
      const file = elements.zipInput.files && elements.zipInput.files[0];
      if (!file) return;
      if (!isZipFile(file)) {
        showToast("请选择 .zip 格式的 ZAPiXWEB 导出包。");
        elements.zipInput.value = "";
        return;
      }
      loadArchive(file, file.name);
    });
    elements.chatSearch.addEventListener("input", () => {
      state.query = elements.chatSearch.value;
      state.chatSearchLimit = CHAT_SEARCH_PAGE_SIZE;
      renderChatList();
      const scrollParent = elements.chatList.closest(".chat-list-scroll");
      if (scrollParent) scrollParent.scrollTop = 0;
    });
    elements.filterRow.addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      state.filter = button.dataset.filter;
      state.chatSearchLimit = CHAT_SEARCH_PAGE_SIZE;
      updateFilterButtons();
      renderChatList();
    });
    elements.emptyResetButton.addEventListener("click", () => {
      state.query = "";
      state.filter = "all";
      state.chatSearchLimit = CHAT_SEARCH_PAGE_SIZE;
      elements.chatSearch.value = "";
      updateFilterButtons();
      renderChatList();
    });
    elements.backToChats.addEventListener("click", showChatList);
    elements.conversationAvatar.addEventListener("click", () => openDetailPanel("contact"));
    elements.conversationSearchButton.addEventListener("click", () => openDetailPanel("search"));
    elements.detailPanelClose.addEventListener("click", closeDetailPanel);
    elements.messageList.addEventListener("scroll", () => scheduleFloatingDateUpdate(true), { passive: true });
    elements.mediaCloseButton.addEventListener("click", closeMediaDialog);
    elements.mediaPreviousButton.addEventListener("click", () => navigateMediaDialog(-1));
    elements.mediaNextButton.addEventListener("click", () => navigateMediaDialog(1));
    elements.mediaDownloadButton.addEventListener("click", () => {
      if (!elements.mediaDownloadButton.disabled) downloadMedia(state.dialogMedia);
    });
    elements.mediaDialog.addEventListener("click", (event) => {
      if (event.target === elements.mediaDialog) closeMediaDialog();
    });
    elements.mediaDialog.addEventListener("close", () => {
      const video = elements.mediaDialogContent.querySelector("video");
      if (video) video.pause();
      revokeDialogObjectUrl();
      state.dialogRequestToken += 1;
      state.dialogMedia = null;
      state.dialogItems = [];
      state.dialogIndex = -1;
      elements.mediaDialogCounter.textContent = "";
      elements.mediaDialogContent.replaceChildren();
    });
    elements.mediaDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeMediaDialog();
    });
    elements.libraryDialogClose.addEventListener("click", closeLibraryDialog);
    elements.libraryTabs.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-library-tab]");
      if (!tab) return;
      state.libraryTab = tab.dataset.libraryTab;
      renderLibraryDialog();
    });
    elements.libraryTabs.addEventListener("keydown", (event) => {
      const tab = event.target.closest("[data-library-tab]");
      if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const tabs = Array.from(elements.libraryTabs.querySelectorAll("[data-library-tab]"));
      const currentIndex = tabs.indexOf(tab);
      let nextIndex = currentIndex;
      if (event.key === "ArrowLeft") nextIndex = (currentIndex + tabs.length - 1) % tabs.length;
      if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      event.preventDefault();
      state.libraryTab = tabs[nextIndex].dataset.libraryTab;
      renderLibraryDialog();
      tabs[nextIndex].focus();
    });
    elements.libraryDialog.addEventListener("click", (event) => {
      if (event.target === elements.libraryDialog) closeLibraryDialog();
    });
    elements.libraryDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeLibraryDialog();
    });
    elements.libraryDialog.addEventListener("close", () => {
      state.libraryChatId = "";
      elements.libraryDialogContent.replaceChildren();
    });
    elements.archiveInfoDialogClose.addEventListener("click", closeArchiveInfoDialog);
    elements.archiveInfoDialog.addEventListener("click", (event) => {
      if (event.target === elements.archiveInfoDialog) closeArchiveInfoDialog();
    });
    elements.archiveInfoDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeArchiveInfoDialog();
    });
    elements.archiveInfoDialog.addEventListener("close", () => {
      elements.archiveInfoDialogContent.replaceChildren();
    });
    document.addEventListener("click", (event) => {
      if (state.closeDatePicker && !event.target.closest(".detail-date-picker-wrap")) {
        state.closeDatePicker();
      }
      const unavailable = event.target.closest("[data-offline]");
      if (!unavailable) return;
      event.preventDefault();
      showToast("离线 ZIP 查看器不支持此功能。");
    });
    document.addEventListener("keydown", (event) => {
      const mediaNavigationKey = elements.mediaDialog.open && ["ArrowLeft", "ArrowRight"].includes(event.key);
      const navigationTarget = event.target;
      const mediaControlHasFocus = navigationTarget instanceof HTMLVideoElement
        || ["INPUT", "TEXTAREA", "SELECT"].includes(navigationTarget && navigationTarget.tagName);
      if (mediaNavigationKey && !mediaControlHasFocus) {
        event.preventDefault();
        navigateMediaDialog(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "Escape" && state.closeDatePicker) {
        event.preventDefault();
        state.closeDatePicker();
      } else if (event.key === "Escape" && elements.mediaDialog.open) {
        event.preventDefault();
        closeMediaDialog();
      } else if (event.key === "Escape" && elements.libraryDialog.open) {
        event.preventDefault();
        closeLibraryDialog();
      } else if (event.key === "Escape" && elements.archiveInfoDialog.open) {
        event.preventDefault();
        closeArchiveInfoDialog();
      } else if (event.key === "Escape" && !elements.settingsView.hidden) {
        event.preventDefault();
        hideSettingsView(true);
      } else if (event.key === "Escape" && !elements.detailPanel.hidden) {
        event.preventDefault();
        closeDetailPanel();
      }
    });

    document.addEventListener("dragenter", (event) => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      state.dragDepth += 1;
      elements.dropOverlay.hidden = false;
    });
    document.addEventListener("dragover", (event) => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    document.addEventListener("dragleave", (event) => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return;
      state.dragDepth = Math.max(0, state.dragDepth - 1);
      if (!state.dragDepth) elements.dropOverlay.hidden = true;
    });
    document.addEventListener("drop", (event) => {
      event.preventDefault();
      state.dragDepth = 0;
      elements.dropOverlay.hidden = true;
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (!isZipFile(file)) {
        showToast("请拖入一个 .zip 格式的 ZAPiXWEB 导出包。");
        return;
      }
      loadArchive(file, file.name);
    });
    window.addEventListener("resize", () => {
      scheduleFloatingDateUpdate(false);
      syncDetailPanelModality();
    });
    window.addEventListener("beforeunload", revokeObjectUrls);
  }

  function init() {
    setTheme(initialTheme(), false);
    rebuildDateTimeFormatters();
    bindEvents();
    renderProfileButton();
    setNavAvailability(false);
    renderChatList();
    showWelcome();
  }

  init();
})();
