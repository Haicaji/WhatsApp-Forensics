import type { OfflinePreviewAssetSource, OfflinePreviewDataset } from "./offline-preview.js";

export function buildOfflinePreviewDocumentStart(
  dataset: OfflinePreviewDataset,
  assets: OfflinePreviewAssetSource[],
): string {
  const model = normalizeDataset(dataset, assets);
  const title = escapeHtml(`${dataset.source.specimenName} WhatsApp 离线预览`);
  return [
    "<!doctype html>\n",
    '<html lang="zh-CN" data-theme="dark">\n<head>\n',
    '<meta charset="utf-8">\n',
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'; frame-src \'none\'">\n',
    `<title>${title}</title>\n`,
    `<style>${OFFLINE_PREVIEW_STYLES}</style>\n`,
    "</head>\n<body>\n",
    OFFLINE_PREVIEW_SHELL,
    OFFLINE_PREVIEW_SPRITE,
    `<script type="application/json" id="offline-data">${safeJson(model)}</script>\n`,
  ].join("");
}

export function buildOfflinePreviewDocumentEnd(): string {
  return `<script>${OFFLINE_PREVIEW_RUNTIME}</script>\n</body>\n</html>\n`;
}

function normalizeDataset(dataset: OfflinePreviewDataset, assets: OfflinePreviewAssetSource[]): unknown {
  return {
    schemaVersion: "wafc-offline-preview/1",
    generatedAtUtc: dataset.generatedAtUtc,
    displayTimeZone: dataset.displayTimeZone,
    caseName: dataset.caseName,
    source: {
      specimenName: dataset.source.specimenName,
      collectionStatus: dataset.source.collectionStatus,
      warning: dataset.source.warning,
    },
    account: dataset.workspace.account,
    conversations: dataset.conversations.map(({ chat, messages }) => ({
      id: chat.nativeId,
      title: chat.title,
      kind: chat.kind,
      phoneNumber: chat.phoneNumber,
      formattedPhoneNumber: chat.formattedPhoneNumber,
      avatarAssetId: mediaAssetId(chat.avatarUrl),
      participantCount: chat.participantCount,
      messageCount: chat.messageCount,
      mediaCount: chat.mediaCount,
      starredMessageCount: chat.starredMessageCount,
      lastMessageAtUtc: chat.lastMessageAtUtc,
      lastMessagePreview: chat.lastMessagePreview,
      community: chat.community === null
        ? null
        : {
            id: chat.community.id,
            title: chat.community.title,
            role: chat.community.role,
            avatarAssetId: mediaAssetId(chat.community.avatarUrl),
          },
      messages: messages.map(normalizeMessage),
    })),
    calls: dataset.workspace.calls,
    statuses: dataset.workspace.statuses,
    channels: dataset.workspace.channels.map((channel) => ({
      ...channel,
      avatarAssetId: mediaAssetId(channel.avatarUrl),
      avatarUrl: undefined,
      messages: channel.messages.map((message) => ({
        ...message,
        attachments: message.attachments.map(normalizeAttachment),
      })),
    })),
    communities: dataset.workspace.communities,
    availability: dataset.workspace.availability,
    assets: assets.map((asset) => ({
      assetId: asset.assetId,
      mimeType: asset.mimeType ?? "application/octet-stream",
      fileName: asset.fileName,
    })),
  };
}

function normalizeMessage(message: OfflinePreviewDataset["conversations"][number]["messages"][number]): unknown {
  return {
    id: message.nativeId,
    chatId: message.chatNativeId,
    senderId: message.senderId,
    senderDisplayName: message.senderDisplayName,
    recipientId: message.recipientId,
    fromMe: message.fromMe,
    timestampUtc: message.timestampUtc,
    type: message.type,
    text: message.text,
    caption: message.caption,
    quotedMessageId: message.quotedMessageId,
    isForwarded: message.isForwarded,
    isStarred: message.isStarred,
    isRevoked: message.isRevoked,
    acknowledgement: message.acknowledgement,
    attachments: message.attachments.map(normalizeAttachment),
  };
}

function normalizeAttachment(
  attachment: OfflinePreviewDataset["conversations"][number]["messages"][number]["attachments"][number],
): unknown {
  return {
    assetId: attachment.status === "available" ? attachment.opaqueId : null,
    kind: attachment.kind,
    status: attachment.status,
    mimeType: attachment.mimeType,
    fileName: attachment.fileName,
    sizeBytes: attachment.sizeBytes,
    failureReason: attachment.failureReason,
  };
}

function mediaAssetId(url: string | null): string | null {
  if (url === null) return null;
  const match = /^wafc-media:\/\/asset\/([0-9a-f-]+)$/iu.exec(url);
  return match?.[1] ?? null;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const OFFLINE_PREVIEW_SHELL = String.raw`
<div class="app-shell">
  <nav class="nav-rail" aria-label="WhatsApp 功能">
    <div class="nav-primary">
      <button class="nav-button is-selected" type="button" data-section="chats" aria-label="对话" title="对话"><svg class="icon"><use href="#icon-chat"></use></svg></button>
      <button class="nav-button" type="button" data-section="calls" aria-label="通话" title="通话"><svg class="icon"><use href="#icon-calls"></use></svg></button>
      <button class="nav-button" type="button" data-section="statuses" aria-label="动态" title="动态"><svg class="icon"><use href="#icon-status"></use></svg></button>
      <button class="nav-button" type="button" data-section="channels" aria-label="频道" title="频道"><svg class="icon"><use href="#icon-channel"></use></svg></button>
      <button class="nav-button" type="button" data-section="communities" aria-label="社群" title="社群"><svg class="icon"><use href="#icon-community"></use></svg></button>
    </div>
    <div class="nav-footer">
      <button id="libraryOpen" class="nav-button" type="button" aria-label="全部媒体" title="全部媒体"><svg class="icon"><use href="#icon-image"></use></svg></button>
      <button class="profile-button" type="button" data-section="profile" aria-label="账号资料" title="账号资料"><span id="profileRailAvatar" class="avatar avatar-small"></span></button>
    </div>
  </nav>

  <aside class="drawer" aria-label="内容列表">
    <header class="drawer-header">
      <div class="drawer-heading"><h1 id="drawerTitle">对话</h1><span id="drawerCount"></span></div>
      <div class="drawer-actions" aria-label="列表操作">
        <button class="icon-button unavailable-action" type="button" aria-label="新建对话（离线预览不可用）" title="离线预览不可新建对话" disabled><svg class="icon"><use href="#icon-new-chat"></use></svg></button>
        <button class="icon-button unavailable-action" type="button" aria-label="更多（离线预览不可用）" title="离线预览不可修改数据" disabled><svg class="icon"><use href="#icon-menu"></use></svg></button>
      </div>
    </header>
    <div id="searchRegion" class="search-region">
      <label class="search-box" for="drawerSearch"><svg class="icon"><use href="#icon-search"></use></svg><input id="drawerSearch" type="search" autocomplete="off" placeholder="搜索对话"></label>
    </div>
    <div id="filterRegion" class="filter-region" aria-label="对话筛选">
      <button class="filter-chip is-selected" type="button" data-chat-filter="all">所有</button>
      <button class="filter-chip" type="button" data-chat-filter="unread" disabled title="离线结果没有未读状态">未读</button>
      <button class="filter-chip" type="button" data-chat-filter="starred">特别关注</button>
      <button class="filter-chip" type="button" data-chat-filter="groups">群组</button>
    </div>
    <div id="drawerBody" class="drawer-body"></div>
  </aside>

  <main class="content-shell">
    <section id="welcomeView" class="welcome-view">
      <div class="welcome-mark"><svg class="icon"><use href="#icon-chat"></use></svg></div>
      <h2>选择一项内容</h2>
      <p>在左侧查看该 WhatsApp 账号已采集的记录。</p>
    </section>
    <section id="contentView" class="content-view" hidden>
      <header id="contentHeader" class="content-header"></header>
      <div id="floatingDate" class="floating-date" aria-hidden="true" hidden></div>
      <div id="contentBody" class="content-body"></div>
      <footer id="readonlyComposer" class="readonly-composer" aria-label="只读消息栏">
        <span class="composer-icon" aria-hidden="true">＋</span>
        <svg class="icon composer-emoji" aria-hidden="true"><use href="#icon-emoji"></use></svg>
        <span class="composer-field">只读预览</span>
        <svg class="icon composer-mic" aria-hidden="true"><use href="#icon-mic"></use></svg>
      </footer>
    </section>
    <aside id="detailPanel" class="detail-panel" hidden>
      <header class="detail-header"><button id="detailClose" class="icon-button" type="button" aria-label="关闭信息面板"><svg class="icon"><use href="#icon-close"></use></svg></button><h2 id="detailPanelTitle">会话信息</h2></header>
      <div id="detailBody" class="detail-body"></div>
    </aside>
  </main>
</div>

<dialog id="libraryDialog" class="library-dialog" aria-labelledby="libraryTitle" aria-describedby="librarySubtitle">
  <section class="library-dialog-shell">
    <header class="library-dialog-header">
      <div class="library-heading">
        <strong id="libraryTitle">所有聊天的影音内容、链接和文档</strong>
        <span id="librarySubtitle">按分类查看全部已提取内容</span>
      </div>
      <button id="libraryClose" class="icon-button" type="button" aria-label="关闭全部媒体"><svg class="icon"><use href="#icon-close"></use></svg></button>
    </header>
    <div id="libraryTabs" class="library-tabs" role="tablist" aria-label="全部媒体分类">
      <button class="library-tab is-selected" id="libraryTab-media" type="button" role="tab" data-library-tab="media" aria-controls="libraryDialogBody" aria-selected="true">影音内容 <span data-library-count="media"></span></button>
      <button class="library-tab" id="libraryTab-documents" type="button" role="tab" data-library-tab="documents" aria-controls="libraryDialogBody" aria-selected="false">文档 <span data-library-count="documents"></span></button>
      <button class="library-tab" id="libraryTab-links" type="button" role="tab" data-library-tab="links" aria-controls="libraryDialogBody" aria-selected="false">链接 <span data-library-count="links"></span></button>
    </div>
    <div id="libraryDialogBody" class="library-dialog-body" role="tabpanel" aria-labelledby="libraryTab-media"></div>
  </section>
</dialog>

<dialog id="mediaDialog" class="media-dialog" aria-labelledby="mediaSenderName" aria-describedby="mediaSentAt mediaMeta">
  <header class="media-dialog-header">
    <div class="media-identity">
      <span id="mediaSenderAvatarSlot" class="media-sender-avatar-slot" aria-hidden="true"></span>
      <div class="media-identity-copy">
        <strong id="mediaSenderName">媒体发送者</strong>
        <time id="mediaSentAt">发送时间未知</time>
        <span id="mediaTitle" class="sr-only">媒体预览</span>
        <span id="mediaMeta" class="sr-only"></span>
        <span id="mediaCounter" class="sr-only" aria-live="polite"></span>
      </div>
    </div>
    <div class="media-actions">
      <button id="mediaJumpToMessage" class="icon-button" type="button" aria-label="前往消息" title="前往消息"><svg class="icon"><use href="#icon-chat"></use></svg></button>
      <a id="mediaDownload" class="icon-button" aria-label="保存媒体" title="保存媒体"><svg class="icon"><use href="#icon-download"></use></svg></a>
      <button id="mediaClose" class="icon-button" type="button" aria-label="关闭媒体预览" title="关闭媒体预览"><svg class="icon"><use href="#icon-close"></use></svg></button>
    </div>
  </header>
  <button id="mediaPrevious" class="media-dialog-nav is-previous" type="button" aria-label="上一项媒体"><svg class="icon"><use href="#icon-chevron-left"></use></svg></button>
  <button id="mediaNext" class="media-dialog-nav is-next" type="button" aria-label="下一项媒体"><svg class="icon"><use href="#icon-chevron-right"></use></svg></button>
  <div id="mediaDialogBody" class="media-dialog-body"></div>
  <footer id="mediaFilmstrip" class="media-filmstrip" aria-label="媒体缩略图预览"><div id="mediaFilmstripTrack" class="media-filmstrip-track"></div></footer>
</dialog>
`;

const OFFLINE_PREVIEW_SPRITE = String.raw`
<svg class="svg-sprite" aria-hidden="true" focusable="false">
  <symbol id="icon-chat" viewBox="0 0 24 24"><path d="M4 5.5h16v12.8H8.2L4 21V5.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 10h8M8 14h5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="icon-calls" viewBox="0 0 24 24"><path d="M7.1 3.8 10 7.4 8.2 9.2c1.2 2.6 3 4.4 5.6 5.6l1.8-1.8 3.6 2.9-.8 3.4c-.2.8-.9 1.3-1.7 1.3C9.4 20.6 3.4 14.6 3.4 7.3c0-.8.5-1.5 1.3-1.7l2.4-.6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.5 4.5h5v5M19.2 4.8l-4.3 4.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="icon-status" viewBox="0 0 24 24"><path d="M4.7 7.4A8.6 8.6 0 0 1 7.5 4.7M4 12a8 8 0 0 0 8 8m4.6-.7A8.5 8.5 0 0 0 19.3 16M20 12a8 8 0 0 0-8-8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="3.4" fill="currentColor"/></symbol>
  <symbol id="icon-channel" viewBox="0 0 24 24"><path d="M6 8.5h8.5a3.5 3.5 0 1 1 0 7H6a3.5 3.5 0 1 1 0-7Zm11.5-3v13M9 5v3.5M9 15.5V19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="icon-community" viewBox="0 0 24 24"><circle cx="8" cy="9" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="17" cy="10" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M2.8 19c.5-3.2 2.2-5 5.2-5s4.7 1.8 5.2 5M14.1 15c.8-.8 1.7-1.2 2.9-1.2 2.3 0 3.7 1.5 4.1 4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></symbol>
  <symbol id="icon-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 10.5v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="7.2" r="1.1" fill="currentColor"/></symbol>
  <symbol id="icon-lock" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="icon-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="icon-moon" viewBox="0 0 24 24"><path d="M20.4 15.2A8.7 8.7 0 0 1 8.8 3.6a8.7 8.7 0 1 0 11.6 11.6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></symbol>
  <symbol id="icon-user" viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 20c.5-4.1 2.8-6 7-6s6.5 1.9 7 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="icon-search" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m15.5 15.5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="icon-calendar" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7 3v4M17 3v4M3 10h18" stroke="currentColor" stroke-width="1.8"/><path d="M8 14h3v3H8z" fill="currentColor"/></symbol>
  <symbol id="icon-download" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="icon-close" viewBox="0 0 24 24"><path d="m5 5 14 14M19 5 5 19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="icon-file" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6V3Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 3v5h4M9 13h6M9 17h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></symbol>
  <symbol id="icon-link" viewBox="0 0 24 24"><path d="m9.5 14.5 5-5M7.4 17.6l-1 1a3.5 3.5 0 0 1-5-5l3.2-3.2a3.5 3.5 0 0 1 5 0M16.6 6.4l1-1a3.5 3.5 0 1 1 5 5l-3.2 3.2a3.5 3.5 0 0 1-5 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="icon-image" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8.5" cy="9" r="1.5" fill="currentColor"/><path d="m5 18 5-5 3.2 3.2 2.1-2.1L19 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="icon-check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="icon-check-double" viewBox="0 0 24 24"><path d="m2.5 12 4 4 7-7M9 15l2 2L21.5 6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="icon-forward" viewBox="0 0 24 24"><path d="m14 5 6 6-6 6v-4c-5 0-8 .8-10 5 .3-6.5 3.7-9 10-9V5Z" fill="currentColor"/></symbol>
  <symbol id="icon-new-chat" viewBox="0 0 24 24"><path d="M5 4h14v12H9l-4 3V4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 7v6M9 10h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="icon-menu" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="19" r="1.7" fill="currentColor"/></symbol>
  <symbol id="icon-emoji" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="9.5" r="1" fill="currentColor"/><circle cx="15" cy="9.5" r="1" fill="currentColor"/><path d="M8.5 14c1 1.5 2.1 2.2 3.5 2.2s2.5-.7 3.5-2.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="icon-mic" viewBox="0 0 24 24"><rect x="8.5" y="3" width="7" height="12" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="icon-chevron" viewBox="0 0 24 24"><path d="m7 9 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="icon-chevron-left" viewBox="0 0 24 24"><path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="icon-chevron-right" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="icon-expand" viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5M3 8l6-6M21 8l-6-6M3 16l6 6M21 16l-6 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="icon-video" viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 10 5-3v10l-5-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></symbol>
</svg>
`;

const OFFLINE_PREVIEW_STYLES = String.raw`
:root{color-scheme:dark;--nav:64px;--drawer:400px;--header:64px;--surface:#161717;--surface-2:#1d1f1f;--surface-3:#242626;--surface-hover:#2d2f2f;--text:#fafafa;--muted:rgba(255,255,255,.62);--faint:rgba(255,255,255,.42);--border:rgba(255,255,255,.1);--accent:#21c063;--accent-soft:#103529;--incoming:#242626;--outgoing:#144d37;--wallpaper:#161717;--composer:#242626;--warning:#ffd279;--danger:#fb5061;--shadow:rgba(0,0,0,.24);--scroll:rgba(255,255,255,.2);--font:"Segoe UI Variable","Microsoft YaHei UI","Noto Sans SC",Arial,sans-serif}
html[data-theme="light"]{color-scheme:light;--surface:#fff;--surface-2:#f7f5f3;--surface-3:#fff;--surface-hover:#f1f0ee;--text:#111;--muted:rgba(0,0,0,.62);--faint:rgba(0,0,0,.42);--border:rgba(0,0,0,.1);--accent:#1b8755;--accent-soft:#e7fce3;--incoming:#fff;--outgoing:#d9fdd3;--wallpaper:#f5f1eb;--composer:#fff;--warning:#8a5b1f;--danger:#d92d4d;--shadow:rgba(0,0,0,.12);--scroll:rgba(0,0,0,.2)}
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden}body{background:var(--surface);color:var(--text);font:15px/1.45 var(--font);-webkit-font-smoothing:antialiased}button,input,a{font:inherit;color:inherit}button{border:0}button,a{cursor:pointer}button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}[hidden]{display:none!important}.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}.svg-sprite{position:absolute;width:0;height:0;overflow:hidden}.icon{width:24px;height:24px;display:block;fill:none}.mini-icon{width:14px;height:14px;display:block}.app-shell{display:grid;grid-template-columns:var(--nav) var(--drawer) minmax(0,1fr);width:100%;height:100dvh;min-height:560px;overflow:hidden;background:var(--surface)}
.nav-rail{display:flex;flex-direction:column;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--surface-2);border-right:1px solid var(--border);z-index:8}.nav-primary,.nav-footer{width:40px;display:flex;flex-direction:column;align-items:center;gap:4px}.nav-button,.profile-button{width:40px;height:40px;display:grid;place-items:center;background:transparent;border-radius:50%;color:var(--muted);position:relative}.nav-primary .nav-button[data-section="statuses"]{margin-top:4px}.nav-button:hover,.nav-button.is-selected,.profile-button:hover{background:rgba(255,255,255,.1);color:var(--text)}html[data-theme="light"] .nav-button:hover,html[data-theme="light"] .nav-button.is-selected,html[data-theme="light"] .profile-button:hover{background:rgba(0,0,0,.08)}.nav-button.is-selected:before{content:"";position:absolute;right:-12px;width:3px;height:22px;background:var(--accent);border-radius:3px 0 0 3px}.theme-light{display:none}html[data-theme="light"] .theme-dark{display:none}html[data-theme="light"] .theme-light{display:block}.profile-button{padding:0}.profile-button .avatar{width:38px;height:38px}
.drawer{display:flex;min-width:0;flex-direction:column;background:var(--surface);border-right:1px solid var(--border);overflow:hidden}.drawer-header{height:var(--header);flex:0 0 var(--header);display:flex;align-items:center;gap:11px;padding:8px 14px;border-bottom:1px solid var(--border)}.account-avatar-button{padding:0;background:transparent;border-radius:50%}.drawer-heading{min-width:0;flex:1}.drawer-heading h1{margin:0;font-size:22px;line-height:1.2}.drawer-heading span{color:var(--muted);font-size:12px}.offline-badge{padding:4px 7px;border:1px solid var(--border);border-radius:5px;color:var(--muted);font-size:11px;white-space:nowrap}.avatar{display:grid;width:45px;height:45px;place-items:center;overflow:hidden;border-radius:50%;background:#0b3e3e;color:#5cd8cb;font-weight:650;text-transform:uppercase}.avatar-small{width:36px;height:36px;font-size:12px}.avatar img{width:100%;height:100%;object-fit:cover}.search-region{padding:11px 14px 9px}.search-box{height:40px;display:flex;align-items:center;gap:10px;padding:0 12px;border-radius:8px;background:var(--surface-3);color:var(--muted)}.search-box .icon{width:19px;height:19px}.search-box input{min-width:0;flex:1;border:0;outline:0;background:transparent}.search-box input::placeholder{color:var(--faint)}.drawer-body{min-height:0;flex:1;overflow:auto;scrollbar-color:var(--scroll) transparent}.drawer-section-label{padding:13px 18px 7px;color:var(--muted);font-size:12px;font-weight:650}.list-row{width:100%;min-height:78px;display:flex;align-items:center;gap:12px;padding:10px 14px;background:transparent;text-align:left;border-bottom:1px solid var(--border)}.list-row:hover{background:var(--surface-hover)}.list-row.is-selected{background:rgba(255,255,255,.11)}html[data-theme="light"] .list-row.is-selected{background:#f0f2f5}.row-avatar{width:52px;flex:0 0 52px;position:relative}.row-avatar .avatar{width:50px;height:50px}.avatar-stack{height:54px}.avatar-stack .avatar:first-child{position:absolute;top:0;left:0;width:40px;height:40px}.avatar-stack .avatar:last-child{position:absolute;right:0;bottom:0;width:35px;height:35px;border:2px solid var(--surface)}.row-main{min-width:0;flex:1}.row-line{display:flex;align-items:baseline;gap:8px}.row-line strong{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px}.row-time{color:var(--muted);font-size:11px;white-space:nowrap}.row-preview,.row-context{margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:13px}.row-context{color:var(--accent);font-size:11px}.drawer-footer{min-height:49px;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px 14px;border-top:1px solid var(--border);color:var(--faint);font-size:11px;text-align:center}
.content-shell{min-width:0;display:flex;position:relative;background:var(--wallpaper);overflow:hidden}.welcome-view{margin:auto;max-width:480px;padding:40px;text-align:center;color:var(--muted)}.welcome-mark{width:96px;height:96px;display:grid;place-items:center;margin:0 auto 22px;border-radius:50%;background:var(--surface-2);color:var(--accent)}.welcome-mark .icon{width:46px;height:46px}.welcome-view h2{margin:0 0 8px;color:var(--text);font-size:30px;font-weight:500}.welcome-view p{margin:0}.content-view{min-width:0;flex:1;display:flex;flex-direction:column}.content-header{height:var(--header);flex:0 0 var(--header);display:flex;align-items:center;gap:12px;padding:8px 16px;background:var(--surface-2);border-bottom:1px solid var(--border);z-index:3}.conversation-heading{min-width:0;flex:1}.conversation-heading strong,.conversation-heading span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.conversation-heading strong{font-size:16px}.conversation-heading span{color:var(--muted);font-size:12px}.header-account{color:var(--muted);font-size:12px}.header-avatar-button{padding:0;border-radius:50%;background:transparent}.icon-button{width:40px;height:40px;display:grid;place-items:center;padding:0;border-radius:50%;background:transparent;color:var(--muted);text-decoration:none}.icon-button:hover{background:rgba(255,255,255,.1);color:var(--text)}html[data-theme="light"] .icon-button:hover{background:rgba(0,0,0,.08)}.content-body{min-height:0;flex:1;overflow:auto;position:relative;scrollbar-color:var(--scroll) transparent}.messages-background{min-height:100%;padding:18px clamp(22px,7vw,96px) 26px;background-color:var(--wallpaper);background-image:radial-gradient(circle at 22px 22px,rgba(255,255,255,.035) 1.5px,transparent 1.6px),radial-gradient(circle at 68px 62px,rgba(255,255,255,.028) 1px,transparent 1.1px);background-size:92px 92px}html[data-theme="light"] .messages-background{background-image:radial-gradient(circle at 22px 22px,rgba(0,0,0,.035) 1.5px,transparent 1.6px),radial-gradient(circle at 68px 62px,rgba(0,0,0,.025) 1px,transparent 1.1px)}.message-list{max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:3px}.date-chip,.system-message{align-self:center;margin:7px auto;padding:6px 10px;border-radius:7px;background:var(--surface-2);box-shadow:0 1px 2px var(--shadow);color:var(--muted);font-size:11px;text-align:center}.system-message{max-width:520px;color:var(--warning)}.message-row{display:flex}.message-row.is-outgoing{justify-content:flex-end}.bubble{position:relative;max-width:min(68%,680px);padding:7px 8px 5px;border-radius:7px;background:var(--incoming);box-shadow:0 1px 1px var(--shadow)}.message-row.is-outgoing .bubble{background:var(--outgoing)}.sender-name{margin:0 0 3px;color:#53bdeb;font-size:12px;font-weight:650}.forwarded{display:flex;align-items:center;gap:4px;margin-bottom:2px;color:var(--muted);font-size:11px;font-style:italic}.forwarded .icon{width:13px;height:13px}.quote{margin:1px 0 6px;padding:6px 8px;border-left:3px solid var(--accent);border-radius:4px;background:rgba(0,0,0,.12);color:var(--muted);font-size:12px}.message-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.45}.revoked-text{color:var(--muted);font-style:italic}.message-meta{display:flex;justify-content:flex-end;align-items:center;gap:4px;margin-top:3px;color:var(--muted);font-size:10px}.message-meta .icon{width:15px;height:15px}.message-meta .read{color:#53bdeb}.attachment{min-width:230px;max-width:440px;margin-bottom:5px;overflow:hidden;border-radius:5px;background:rgba(0,0,0,.15)}.attachment img,.attachment video{display:block;width:100%;max-height:420px;object-fit:contain;background:#111}.attachment img{cursor:zoom-in}.attachment audio{display:block;width:310px;max-width:100%;margin:12px}.document-card,.missing-card{display:flex;align-items:center;gap:10px;min-height:64px;padding:10px 12px;color:var(--text);text-decoration:none}.document-card:hover{background:rgba(255,255,255,.06)}.document-card .icon,.missing-card .icon{flex:0 0 auto}.file-copy{min-width:0}.file-copy strong,.file-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-copy small{color:var(--muted);font-size:11px}.missing-card{color:var(--warning)}.readonly-composer{height:58px;flex:0 0 58px;display:flex;align-items:center;justify-content:center;gap:8px;background:var(--composer);border-top:1px solid var(--border);color:var(--muted);font-size:13px}.readonly-composer .icon{width:18px;height:18px}
.detail-panel{width:360px;flex:0 0 360px;display:flex;flex-direction:column;background:var(--surface);border-left:1px solid var(--border);z-index:4}.detail-header{height:var(--header);display:flex;align-items:center;gap:12px;padding:8px 10px;border-bottom:1px solid var(--border)}.detail-header h2{margin:0;font-size:16px}.detail-body{min-height:0;flex:1;overflow:auto;padding-bottom:28px}.profile-hero{padding:30px 24px 24px;text-align:center;border-bottom:1px solid var(--border)}.profile-hero .avatar{width:112px;height:112px;margin:0 auto 16px;font-size:30px}.profile-hero h2{margin:0 0 5px;font-size:24px;font-weight:500;overflow-wrap:anywhere}.profile-hero p{margin:0;color:var(--muted)}.info-section{padding:18px 20px;border-bottom:1px solid var(--border)}.info-section h3{margin:0 0 12px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}.info-grid{display:grid;grid-template-columns:minmax(100px,auto) 1fr;gap:10px 14px}.info-grid dt{color:var(--muted)}.info-grid dd{margin:0;overflow-wrap:anywhere}.media-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}.media-tile{aspect-ratio:1;display:grid;place-items:center;padding:0;overflow:hidden;background:var(--surface-3)}.media-tile img,.media-tile video{width:100%;height:100%;object-fit:cover}.feature-view{min-height:100%;padding:34px clamp(28px,7vw,100px);background:var(--surface)}.feature-view-inner{max-width:980px;margin:0 auto}.feature-hero{display:flex;align-items:center;gap:18px;margin-bottom:28px}.feature-hero .avatar{width:82px;height:82px;font-size:24px}.feature-hero h2{margin:0 0 4px;font-size:28px}.feature-hero p{margin:0;color:var(--muted)}.feature-card{padding:18px 20px;margin-bottom:12px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2)}.feature-card h3{margin:0 0 7px;font-size:16px}.feature-card p{margin:0;color:var(--muted);white-space:pre-wrap}.feature-meta{display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;color:var(--muted);font-size:12px}.community-group{width:100%;display:flex;align-items:center;gap:12px;padding:12px 0;background:transparent;border-top:1px solid var(--border);text-align:left}.community-group:first-of-type{border-top:0}.community-group:hover strong{color:var(--accent)}.channel-feed{max-width:760px;margin:0 auto;padding:18px 0 40px}.channel-card{margin-bottom:18px;overflow:hidden;border-radius:8px;background:var(--surface-3);box-shadow:0 1px 2px var(--shadow)}.channel-card .attachment{max-width:none;margin:0;border-radius:0}.channel-card-copy{padding:12px 14px}.channel-card-copy p{margin:0;white-space:pre-wrap;line-height:1.5}.channel-card-copy footer{margin-top:8px;color:var(--muted);font-size:11px;text-align:right}.empty-view{display:grid;min-height:100%;place-content:center;padding:40px;color:var(--muted);text-align:center}.empty-view .icon{width:48px;height:48px;margin:0 auto 14px;color:var(--faint)}.empty-view h3{margin:0 0 5px;color:var(--text);font-size:20px}.empty-view p{margin:0;max-width:420px}
.incomplete-banner{margin:14px clamp(22px,7vw,96px) 0;padding:10px 12px;border-left:3px solid var(--warning);background:var(--surface-2);color:var(--warning);font-size:12px}.media-dialog{width:min(92vw,1100px);height:min(90vh,820px);padding:0;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);color:var(--text);box-shadow:0 22px 70px rgba(0,0,0,.45)}.media-dialog::backdrop{background:rgba(0,0,0,.78)}.media-dialog header{height:60px;display:flex;align-items:center;justify-content:space-between;padding:8px 12px 8px 18px;border-bottom:1px solid var(--border)}.media-dialog header strong,.media-dialog header span{display:block}.media-dialog header span{color:var(--muted);font-size:11px}.media-actions{display:flex;gap:2px}.media-dialog-body{height:calc(100% - 60px);display:grid;place-items:center;padding:20px;overflow:auto}.media-dialog-body img,.media-dialog-body video{max-width:100%;max-height:100%;object-fit:contain}.media-dialog-body audio{width:min(620px,90%)}
@media(max-width:1100px){:root{--drawer:350px}.detail-panel{position:absolute;right:0;top:0;bottom:0;width:340px;box-shadow:-12px 0 28px var(--shadow)}.bubble{max-width:78%}}
@media(max-width:760px){:root{--nav:54px;--drawer:320px}.nav-rail{padding-left:7px;padding-right:7px}.nav-button.is-selected:before{right:-7px}.messages-background{padding-left:16px;padding-right:16px}.bubble{max-width:88%}.offline-badge{display:none}}

/* The exported viewer follows WhatsApp Web's spatial rhythm while remaining a read-only forensic artifact. */
:root{
  --nav:64px;
  --drawer:clamp(371px,40vw,500px);
  --header:64px;
  --surface:#161717;
  --surface-2:#1d1f1f;
  --surface-3:#2d2f2f;
  --surface-hover:#252727;
  --text:#fafafa;
  --muted:rgba(255,255,255,.62);
  --faint:rgba(255,255,255,.42);
  --border:rgba(255,255,255,.10);
  --accent:#21c063;
  --incoming:#242626;
  --outgoing:#144d37;
  --wallpaper:#161717;
  --wallpaper-foreground:rgba(255,255,255,.075);
  --composer:#242626;
  --font:"Roboto Variable",Roboto,"Segoe UI Variable","Microsoft YaHei UI","Noto Sans SC",sans-serif;
  --wallpaper-pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180' viewBox='0 0 180 180'%3E%3Cg fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M16 19c8-8 22-5 23 7 1 9-7 14-15 12l-8 4 2-8c-7-4-8-10-2-15Z'/%3E%3Cpath d='M24 23v10m-5-5h10'/%3E%3Cpath d='M66 14h21v27H66zM71 21h11M71 27h11M71 33h7'/%3E%3Cpath d='M124 20c6-6 17-4 20 4 3 9-4 17-12 17-10 0-16-12-8-21Zm-5 25 5-5'/%3E%3Ccircle cx='22' cy='87' r='13'/%3E%3Cpath d='M16 85c4-4 8-4 12 0m-11 7c4 3 7 3 11 0'/%3E%3Cpath d='M64 74c10-6 24 3 20 15-3 11-17 13-24 5l-8 2 3-7c-3-6 0-12 9-15Z'/%3E%3Cpath d='m112 78 9 9-9 9m9-9H99'/%3E%3Cpath d='M151 69h13v25h-18V74l5-5Zm0 0v6h6'/%3E%3Cpath d='M15 138h25v20H15zM20 143l7 7 8-8'/%3E%3Cpath d='M66 135c0-6 5-10 11-10s11 4 11 10-5 14-11 20c-6-6-11-14-11-20Z'/%3E%3Ccircle cx='77' cy='135' r='3'/%3E%3Cpath d='M116 128c4-3 8-3 12 0m-16 6h20m-17 7h14m-17 7h20'/%3E%3Cpath d='m154 128 3 7 8 1-6 5 2 8-7-4-7 4 2-8-6-5 8-1 3-7Z'/%3E%3C/g%3E%3C/svg%3E");
}
body{font-size:14px;background:var(--surface-2)}
.app-shell{grid-template-columns:var(--nav) var(--drawer) minmax(0,1fr)}
.nav-rail{padding:10px 12px;background:var(--surface-2)}
.nav-primary,.nav-footer{gap:4px}
.nav-button,.profile-button{border-radius:50%}
.nav-button.is-selected:before{display:none}
.nav-button.is-selected{background:#353636}
.nav-footer{gap:4px}
.profile-button.is-selected{box-shadow:0 0 0 2px var(--accent)}
.drawer{background:var(--surface);border-right:1px solid var(--border)}
.drawer-header{padding:0 20px;border-bottom:0}
.drawer-heading{display:flex;align-items:center;gap:8px}
.drawer-heading h1{font-size:22px;font-weight:700;line-height:28px;letter-spacing:-.02em}
.drawer-heading span{margin-left:auto}
.drawer-actions{display:flex;align-items:center;gap:16px}
.unavailable-action:disabled{cursor:default;opacity:.82}
.search-region{padding:2px 20px 8px}
.search-box{height:40px;gap:8px;border-radius:9999px;background:#2d2f2f;padding:0 16px}
.search-box .icon{width:24px;height:24px}
.search-box input{color:var(--text);font-size:14px}
.filter-region{display:flex;gap:8px;padding:2px 20px 13px;overflow-x:auto;scrollbar-width:none}
.filter-region[hidden]{display:none}
.filter-chip{height:32px;padding:0 12px;border:1px solid var(--border);border-radius:9999px;background:transparent;color:var(--muted);font-size:13.3333px;line-height:20px;white-space:nowrap}
.filter-chip:hover:not(:disabled){background:var(--surface-hover)}
.filter-chip.is-selected{border-color:#145f43;background:#103e2f;color:#d9fdd3}
.filter-chip:disabled{cursor:default;opacity:.42}
.drawer-body{padding:0 8px 10px}
.list-row{width:100%;min-height:76px;padding:8px 12px;border:0;border-radius:0;gap:12px}
.list-row:hover{background:var(--surface-hover);border-radius:12px}
.list-row.is-selected{background:#2d2f2f;border-radius:12px}
.row-avatar{width:52px;flex-basis:52px}
.row-avatar .avatar{width:48px;height:48px}
.row-line strong{font-size:16px;font-weight:400;line-height:24px}
.row-time{font-size:12px;line-height:16px}
.chat-row .row-preview,.chat-row .row-context{display:block}
.row-preview{font-size:14px;line-height:20px}
.row-context{margin:0;color:var(--muted);font-size:14px;line-height:18px}
.chat-row.has-community{min-height:95px}
.avatar{background:#0b3e3e;color:#5cd8cb}
.avatar-stack{height:50px}
.avatar-stack .avatar:first-child{width:36px;height:36px;background:#0b4b4b;color:#4fd5ca}
.avatar-stack .avatar:last-child{width:34px;height:34px;border-color:var(--surface)}
.list-row.is-selected .avatar-stack .avatar:last-child{border-color:#2d2f2f}
.chat-row:not(.is-selected):hover .avatar-stack .avatar:last-child{border-color:var(--surface-hover)}
.community-root{width:100%;min-height:76px;display:flex;align-items:center;gap:12px;padding:8px 12px;border-radius:12px;background:transparent;text-align:left}
.community-root:hover,.community-root.is-selected{background:#2d2f2f}
.community-root .chevron{width:20px;height:20px;transition:transform 150ms ease}
.community-root .row-main>strong,.community-root .row-main>.row-preview,.community-children .row-main>strong,.community-children .row-main>.row-preview,.community-detail-group .row-main>strong,.community-detail-group .row-main>.row-context{display:block}
.community-root .row-main>strong,.community-children .row-main>strong,.community-detail-group .row-main>strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px}
.community-root.is-collapsed .chevron{transform:rotate(-90deg)}
.community-children{padding:0 0 8px 16px}
.community-children .list-row{min-height:68px}
.community-children .row-avatar,.community-children .row-avatar .avatar{width:44px;height:44px;flex-basis:44px}
.community-children .avatar-stack{height:46px}
.community-children .avatar-stack .avatar:first-child{width:33px;height:33px}
.community-children .avatar-stack .avatar:last-child{width:31px;height:31px}
.community-divider{height:1px;margin:8px 12px;background:var(--border)}
.community-show-all{padding:6px 12px 10px 68px;color:var(--accent);font-weight:600}
.community-detail-group{width:100%;display:flex;align-items:center;gap:12px;padding:12px 0;background:transparent;border-top:1px solid var(--border);text-align:left}
.community-detail-group:first-of-type{border-top:0}
.community-detail-group:hover strong{color:var(--accent)}
.content-shell{background:var(--wallpaper)}
.content-header{padding:8px 14px;background:var(--surface-2)}
.conversation-heading strong{font-size:16px;font-weight:600}
.conversation-heading span{font-size:12px}
.header-actions{display:flex;align-items:center;gap:2px}
.header-account{display:none}
.content-body{background:var(--wallpaper)}
.messages-background{position:relative;isolation:isolate;min-height:100%;padding:22px clamp(18px,6.4vw,96px) 18px;background:var(--wallpaper);background-image:none}
.messages-background:before{content:"";position:absolute;inset:0;z-index:-1;background:var(--wallpaper-foreground);-webkit-mask-image:var(--wallpaper-pattern);mask-image:var(--wallpaper-pattern);-webkit-mask-repeat:repeat;mask-repeat:repeat;-webkit-mask-size:180px 180px;mask-size:180px 180px;pointer-events:none}
.message-list{max-width:1000px;gap:2px}
.date-chip,.system-message{padding:5px 10px;background:#202223;color:rgba(255,255,255,.62);font-size:12px;box-shadow:0 1px 1px rgba(0,0,0,.3)}
.system-message{max-width:560px}
.message-row{position:relative;margin:0}
.message-row.group-start{margin-top:8px}
.bubble{max-width:min(68%,540px);min-width:66px;padding:6px 7px 5px 9px;border-radius:7.5px;box-shadow:rgba(11,20,26,.13) 0 1px .5px}
.message-row.group-start .bubble:before{content:"";position:absolute;top:0;width:0;height:0;border-style:solid}
.message-row.group-start:not(.is-outgoing) .bubble:before{left:-8px;border-width:0 10px 10px 0;border-color:transparent var(--incoming) transparent transparent}
.message-row.group-start.is-outgoing .bubble:before{right:-8px;border-width:0 0 10px 10px;border-color:transparent transparent transparent var(--outgoing)}
.sender-name{font-size:12.5px}
.message-text{font-size:14px;line-height:20px}
.message-meta{float:right;min-height:15px;margin:3px 0 0 8px}
.bubble.is-media-only{padding:3px}
.bubble.is-media-only .message-meta{position:absolute;right:8px;bottom:6px;padding:2px 5px;border-radius:9px;background:rgba(0,0,0,.45);color:#fff}
.attachment{min-width:220px;max-width:420px;margin:0 0 4px}
.attachment img,.attachment video{max-height:430px;object-fit:cover}
.readonly-composer{height:64px;flex-basis:64px;justify-content:flex-start;gap:14px;padding:8px 16px;background:var(--surface-2);border-top:0;color:var(--muted)}
.composer-icon{font-size:32px;font-weight:300;line-height:1}
.composer-emoji,.composer-mic{flex:0 0 24px}
.composer-field{height:44px;display:flex;min-width:0;flex:1;align-items:center;padding:0 16px;border-radius:22px;background:var(--composer);color:var(--faint)}
.detail-panel{width:420px;flex-basis:420px}
.detail-header{padding:8px 10px}
.detail-header h2{font-size:16px}
.profile-hero{padding:28px 24px 22px;background:var(--surface-2)}
.profile-hero .avatar{width:116px;height:116px}
.profile-hero h2{font-size:24px}
.profile-actions{display:flex;justify-content:center;gap:26px;padding:18px 12px;border-bottom:1px solid var(--border)}
.profile-action{display:grid;gap:6px;justify-items:center;color:var(--muted);font-size:12px}
.profile-action .icon-button{background:#303232;color:var(--text)}
.info-section{padding:18px 20px}
.info-section h3{text-transform:none;letter-spacing:0}
.media-grid{gap:3px}
.feature-view{background:var(--surface);padding:36px clamp(28px,7vw,100px)}
.feature-card{border:0;background:var(--surface-2)}
.channel-feed{max-width:720px;padding-top:18px}
.channel-card{border-radius:8px;background:#242626}
.channel-card-copy{padding:12px 14px}
.channel-unread{min-width:22px;height:22px;display:grid;place-items:center;border-radius:11px;background:var(--accent);color:#071d13;font-size:11px;font-weight:700}
.media-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:4px;padding:16px}
.media-gallery .media-tile{aspect-ratio:1;border-radius:2px}
.media-gallery-empty{grid-column:1/-1}
.content-view{position:relative}
.search-section-title{padding:13px 12px 7px;color:var(--accent);font-size:12px;font-weight:650}
.search-result-row .row-preview{white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-height:18px}
.search-result-row .row-context{color:var(--muted)}
.search-load-more{display:block;width:calc(100% - 24px);min-height:40px;margin:8px 12px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--accent);font-weight:600}
.search-load-more:hover{background:var(--surface-hover)}
.message-row.is-highlighted .bubble,.system-message.is-highlighted,.channel-card.is-highlighted{outline:2px solid var(--accent);outline-offset:3px}
.floating-date{position:absolute;z-index:7;top:74px;left:50%;padding:5px 10px;border-radius:7px;background:#202223;color:rgba(255,255,255,.72);box-shadow:0 1px 2px rgba(0,0,0,.35);font-size:12px;pointer-events:none;transform:translateX(-50%);opacity:0;transition:opacity 150ms ease}
.floating-date.is-visible{opacity:1}
.detail-search-tools{display:grid;grid-template-columns:40px minmax(0,1fr);align-items:center;gap:8px;padding:12px 14px}
.detail-date-picker-wrap{position:relative;width:40px;height:40px}
.detail-date-picker{width:40px;height:40px;display:grid;place-items:center;padding:0;border-radius:50%;background:transparent;color:var(--muted)}
.detail-date-picker:hover,.detail-date-picker[aria-expanded="true"]{background:var(--surface-hover);color:var(--text)}
.detail-date-picker:disabled{cursor:default;opacity:.35}
.detail-search-box{height:40px;display:flex;align-items:center;gap:10px;padding:0 14px;border-radius:20px;background:var(--surface-3);color:var(--muted)}
.detail-search-box .icon{width:19px;height:19px}
.detail-search-box input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:var(--text)}
.detail-results{padding:0 10px 18px}
.detail-empty{margin:44px 18px;color:var(--muted);text-align:center}
.detail-search-summary{margin:0;padding:8px 10px;color:var(--muted);font-size:12px}
.detail-result{width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:11px 12px;border-radius:8px;background:transparent;text-align:left}
.detail-result:hover{background:var(--surface-hover)}
.detail-result strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.detail-result time{color:var(--muted);font-size:11px}
.detail-result span{grid-column:1/-1;overflow:hidden;color:var(--muted);font-size:13px;line-height:18px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.date-picker-popover{position:absolute;z-index:30;top:48px;left:-2px;width:316px;padding:10px 12px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);box-shadow:0 10px 28px rgba(0,0,0,.38)}
.date-picker-header{min-height:38px;display:flex;align-items:center;justify-content:space-between;padding:0 2px 5px 6px}
.date-picker-title{display:flex;min-width:0;flex-direction:column;gap:1px}
.date-picker-title h3{margin:0;font-size:14px}
.date-picker-title small{color:var(--muted);font-size:10px}
.date-picker-navigation{display:flex;gap:4px}
.date-picker-nav-button{width:32px;height:32px;display:grid;place-items:center;padding:0;border-radius:50%;background:transparent;color:var(--muted)}
.date-picker-nav-button:hover:not(:disabled){background:var(--surface-hover);color:var(--text)}
.date-picker-nav-button:disabled{opacity:.25;cursor:default}
.date-picker-nav-button .icon{width:18px;height:18px}
.date-picker-weekdays,.date-picker-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}
.date-picker-weekdays span{height:30px;display:grid;place-items:center;color:var(--muted);font-size:11px}
.date-picker-day{position:relative;width:34px;height:34px;display:grid;place-self:center;place-items:center;padding:0;border-radius:50%;background:transparent;color:var(--text);font-size:12px}
.date-picker-day:hover:not(:disabled){background:var(--surface-hover)}
.date-picker-day.is-outside-month{color:var(--faint)}
.date-picker-day.is-selected{background:var(--accent);color:#06170d;font-weight:650}
.date-picker-day:disabled{opacity:.28;cursor:default}
.date-picker-day.has-messages:not(.is-selected):after{content:"";position:absolute;bottom:3px;width:3px;height:3px;border-radius:50%;background:var(--accent)}
.attachment{position:relative}
.attachment-preview-button{position:absolute;z-index:2;right:7px;top:7px;width:34px;height:34px;display:grid;place-items:center;padding:0;border-radius:50%;background:rgba(20,22,22,.76);color:#fff;opacity:0;transition:opacity 150ms ease}
.attachment:hover .attachment-preview-button,.attachment-preview-button:focus-visible{opacity:1}
.attachment-preview-button .icon{width:18px;height:18px}
.media-dialog{position:relative;width:100vw;max-width:none;height:100dvh;max-height:none;margin:0;padding:0;border:0;border-radius:0;background:#151616;color:var(--text);box-shadow:none}
.media-dialog::backdrop{background:rgba(0,0,0,.82)}
.media-dialog-header{position:relative;z-index:5;height:76px;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:10px 14px 10px 24px;background:#191b1b;border-bottom:1px solid rgba(255,255,255,.08)}
.media-identity{min-width:0;display:flex;align-items:center;gap:12px}
.media-sender-avatar-slot{flex:0 0 auto}.media-sender-avatar{width:48px;height:48px;background:#45331f;color:#ffd279;font-size:16px}
.media-identity-copy{min-width:0}.media-identity-copy strong,.media-identity-copy time{display:block;max-width:min(54vw,720px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.media-identity-copy strong{font-size:15px;font-weight:650}.media-identity-copy time{margin-top:1px;color:var(--muted);font-size:13px}
.media-actions{display:flex;align-items:center;gap:2px}.media-actions .icon-button{color:#f5f5f5}.media-actions button:disabled{opacity:.28;cursor:default}
.media-dialog-body{height:calc(100dvh - 196px);display:grid;place-items:center;padding:18px 88px;overflow:hidden}
.media-dialog-body img,.media-dialog-body video{display:block;max-width:min(calc(100vw - 176px),1320px);max-height:calc(100dvh - 232px);object-fit:contain;box-shadow:0 14px 50px rgba(0,0,0,.42)}
.media-dialog-body audio{width:min(620px,90%)}
.media-dialog-nav{position:fixed;z-index:4;top:calc(50% - 22px);width:52px;height:52px;display:grid;place-items:center;padding:0;border:0;border-radius:50%;background:rgba(9,10,10,.72);color:#fff;transform:translateY(-50%)}
.media-dialog-nav.is-previous{left:20px}.media-dialog-nav.is-next{right:20px}
.media-dialog-nav:hover:not(:disabled){background:#222626}
.media-dialog-nav:disabled{opacity:.24;cursor:default}
.media-dialog-nav[hidden]{display:none}
.media-filmstrip{height:120px;display:flex;align-items:center;justify-content:center;padding:10px 20px 12px;border-top:1px solid rgba(255,255,255,.08);background:#151616}
.media-filmstrip-track{max-width:calc(100vw - 80px);display:flex;align-items:center;gap:7px;padding:2px;overflow-x:auto;scrollbar-width:thin;scrollbar-color:var(--scroll) transparent}
.media-filmstrip-item{position:relative;width:76px;height:88px;flex:0 0 76px;display:grid;place-items:center;padding:4px;border:3px solid transparent;background:#202222;color:var(--muted);overflow:hidden}
.media-filmstrip-item:hover{background:#292b2b}.media-filmstrip-item.is-selected{border-color:var(--accent);background:#232626}.media-filmstrip-item img,.media-filmstrip-item video{width:100%;height:100%;object-fit:cover}.media-filmstrip-item .icon{width:28px;height:28px}.media-filmstrip-item .media-kind-badge{position:absolute;right:6px;bottom:6px;width:23px;height:23px;display:grid;place-items:center;border-radius:50%;background:rgba(10,11,11,.78);color:#fff}.media-filmstrip-item .media-kind-badge .icon{width:14px;height:14px}
.media-error{display:grid;max-width:420px;place-items:center;gap:10px;color:var(--warning);text-align:center}
.media-error .icon{width:48px;height:48px}
.media-actions a[aria-disabled="true"]{pointer-events:none;opacity:.35}
.library-dialog{width:min(1120px,calc(100vw - 64px));height:min(760px,calc(100dvh - 64px));max-width:none;max-height:none;margin:auto;padding:0;border:1px solid var(--border);border-radius:12px;background:var(--surface-2);color:var(--text);box-shadow:0 24px 72px rgba(0,0,0,.48)}
.library-dialog::backdrop{background:rgba(0,0,0,.76)}
.library-dialog-shell{height:100%;display:grid;grid-template-rows:76px 56px minmax(0,1fr);overflow:hidden}
.library-dialog-header{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 16px 12px 22px;border-bottom:1px solid var(--border)}
.library-heading{min-width:0}
.library-heading strong,.library-heading span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.library-heading strong{font-size:19px;font-weight:650}
.library-heading span{margin-top:2px;color:var(--muted);font-size:12px}
.library-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-bottom:1px solid var(--border)}
.library-tab{position:relative;display:flex;align-items:center;justify-content:center;gap:7px;padding:0 18px;background:transparent;color:var(--muted);font-size:15px;font-weight:600}
.library-tab:hover{background:var(--surface-hover);color:var(--text)}
.library-tab.is-selected{color:var(--text)}
.library-tab.is-selected:after{content:"";position:absolute;right:25%;bottom:0;left:25%;height:3px;background:var(--accent)}
.library-tab span{min-width:20px;color:var(--faint);font-size:11px;font-variant-numeric:tabular-nums}
.library-dialog-body{min-height:0;overflow:auto;padding:20px 22px 28px;scrollbar-color:var(--scroll) transparent}
.library-empty{min-height:100%;display:grid;place-content:center;justify-items:center;gap:9px;color:var(--muted);text-align:center}
.library-empty .icon{width:46px;height:46px;color:var(--faint)}
.library-empty strong{color:var(--text);font-size:17px}
.library-media-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.library-media-item{min-width:0;background:var(--surface-3);border:1px solid var(--border)}
.library-media-preview{width:100%;aspect-ratio:1;display:grid;place-items:center;padding:0;overflow:hidden;background:#101111;color:var(--muted)}
.library-media-preview:hover{filter:brightness(1.06)}
.library-media-preview img,.library-media-preview video{width:100%;height:100%;object-fit:cover}
.library-media-preview .icon{width:44px;height:44px}
.library-media-caption{display:grid;gap:3px;padding:9px 10px 10px}
.library-file-name,.library-source-button{min-width:0;padding:0;background:transparent;color:var(--text);text-align:left;text-decoration:none}
.library-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}
.library-file-name:hover,.library-source-button:hover{color:var(--accent);text-decoration:underline}
.library-item-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:11px}
.library-list{display:grid}
.library-list-row{min-width:0;display:grid;grid-template-columns:44px minmax(0,1fr) 40px;align-items:center;gap:12px;min-height:76px;padding:11px 8px;border-bottom:1px solid var(--border)}
.library-list-row:first-child{border-top:1px solid var(--border)}
.library-list-icon{width:44px;height:44px;display:grid;place-items:center;background:var(--surface-3);color:var(--accent)}
.library-list-icon .icon{width:23px;height:23px}
.library-list-copy{min-width:0;display:grid;gap:4px}
.library-source-button{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600}
.library-link-url{overflow-wrap:anywhere;white-space:normal}
.library-download{width:38px;height:38px;display:grid;place-items:center;color:var(--muted);text-decoration:none}
.library-download:hover{background:var(--surface-hover);color:var(--text)}
.library-download .icon{width:20px;height:20px}
.library-download[aria-disabled="true"]{pointer-events:none;opacity:.3}

@media(max-width:1260px){
  .detail-panel{position:absolute;right:0;top:0;bottom:0;width:420px;box-shadow:-12px 0 28px rgba(0,0,0,.35)}
  .library-media-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media(max-width:900px){
  :root{--drawer:371px}
  .bubble{max-width:82%}
}
@media(max-width:760px){
  :root{--nav:56px;--drawer:320px}
  .nav-rail{padding-left:8px;padding-right:8px}
  .drawer-header{padding:0 12px}
  .search-region,.filter-region{padding-left:12px;padding-right:12px}
  .messages-background{padding-left:16px;padding-right:16px}
  .bubble{max-width:90%}
  .date-picker-popover{left:0;width:min(316px,calc(100vw - 28px))}
  .media-dialog-header{padding-left:14px}.media-sender-avatar{width:42px;height:42px}.media-identity-copy strong{font-size:14px}.media-identity-copy time{font-size:11px}
  .media-dialog-body{padding:12px 54px}
  .media-dialog-body img,.media-dialog-body video{max-width:calc(100vw - 108px)}
  .media-dialog-nav{width:44px;height:44px}
  .media-dialog-nav.is-previous{left:5px}.media-dialog-nav.is-next{right:5px}
  .media-filmstrip{padding-left:8px;padding-right:8px}.media-filmstrip-track{max-width:calc(100vw - 16px)}.media-filmstrip-item{width:68px;height:80px;flex-basis:68px}
  .library-dialog{width:calc(100vw - 24px);height:calc(100dvh - 24px)}
  .library-dialog-shell{grid-template-rows:68px 52px minmax(0,1fr)}
  .library-dialog-header{padding-left:16px}
  .library-heading strong{font-size:16px}
  .library-dialog-body{padding:12px}
  .library-media-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .library-tab{padding:0 8px;font-size:13px}
}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
`;

const OFFLINE_PREVIEW_RUNTIME = String.raw`
"use strict";
(function(){
  const model = JSON.parse(document.getElementById("offline-data").textContent || "{}");
  const assetIndex = new Map((model.assets || []).map(function(asset){ return [asset.assetId, asset]; }));
  const assetUrls = new Map();
  const state = {
    section: "chats",
    selectedChatId: model.conversations[0] ? model.conversations[0].id : null,
    selectedChannelId: model.channels[0] ? model.channels[0].id : null,
    selectedCommunityId: model.communities[0] ? model.communities[0].id : null,
    selectedCommunityChatId: null,
    expandedCommunities: new Set(model.communities.map(function(community){ return community.id; })),
    chatFilter: "all",
    search: "",
    searchLimit: 50,
    pendingMessageId: null,
    detailChatId: null,
    closeDatePicker: null,
    highlightTimer: 0,
    floatingDateTimer: 0,
    floatingDateReady: false,
    libraryTab: "media",
    dialogItems: [],
    dialogIndex: -1
  };
  const drawerTitle = document.getElementById("drawerTitle");
  const drawerCount = document.getElementById("drawerCount");
  const drawerBody = document.getElementById("drawerBody");
  const searchRegion = document.getElementById("searchRegion");
  const filterRegion = document.getElementById("filterRegion");
  const drawerSearch = document.getElementById("drawerSearch");
  const welcomeView = document.getElementById("welcomeView");
  const contentView = document.getElementById("contentView");
  const contentHeader = document.getElementById("contentHeader");
  const contentBody = document.getElementById("contentBody");
  const floatingDate = document.getElementById("floatingDate");
  const readonlyComposer = document.getElementById("readonlyComposer");
  const detailPanel = document.getElementById("detailPanel");
  const detailBody = document.getElementById("detailBody");
  const detailPanelTitle = document.getElementById("detailPanelTitle");
  const libraryOpen = document.getElementById("libraryOpen");
  const libraryDialog = document.getElementById("libraryDialog");
  const libraryDialogBody = document.getElementById("libraryDialogBody");
  const mediaDialog = document.getElementById("mediaDialog");
  const mediaDialogBody = document.getElementById("mediaDialogBody");
  const mediaSenderAvatarSlot = document.getElementById("mediaSenderAvatarSlot");
  const mediaSenderName = document.getElementById("mediaSenderName");
  const mediaSentAt = document.getElementById("mediaSentAt");
  const mediaJumpToMessage = document.getElementById("mediaJumpToMessage");
  const mediaFilmstrip = document.getElementById("mediaFilmstrip");
  const mediaFilmstripTrack = document.getElementById("mediaFilmstripTrack");
  const mediaPrevious = document.getElementById("mediaPrevious");
  const mediaNext = document.getElementById("mediaNext");
  const accountName = model.account.displayName || model.account.formattedPhoneNumber || model.source.specimenName || "WhatsApp 账号";
  const accountChat = model.conversations.find(function(chat){ return chat.id === model.account.nativeId; });
  const accountAvatarAssetId = accountChat ? accountChat.avatarAssetId : null;

  function element(tag, className, text){
    const node = document.createElement(tag);
    if(className) node.className = className;
    if(text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function svgIcon(name, className){
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", className || "icon");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#icon-" + name);
    svg.append(use);
    return svg;
  }
  function initials(value){
    const clean = String(value || "?").trim();
    return Array.from(clean).slice(0, 2).join("").toLocaleUpperCase();
  }
  function assetUrl(assetId){
    if(!assetId || !assetIndex.has(assetId)) return null;
    if(assetUrls.has(assetId)) return assetUrls.get(assetId);
    const source = document.getElementById("offline-asset-" + assetId);
    if(!source) return null;
    const encoded = (source.textContent || "").trim();
    if(!encoded) return null;
    const chunks = [];
    const step = 4 * 1024 * 1024;
    for(let offset = 0; offset < encoded.length; offset += step){
      const binary = atob(encoded.slice(offset, offset + step));
      const bytes = new Uint8Array(binary.length);
      for(let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      chunks.push(bytes);
    }
    const metadata = assetIndex.get(assetId);
    const url = URL.createObjectURL(new Blob(chunks, { type: metadata.mimeType || "application/octet-stream" }));
    assetUrls.set(assetId, url);
    return url;
  }
  function avatar(title, assetId, className){
    const node = element("span", "avatar" + (className ? " " + className : ""));
    const url = assetUrl(assetId);
    if(url){
      const image = document.createElement("img");
      image.src = url;
      image.alt = "";
      image.addEventListener("error", function(){
        node.replaceChildren();
        node.textContent = initials(title);
      }, { once:true });
      node.append(image);
    }else{
      node.textContent = initials(title);
    }
    return node;
  }
  const displayTimeZone = typeof model.displayTimeZone === "string" && model.displayTimeZone ? model.displayTimeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  function formatInDisplayTimeZone(date, options){
    try{
      return new Intl.DateTimeFormat("zh-CN", Object.assign({ timeZone:displayTimeZone }, options)).format(date);
    }catch(_error){
      return new Intl.DateTimeFormat("zh-CN", options).format(date);
    }
  }
  function localUtcOffset(date){
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absoluteMinutes = Math.abs(offsetMinutes);
    return "UTC" + sign + String(Math.floor(absoluteMinutes / 60)).padStart(2,"0") + ":" + String(absoluteMinutes % 60).padStart(2,"0");
  }
  function formatUtcOffset(value){
    if(!value) return "";
    const date = value instanceof Date ? value : new Date(value);
    if(Number.isNaN(date.getTime())) return "";
    try{
      const parts = new Intl.DateTimeFormat("en-US", { timeZone:displayTimeZone, timeZoneName:"longOffset", hour:"2-digit" }).formatToParts(date);
      const raw = (parts.find(function(part){ return part.type === "timeZoneName"; }) || {}).value || "";
      const normalized = raw.replace(/^GMT/u,"UTC");
      if(normalized === "UTC") return "UTC+00:00";
      if(/^UTC[+-]\d{2}:\d{2}$/u.test(normalized)) return normalized;
    }catch(_error){
      // Fall back to the browser's local UTC offset below.
    }
    return localUtcOffset(date);
  }
  function formatTimePart(value){
    if(!value) return "";
    const date = new Date(value);
    if(Number.isNaN(date.getTime())) return "";
    return formatInDisplayTimeZone(date, { hour:"2-digit", minute:"2-digit", hourCycle:"h23" });
  }
  function formatDatePart(value, longForm){
    if(!value) return "";
    const date = new Date(value);
    if(Number.isNaN(date.getTime())) return "";
    return formatInDisplayTimeZone(date, longForm ? { year:"numeric", month:"long", day:"numeric" } : { year:"numeric", month:"2-digit", day:"2-digit" });
  }
  function formatTime(value){
    const time = formatTimePart(value);
    return time ? time + " " + formatUtcOffset(value) : "";
  }
  function formatDate(value, longForm){
    const date = formatDatePart(value, longForm);
    return date ? date + " · " + formatUtcOffset(value) : "";
  }
  function formatDateTime(value, longForm){
    if(!value) return "";
    const date = new Date(value);
    if(Number.isNaN(date.getTime())) return "";
    const formatted = formatInDisplayTimeZone(date, {
      year:"numeric", month:longForm ? "long" : "2-digit", day:"2-digit",
      hour:"2-digit", minute:"2-digit", second:"2-digit", hourCycle:"h23"
    });
    return formatted + " " + formatUtcOffset(date);
  }
  function formatBytes(value){
    if(value === null || value === undefined || !Number.isFinite(value)) return "";
    if(value < 1024) return value + " B";
    if(value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
    if(value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + " MB";
    return (value / 1024 / 1024 / 1024).toFixed(1) + " GB";
  }
  function dateKey(value){
    if(!value) return "未知日期";
    const date = new Date(value);
    if(Number.isNaN(date.getTime())) return "未知日期";
    try{
      const parts = new Intl.DateTimeFormat("en-US", { timeZone:displayTimeZone, year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(date);
      const valueOf = function(type){ return (parts.find(function(part){ return part.type === type; }) || {}).value || ""; };
      const year = valueOf("year");
      const month = valueOf("month");
      const day = valueOf("day");
      if(year && month && day) return year + "-" + month + "-" + day;
    }catch(_error){
      // Fall back to the browser's local calendar date below.
    }
    return date.getFullYear() + "-" + String(date.getMonth()+1).padStart(2,"0") + "-" + String(date.getDate()).padStart(2,"0");
  }
  function formatSearchDate(value){
    if(!value) return "未知日期";
    return formatDate(value, false) || "未知日期";
  }
  function formatMediaTimestamp(value){
    return formatDateTime(value, true) || "发送时间未知";
  }
  function messageSearchText(message){
    if(!message) return "";
    const parts = [message.text, message.caption, message.senderDisplayName, message.type];
    (message.attachments || []).forEach(function(attachment){ parts.push(attachment.fileName, attachment.mimeType); });
    const text = parts.filter(Boolean).join(" ").trim();
    return text || "消息";
  }
  function messageResultPreview(message){
    if(!message) return "消息";
    if(message.isRevoked) return "此消息已撤回";
    const text = [message.text, message.caption].filter(Boolean).join(" ").trim();
    if(text) return text;
    const files = (message.attachments || []).map(function(attachment){ return attachment.fileName; }).filter(Boolean).join("，");
    if(files) return files;
    const labels = { image:"图片", video:"视频", audio:"音频", ptt:"语音消息", document:"文档", sticker:"贴纸", location:"位置", contact:"联系人", gp2:"群组事件", e2e_notification:"系统通知" };
    return labels[String(message.type || "").toLocaleLowerCase()] || "消息";
  }
  function matchesQuery(value, query){
    const normalized = String(value || "").toLocaleLowerCase("zh-CN");
    return String(query || "").trim().toLocaleLowerCase("zh-CN").split(/\s+/u).filter(Boolean).every(function(term){ return normalized.includes(term); });
  }
  function cssEscape(value){
    if(window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/gu, function(character){ return "\\" + character; });
  }
  function chatById(chatId){ return model.conversations.find(function(chat){ return chat.id === chatId; }) || null; }
  function timestampValue(value){
    const timestamp = value ? new Date(value).getTime() : Number.NaN;
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  function isSystemMessage(message){
    return /^(gp2|e2e|e2e_notification|notification|system)$/iu.test(String(message.type || ""));
  }
  function isGroup(chat){
    return String(chat.kind || "").toLocaleLowerCase().includes("group") || String(chat.id || "").endsWith("@g.us");
  }
  function rowAvatar(item){
    const wrap = element("span", "row-avatar");
    if(item.community && item.community.role === "group"){
      wrap.classList.add("avatar-stack");
      wrap.append(avatar(item.community.title, item.community.avatarAssetId));
      wrap.append(avatar(item.title, item.avatarAssetId));
    }else if(item.community && item.community.role === "announcement"){
      wrap.append(avatar(item.community.title, item.community.avatarAssetId));
    }else{
      wrap.append(avatar(item.title, item.avatarAssetId));
    }
    return wrap;
  }
  function setAccountAvatars(){
    const nodes = [document.getElementById("profileRailAvatar")];
    nodes.forEach(function(node){
      if(!node) return;
      node.replaceChildren();
      const built = avatar(accountName, accountAvatarAssetId);
      while(built.firstChild) node.append(built.firstChild);
      if(!node.firstChild) node.textContent = initials(accountName);
    });
  }
  function setSection(section){
    state.section = section;
    state.search = "";
    state.searchLimit = 50;
    state.pendingMessageId = null;
    drawerSearch.value = "";
    document.querySelectorAll(".nav-button[data-section],.profile-button[data-section]").forEach(function(button){ button.classList.toggle("is-selected", button.dataset.section === section); });
    closeDetail();
    hideFloatingDate(true);
    renderDrawer();
    renderMain();
  }
  function sectionInfo(){
    if(state.section === "chats") return { title:"WhatsApp", count:0, searchable:true, filterable:true, placeholder:"搜索或开始新聊天" };
    if(state.section === "calls") return { title:"通话", count:model.calls.length, searchable:false };
    if(state.section === "statuses") return { title:"动态", count:model.statuses.length, searchable:false };
    if(state.section === "channels") return { title:"频道", count:0, searchable:true, placeholder:"搜索" };
    if(state.section === "communities") return { title:"社群", count:0, searchable:false };
    return { title:"账号资料", count:0, searchable:false };
  }
  function renderDrawer(){
    const info = sectionInfo();
    drawerTitle.textContent = info.title;
    drawerCount.textContent = info.count ? info.count + " 个" : "";
    searchRegion.hidden = !info.searchable;
    filterRegion.hidden = !info.filterable;
    if(info.placeholder) drawerSearch.placeholder = info.placeholder;
    drawerBody.replaceChildren();
    if(state.section === "chats") renderChatRows();
    else if(state.section === "calls") renderCallRows();
    else if(state.section === "statuses") renderStatusRows();
    else if(state.section === "channels") renderChannelRows();
    else if(state.section === "communities") renderCommunityRows();
    else renderAccountDrawer();
  }
  function renderChatRows(){
    const rows = model.conversations.filter(function(chat){
      if(state.chatFilter === "starred") return chat.starredMessageCount > 0;
      if(state.chatFilter === "groups") return isGroup(chat);
      return state.chatFilter !== "unread";
    });
    const query = state.search.trim();
    if(!query){
      drawerCount.textContent = "";
      if(!rows.length){ renderDrawerEmpty("没有找到对话"); return; }
      rows.forEach(function(chat){ drawerBody.append(createChatListRow(chat, null)); });
      return;
    }
    const conversationMatches = rows.filter(function(chat){
      return matchesQuery([chat.title, chat.id, chat.community && chat.community.title].filter(Boolean).join(" "), query);
    });
    const messageMatches = [];
    rows.forEach(function(chat){
      chat.messages.forEach(function(message){
        if(matchesQuery(messageSearchText(message), query)) messageMatches.push({ chat:chat, message:message });
      });
    });
    const total = conversationMatches.length + messageMatches.length;
    drawerCount.textContent = total ? total + " 个结果" : "";
    if(!total){ renderDrawerEmpty("未找到匹配的对话或消息"); return; }
    if(conversationMatches.length){
      drawerBody.append(element("div", "search-section-title", "对话"));
      conversationMatches.forEach(function(chat){ drawerBody.append(createChatListRow(chat, null)); });
    }
    if(messageMatches.length){
      const visible = messageMatches.slice(0, state.searchLimit);
      drawerBody.append(element("div", "search-section-title", "消息，显示 " + visible.length + " / " + messageMatches.length));
      visible.forEach(function(match){ drawerBody.append(createChatListRow(match.chat, match.message)); });
      if(visible.length < messageMatches.length){
        const loadMore = element("button", "search-load-more", "加载更多，还剩 " + (messageMatches.length - visible.length) + " 条");
        loadMore.type = "button";
        loadMore.addEventListener("click", function(){ state.searchLimit += 50; renderDrawer(); });
        drawerBody.append(loadMore);
      }
    }
  }
  function createChatListRow(chat, message){
    const hasCommunity = !message && chat.community && chat.community.role === "group";
    const button = element("button", "list-row chat-row" + (hasCommunity ? " has-community" : "") + (message ? " search-result-row" : "") + (!message && chat.id === state.selectedChatId ? " is-selected" : ""));
    button.type = "button";
    button.dataset.chatId = chat.id;
    if(message) button.dataset.messageId = message.id;
    button.append(rowAvatar(chat));
    const main = element("span", "row-main");
    const line = element("span", "row-line");
    line.append(element("strong", "", chat.title));
    line.append(element("span", "row-time", message ? formatSearchDate(message.timestampUtc) : formatDate(chat.lastMessageAtUtc, false)));
    main.append(line);
    if(message){
      const context = [chat.community && chat.community.title, formatTime(message.timestampUtc)].filter(Boolean).join(" · ");
      if(context) main.append(element("span", "row-context", context));
      main.append(element("span", "row-preview", messageResultPreview(message)));
    }else{
      if(chat.community && chat.community.role === "group") main.prepend(element("span", "row-context", chat.community.title));
      main.append(element("span", "row-preview", chat.lastMessagePreview || "暂无消息内容"));
    }
    button.append(main);
    button.addEventListener("click", function(){ openConversation(chat.id, message ? message.id : null); });
    return button;
  }
  function renderCallRows(){
    if(!model.calls.length){ renderDrawerEmpty("没有采集到通话记录"); return; }
    model.calls.forEach(function(call, index){
      const button = featureListRow(call.title, (call.direction === "incoming" ? "呼入" : call.direction === "outgoing" ? "呼出" : "方向未知") + (call.isVideo ? "，视频通话" : "，语音通话"), call.timestampUtc, "calls");
      button.addEventListener("click", function(){ renderCallDetail(call); selectOnly(button); });
      drawerBody.append(button);
      if(index === 0 && !drawerBody.querySelector(".is-selected")){ button.classList.add("is-selected"); }
    });
  }
  function renderStatusRows(){
    if(!model.statuses.length){ renderDrawerEmpty("没有采集到动态记录"); return; }
    model.statuses.forEach(function(status, index){
      const button = featureListRow(status.title, status.preview || status.itemCount + " 条动态", status.timestampUtc, "status");
      button.addEventListener("click", function(){ renderStatusDetail(status); selectOnly(button); });
      drawerBody.append(button);
      if(index === 0) button.classList.add("is-selected");
    });
  }
  function renderChannelRows(){
    const query = state.search.trim().toLocaleLowerCase();
    const rows = model.channels.filter(function(channel){ return !query || channel.title.toLocaleLowerCase().includes(query); });
    if(!rows.length){ renderDrawerEmpty("没有找到频道"); return; }
    rows.forEach(function(channel){
      const button = element("button", "list-row channel-row");
      button.type = "button";
      const iconWrap = element("span", "row-avatar");
      iconWrap.append(avatar(channel.title, channel.avatarAssetId));
      button.append(iconWrap);
      const main = element("span", "row-main");
      const line = element("span", "row-line");
      line.append(element("strong", "", channel.title));
      line.append(element("span", "row-time", formatTime(channel.lastEventAtUtc)));
      const preview = element("span", "row-line");
      preview.append(element("span", "row-preview", channel.lastEventPreview || channel.eventCount + " 条更新"));
      if(channel.unreadCount > 0) preview.append(element("span", "channel-unread", channel.unreadCount));
      main.append(line, preview);
      button.append(main);
      button.classList.toggle("is-selected", channel.id === state.selectedChannelId);
      button.addEventListener("click", function(){ state.selectedChannelId = channel.id; closeDetail(); renderDrawer(); renderMain(); });
      drawerBody.append(button);
    });
  }
  function renderCommunityRows(){
    if(!model.communities.length){ renderDrawerEmpty("没有采集到社群关系"); return; }
    model.communities.forEach(function(community){
      const expanded = state.expandedCommunities.has(community.id);
      const root = element("button", "community-root" + (state.selectedCommunityId === community.id && !state.selectedCommunityChatId ? " is-selected" : "") + (expanded ? "" : " is-collapsed"));
      root.type = "button";
      root.dataset.communityId = community.id;
      const rootAvatar = element("span", "row-avatar");
      const iconAvatar = element("span", "avatar");
      iconAvatar.append(svgIcon("community"));
      rootAvatar.append(iconAvatar);
      const rootMain = element("span", "row-main");
      rootMain.append(element("strong", "", community.title), element("span", "row-preview", community.childGroups.length + " 个群组"));
      root.append(rootAvatar, rootMain, svgIcon("chevron", "icon chevron"));
      root.addEventListener("click", function(){
        state.selectedCommunityId = community.id;
        state.selectedCommunityChatId = null;
        if(state.expandedCommunities.has(community.id)) state.expandedCommunities.delete(community.id); else state.expandedCommunities.add(community.id);
        closeDetail(); renderDrawer(); renderMain();
      });
      drawerBody.append(root);
      if(!expanded) return;
      const children = element("div", "community-children");
      community.childGroups.forEach(function(group){
        const chat = model.conversations.find(function(item){ return item.id === group.id; });
        if(!chat) return;
        const button = element("button", "list-row community-group" + (state.selectedCommunityChatId === group.id ? " is-selected" : ""));
        button.type = "button";
        button.append(rowAvatar(chat));
        const main = element("span", "row-main");
        main.append(element("strong", "", group.role === "announcement" ? community.title : group.title));
        main.append(element("span", "row-preview", group.role === "announcement" ? "社群主对话" : "群组"));
        button.append(main);
        button.addEventListener("click", function(){
          state.selectedCommunityId = community.id;
          state.selectedCommunityChatId = group.id;
          state.selectedChatId = group.id;
          closeDetail(); renderDrawer(); renderMain();
        });
        children.append(button);
      });
      if(children.children.length){
        children.append(element("div", "community-show-all", "查看全部"));
        drawerBody.append(children, element("div", "community-divider"));
      }
    });
  }
  function conversationMedia(chat){
    if(!chat) return [];
    return chat.messages.flatMap(function(message){
      return (message.attachments || []).map(function(attachment){ return { attachment:attachment, chat:chat, channel:null, message:message, ownerTitle:chat.title }; });
    }).filter(isPreviewableMediaEntry);
  }
  function channelMedia(channel){
    if(!channel) return [];
    return channel.messages.flatMap(function(message){
      return (message.attachments || []).map(function(attachment){ return { attachment:attachment, chat:null, channel:channel, message:message, ownerTitle:channel.title }; });
    }).filter(isPreviewableMediaEntry);
  }
  function isPreviewableMediaEntry(entry){
    return entry.attachment.status === "available" && (entry.attachment.kind === "image" || entry.attachment.kind === "video" || entry.attachment.kind === "audio");
  }
  function allMedia(){
    const conversations = model.conversations.flatMap(function(chat){
      return chat.messages.flatMap(function(message){
        return (message.attachments || []).map(function(attachment){ return { attachment:attachment, chat:chat, channel:null, message:message, ownerTitle:chat.title }; });
      });
    });
    const channels = model.channels.flatMap(function(channel){
      return channel.messages.flatMap(function(message){
        return (message.attachments || []).map(function(attachment){ return { attachment:attachment, chat:null, channel:channel, message:message, ownerTitle:channel.title }; });
      });
    });
    return conversations.concat(channels).filter(isPreviewableMediaEntry);
  }
  function originalAttachmentName(attachment){
    const direct = String(attachment && attachment.fileName || "").trim();
    if(direct) return direct;
    const asset = attachment && attachment.assetId ? assetIndex.get(attachment.assetId) : null;
    const embedded = String(asset && asset.fileName || "").trim();
    if(embedded) return embedded;
    if(attachment && attachment.kind === "video") return "视频";
    if(attachment && attachment.kind === "audio") return "音频";
    if(attachment && attachment.kind === "document") return "文档";
    return "图片";
  }
  function linksFromMessage(message){
    const source = [message && message.text, message && message.caption].filter(Boolean).join("\n");
    const matches = source.match(/https?:\/\/[^\s<>"']+/giu) || [];
    const seen = new Set();
    return matches.map(function(value){ return value.replace(/[\])}>，。；;！？!?、]+$/gu, ""); }).filter(function(value){
      if(!value || seen.has(value)) return false;
      seen.add(value); return true;
    });
  }
  function collectLibraryItems(){
    const items = { media:[], documents:[], links:[] };
    function collect(owner, isChannel){
      (owner.messages || []).forEach(function(message){
        const base = { chat:isChannel ? null : owner, channel:isChannel ? owner : null, message:message, ownerTitle:owner.title };
        (message.attachments || []).forEach(function(attachment){
          const entry = Object.assign({ attachment:attachment }, base);
          if(isPreviewableMediaEntry(entry)) items.media.push(entry);
          else if(attachment.kind === "document" || attachment.kind === "other") items.documents.push(entry);
        });
        linksFromMessage(message).forEach(function(url){ items.links.push(Object.assign({ url:url }, base)); });
      });
    }
    model.conversations.forEach(function(chat){ collect(chat, false); });
    model.channels.forEach(function(channel){ collect(channel, true); });
    Object.keys(items).forEach(function(key){ items[key].sort(function(left, right){ return timestampValue(right.message && right.message.timestampUtc) - timestampValue(left.message && left.message.timestampUtc); }); });
    return items;
  }
  function libraryMeta(entry){
    return [entry.ownerTitle, formatDateTime(entry.message && entry.message.timestampUtc, false)].filter(Boolean).join(" · ");
  }
  function jumpToLibrarySource(entry){
    if(!entry || !entry.message) return;
    closeLibraryDialog();
    state.section = entry.channel ? "channels" : "chats";
    state.search = "";
    state.searchLimit = 50;
    state.chatFilter = "all";
    state.pendingMessageId = entry.message.id;
    drawerSearch.value = "";
    if(entry.channel) state.selectedChannelId = entry.channel.id;
    else{
      state.selectedChatId = entry.chat.id;
      state.selectedCommunityChatId = null;
    }
    document.querySelectorAll(".nav-button[data-section],.profile-button[data-section]").forEach(function(button){ button.classList.toggle("is-selected", button.dataset.section === state.section); });
    document.querySelectorAll("[data-chat-filter]").forEach(function(button){ button.classList.toggle("is-selected", button.dataset.chatFilter === "all"); });
    closeDetail();
    hideFloatingDate(true);
    renderDrawer();
    renderMain();
  }
  function renderLibraryEmpty(iconName, title, description){
    const empty = element("div", "library-empty");
    empty.append(svgIcon(iconName), element("strong", "", title), element("span", "", description));
    libraryDialogBody.append(empty);
  }
  function renderLibraryMedia(items){
    if(!items.length){ renderLibraryEmpty("image", "没有影音内容", "该账号没有可在离线预览中显示的图片、视频或音频。"); return; }
    const grid = element("div", "library-media-grid");
    items.forEach(function(entry){
      const attachment = entry.attachment;
      const fileName = originalAttachmentName(attachment);
      const item = element("article", "library-media-item");
      const preview = element("button", "library-media-preview");
      preview.type = "button"; preview.title = "预览 " + fileName; preview.setAttribute("aria-label", "预览 " + fileName);
      const url = assetUrl(attachment.assetId);
      if(url && attachment.kind === "image"){
        const image = document.createElement("img"); image.src = url; image.alt = fileName; image.loading = "lazy"; preview.append(image);
      }else if(url && attachment.kind === "video"){
        const video = document.createElement("video"); video.src = url; video.muted = true; video.preload = "metadata"; preview.append(video);
      }else preview.append(svgIcon(attachment.kind === "video" ? "video" : attachment.kind === "audio" ? "calls" : "image"));
      preview.addEventListener("click", function(){ closeLibraryDialog(); openMedia(attachment, items, entry); });
      const caption = element("div", "library-media-caption");
      const source = element("button", "library-file-name", fileName); source.type = "button"; source.title = "在原对话中定位"; source.dataset.sourceMessageId = entry.message.id; source.addEventListener("click", function(){ jumpToLibrarySource(entry); });
      caption.append(source, element("span", "library-item-meta", libraryMeta(entry)));
      item.append(preview, caption); grid.append(item);
    });
    libraryDialogBody.append(grid);
  }
  function renderLibraryDocuments(items){
    if(!items.length){ renderLibraryEmpty("file", "没有文档", "该账号没有已采集的文档附件。"); return; }
    const list = element("div", "library-list");
    items.forEach(function(entry){
      const attachment = entry.attachment;
      const fileName = originalAttachmentName(attachment);
      const row = element("article", "library-list-row");
      const icon = element("span", "library-list-icon"); icon.append(svgIcon("file"));
      const copy = element("div", "library-list-copy");
      const source = element("button", "library-source-button", fileName); source.type = "button"; source.title = "在原对话中定位"; source.dataset.sourceMessageId = entry.message.id; source.addEventListener("click", function(){ jumpToLibrarySource(entry); });
      copy.append(source, element("span", "library-item-meta", [libraryMeta(entry), attachment.mimeType, formatBytes(attachment.sizeBytes)].filter(Boolean).join(" · ")));
      const download = element("a", "library-download"); download.title = "保存 " + fileName; download.setAttribute("aria-label", "保存 " + fileName); download.append(svgIcon("download"));
      const url = assetUrl(attachment.assetId);
      if(url){ download.href = url; download.download = fileName; } else{ download.setAttribute("aria-disabled", "true"); download.tabIndex = -1; }
      row.append(icon, copy, download); list.append(row);
    });
    libraryDialogBody.append(list);
  }
  function renderLibraryLinks(items){
    if(!items.length){ renderLibraryEmpty("link", "没有链接", "已采集的消息正文中没有链接。"); return; }
    const list = element("div", "library-list");
    items.forEach(function(entry){
      const row = element("article", "library-list-row");
      const icon = element("span", "library-list-icon"); icon.append(svgIcon("link"));
      const copy = element("div", "library-list-copy");
      const source = element("button", "library-source-button library-link-url", entry.url); source.type = "button"; source.title = "在原对话中定位"; source.dataset.sourceMessageId = entry.message.id; source.addEventListener("click", function(){ jumpToLibrarySource(entry); });
      copy.append(source, element("span", "library-item-meta", libraryMeta(entry)));
      row.append(icon, copy, element("span", "library-download")); list.append(row);
    });
    libraryDialogBody.append(list);
  }
  function renderLibraryDialog(){
    const items = collectLibraryItems();
    document.querySelectorAll("[data-library-tab]").forEach(function(button){
      const selected = button.dataset.libraryTab === state.libraryTab;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
      const count = button.querySelector("[data-library-count]"); if(count) count.textContent = String(items[button.dataset.libraryTab].length);
    });
    libraryDialogBody.setAttribute("aria-labelledby", "libraryTab-" + state.libraryTab);
    libraryDialogBody.replaceChildren();
    if(state.libraryTab === "documents") renderLibraryDocuments(items.documents);
    else if(state.libraryTab === "links") renderLibraryLinks(items.links);
    else renderLibraryMedia(items.media);
  }
  function openLibraryDialog(){
    state.libraryTab = "media";
    renderLibraryDialog();
    if(!libraryDialog.open) libraryDialog.showModal();
    requestAnimationFrame(function(){ document.getElementById("libraryTab-media").focus({ preventScroll:true }); });
  }
  function closeLibraryDialog(){
    if(!libraryDialog.open) return;
    libraryDialogBody.replaceChildren();
    libraryDialog.close();
  }
  function renderAccountDrawer(){
    const card = element("div", "feature-card account-card");
    const hero = element("div", "feature-hero");
    hero.append(avatar(accountName, accountAvatarAssetId));
    const copy = element("div");
    copy.append(element("h2", "", accountName));
    copy.append(element("p", "", model.account.formattedPhoneNumber || model.source.specimenName));
    hero.append(copy);
    card.append(hero);
    drawerBody.append(card);
  }
  function featureListRow(title, preview, timestamp, iconName){
    const button = element("button", "list-row");
    button.type = "button";
    const iconWrap = element("span", "row-avatar");
    const avatarNode = element("span", "avatar");
    avatarNode.append(svgIcon(iconName === "calls" ? "calls" : iconName === "status" ? "status" : iconName === "channel" ? "channel" : "community"));
    iconWrap.append(avatarNode);
    button.append(iconWrap);
    const main = element("span", "row-main");
    const line = element("span", "row-line");
    line.append(element("strong", "", title));
    line.append(element("span", "row-time", formatDate(timestamp, false)));
    main.append(line, element("span", "row-preview", preview));
    button.append(main);
    return button;
  }
  function selectOnly(button){ drawerBody.querySelectorAll(".list-row").forEach(function(row){ row.classList.toggle("is-selected", row === button); }); }
  function renderDrawerEmpty(text){ const empty = element("div", "empty-view"); empty.append(svgIcon("search"), element("h3", "", text)); drawerBody.append(empty); }
  function openConversation(chatId, messageId){
    state.selectedChatId = chatId;
    state.pendingMessageId = messageId || null;
    closeDetail();
    renderDrawer();
    renderMain();
  }
  function renderMain(){
    welcomeView.hidden = true;
    contentView.hidden = false;
    readonlyComposer.hidden = true;
    if(state.section === "chats") renderConversation(model.conversations.find(function(chat){ return chat.id === state.selectedChatId; }) || null);
    else if(state.section === "channels") renderChannel(model.channels.find(function(channel){ return channel.id === state.selectedChannelId; }) || null);
    else if(state.section === "calls") renderCallDetail(model.calls[0] || null);
    else if(state.section === "statuses") renderStatusDetail(model.statuses[0] || null);
    else if(state.section === "communities"){
      const selectedCommunity = model.communities.find(function(community){ return community.id === state.selectedCommunityId; }) || model.communities[0] || null;
      const selectedCommunityChat = state.selectedCommunityChatId ? model.conversations.find(function(chat){ return chat.id === state.selectedCommunityChatId; }) : null;
      if(selectedCommunityChat) renderConversation(selectedCommunityChat); else renderCommunityDetail(selectedCommunity);
    }
    else renderProfile();
  }
  function renderHeader(title, subtitle, avatarAssetId, onOpenInfo, iconName, onSearch){
    contentHeader.replaceChildren();
    const avatarButton = element("button", "header-avatar-button");
    avatarButton.type = "button";
    avatarButton.setAttribute("aria-label", "查看信息");
    if(iconName){ const iconAvatar = element("span", "avatar"); iconAvatar.append(svgIcon(iconName)); avatarButton.append(iconAvatar); }
    else avatarButton.append(avatar(title, avatarAssetId));
    if(onOpenInfo) avatarButton.addEventListener("click", onOpenInfo);
    const heading = element("div", "conversation-heading");
    heading.append(element("strong", "", title), element("span", "", subtitle));
    if(onOpenInfo) heading.addEventListener("click", onOpenInfo);
    const actions = element("div", "header-actions");
    const searchButton = element("button", "icon-button");
    const searchLabel = onSearch ? "搜索消息" : "在列表中搜索";
    searchButton.type = "button"; searchButton.title = searchLabel; searchButton.setAttribute("aria-label", searchLabel); searchButton.append(svgIcon("search"));
    searchButton.addEventListener("click", function(){ if(onSearch) onSearch(); else if(!searchRegion.hidden) drawerSearch.focus(); });
    actions.append(searchButton);
    if(onOpenInfo){
      const infoButton = element("button", "icon-button"); infoButton.type = "button"; infoButton.title = "查看信息"; infoButton.setAttribute("aria-label", "查看信息"); infoButton.append(svgIcon("info")); infoButton.addEventListener("click", onOpenInfo); actions.append(infoButton);
    }
    const menuButton = element("button", "icon-button unavailable-action"); menuButton.type = "button"; menuButton.disabled = true; menuButton.title = "离线预览不可修改数据"; menuButton.setAttribute("aria-label", "更多（离线预览不可用）"); menuButton.append(svgIcon("menu")); actions.append(menuButton);
    contentHeader.append(avatarButton, heading, actions);
  }
  function renderConversation(chat){
    if(!chat){ renderEmptyMain("没有对话可预览", "该账号没有已导入的聊天记录。", "chat"); return; }
    state.detailChatId = chat.id;
    state.floatingDateReady = false;
    hideFloatingDate(true);
    renderHeader(chat.title, chat.messageCount + " 条消息" + (chat.community && chat.community.role === "group" ? "，" + chat.community.title : ""), chat.avatarAssetId, function(){ openChatDetail(chat); }, null, function(){ openConversationSearch(chat); });
    readonlyComposer.hidden = false;
    contentBody.replaceChildren();
    if(model.source.collectionStatus !== "complete"){
      const warning = element("div", "incomplete-banner", model.source.warning || "该采集结果未完整结束，当前页面仅展示已保存的内容。");
      contentBody.append(warning);
    }
    const background = element("div", "messages-background");
    const list = element("div", "message-list");
    const mediaSequence = conversationMedia(chat);
    let currentDate = null;
    let previousMessage = null;
    chat.messages.forEach(function(message){
      const nextDate = dateKey(message.timestampUtc);
      if(nextDate !== currentDate){
        currentDate = nextDate;
        previousMessage = null;
        const divider = element("div", "date-chip", formatDate(message.timestampUtc, true) || nextDate);
        divider.dataset.dateKey = nextDate;
        divider.dataset.timestamp = message.timestampUtc || "";
        list.append(divider);
      }
      const previousTime = previousMessage && previousMessage.timestampUtc ? new Date(previousMessage.timestampUtc).getTime() : Number.NaN;
      const currentTime = message.timestampUtc ? new Date(message.timestampUtc).getTime() : Number.NaN;
      const groupStart = !previousMessage || isSystemMessage(previousMessage) || isSystemMessage(message) || previousMessage.fromMe !== message.fromMe || previousMessage.senderId !== message.senderId || (Number.isFinite(previousTime) && Number.isFinite(currentTime) && currentTime - previousTime > 5 * 60 * 1000);
      list.append(renderMessage(message, chat, groupStart, mediaSequence));
      previousMessage = message;
    });
    if(!chat.messages.length) list.append(emptyInline("该对话没有已导入的消息。"));
    background.append(list);
    contentBody.append(background);
    const pendingMessageId = state.pendingMessageId;
    state.pendingMessageId = null;
    if(pendingMessageId){
      if(!jumpToMessage(pendingMessageId, false)) contentBody.scrollTop = contentBody.scrollHeight;
      requestAnimationFrame(function(){ state.floatingDateReady = true; });
    }else{
      requestAnimationFrame(function(){
        contentBody.scrollTop = contentBody.scrollHeight;
        hideFloatingDate(true);
        requestAnimationFrame(function(){ state.floatingDateReady = true; });
      });
    }
  }
  function renderMessage(message, chat, groupStart, mediaSequence){
    if(isSystemMessage(message)){
      const system = element("div", "system-message", message.isRevoked ? "此系统消息已撤回" : message.text || message.caption || "系统通知");
      system.dataset.messageId = message.id;
      system.dataset.timestamp = message.timestampUtc || "";
      return system;
    }
    const row = element("div", "message-row" + (message.fromMe ? " is-outgoing" : "") + (groupStart ? " group-start" : ""));
    row.dataset.messageId = message.id;
    row.dataset.timestamp = message.timestampUtc || "";
    const attachments = message.attachments || [];
    const hasText = Boolean(message.isRevoked ? true : message.text || message.caption);
    const bubble = element("article", "bubble" + (!hasText && attachments.length === 1 && (attachments[0].kind === "image" || attachments[0].kind === "video") ? " is-media-only" : ""));
    if(!message.fromMe && isGroup(chat) && message.senderDisplayName) bubble.append(element("p", "sender-name", message.senderDisplayName));
    if(message.isForwarded){ const forwarded = element("div", "forwarded"); forwarded.append(svgIcon("forward"), element("span", "", "已转发")); bubble.append(forwarded); }
    if(message.quotedMessageId) bubble.append(element("div", "quote", "引用消息 " + message.quotedMessageId));
    attachments.forEach(function(attachment){ bubble.append(renderAttachment(attachment, { sequence:mediaSequence, owner:{ chat:chat, channel:null, message:message, ownerTitle:chat.title } })); });
    const text = message.isRevoked ? "此消息已撤回" : message.text || message.caption;
    if(text) bubble.append(element("div", "message-text" + (message.isRevoked ? " revoked-text" : ""), text));
    const meta = element("div", "message-meta");
    if(message.isStarred) meta.append(element("span", "", "★"));
    meta.append(element("time", "", formatTime(message.timestampUtc)));
    if(message.fromMe){ const check = svgIcon(message.acknowledgement === "3" ? "check-double" : "check"); if(message.acknowledgement === "3") check.classList.add("read"); meta.append(check); }
    bubble.append(meta);
    row.append(bubble);
    return row;
  }
  function jumpToMessage(messageId, smooth){
    if(!messageId) return false;
    const row = contentBody.querySelector('[data-message-id="' + cssEscape(messageId) + '"]');
    if(!row) return false;
    window.clearTimeout(state.highlightTimer);
    row.scrollIntoView({ block:"center", behavior:smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
    row.classList.remove("is-highlighted");
    void row.offsetWidth;
    row.classList.add("is-highlighted");
    state.highlightTimer = window.setTimeout(function(){ row.classList.remove("is-highlighted"); }, 1900);
    updateFloatingDate(true);
    return true;
  }
  function hideFloatingDate(immediate){
    window.clearTimeout(state.floatingDateTimer);
    floatingDate.classList.remove("is-visible");
    if(immediate){ floatingDate.hidden = true; return; }
    state.floatingDateTimer = window.setTimeout(function(){ if(!floatingDate.classList.contains("is-visible")) floatingDate.hidden = true; }, 170);
  }
  function showFloatingDate(label){
    if(!label){ hideFloatingDate(true); return; }
    window.clearTimeout(state.floatingDateTimer);
    floatingDate.textContent = label;
    floatingDate.hidden = false;
    requestAnimationFrame(function(){ floatingDate.classList.add("is-visible"); });
    state.floatingDateTimer = window.setTimeout(function(){ hideFloatingDate(false); }, 760);
  }
  function updateFloatingDate(reveal){
    if(state.section !== "chats" && state.section !== "communities"){ hideFloatingDate(true); return; }
    const dividers = contentBody.querySelectorAll(".date-chip[data-timestamp]");
    if(!dividers.length){ hideFloatingDate(true); return; }
    const bodyTop = contentBody.getBoundingClientRect().top + 22;
    let current = dividers[0];
    dividers.forEach(function(divider){ if(divider.getBoundingClientRect().top <= bodyTop) current = divider; });
    if(reveal) showFloatingDate(current.textContent || formatDate(current.dataset.timestamp, true));
  }
  function openConversationSearch(chat){
    if(!chat) return;
    state.detailChatId = chat.id;
    detailPanel.dataset.mode = "search";
    detailPanelTitle.textContent = "搜索消息";
    detailBody.replaceChildren();
    const tools = element("div", "detail-search-tools");
    const dateWrap = element("div", "detail-date-picker-wrap");
    const dateButton = element("button", "detail-date-picker");
    dateButton.type = "button"; dateButton.title = "跳转到日期"; dateButton.setAttribute("aria-label", "跳转到日期"); dateButton.setAttribute("aria-haspopup", "dialog"); dateButton.setAttribute("aria-expanded", "false"); dateButton.append(svgIcon("calendar"));
    const datePopover = element("div", "date-picker-popover");
    datePopover.hidden = true; datePopover.setAttribute("role", "dialog"); datePopover.setAttribute("aria-label", "选择聊天日期"); dateWrap.append(dateButton, datePopover);
    const searchLabel = element("label", "detail-search-box"); searchLabel.append(svgIcon("search"));
    const searchInput = document.createElement("input"); searchInput.type = "search"; searchInput.placeholder = "搜索消息"; searchInput.autocomplete = "off"; searchLabel.append(searchInput);
    tools.append(dateWrap, searchLabel);
    const results = element("div", "detail-results");
    detailBody.append(tools, results);
    let resultLimit = 50;
    function renderResults(){
      results.replaceChildren();
      const query = searchInput.value.trim();
      if(!query){ results.append(element("p", "detail-empty", "输入文字搜索此对话，或用日历跳转到指定日期。")); return; }
      const matches = chat.messages.filter(function(message){ return matchesQuery(messageSearchText(message), query); }).slice().reverse();
      if(!matches.length){ results.append(element("p", "detail-empty", "未找到消息")); return; }
      const visible = matches.slice(0, resultLimit);
      results.append(element("p", "detail-search-summary", "找到 " + matches.length + " 条，当前显示 " + visible.length + " 条"));
      visible.forEach(function(message){
        const button = element("button", "detail-result"); button.type = "button";
        button.append(element("strong", "", formatDatePart(message.timestampUtc, false)), element("time", "", formatTime(message.timestampUtc)), element("span", "", messageResultPreview(message)));
        button.addEventListener("click", function(){ closeDetail(); jumpToMessage(message.id, true); });
        results.append(button);
      });
      if(visible.length < matches.length){
        const more = element("button", "search-load-more", "加载更多，还剩 " + (matches.length - visible.length) + " 条"); more.type = "button";
        more.addEventListener("click", function(){ resultLimit += 50; renderResults(); }); results.append(more);
      }
    }
    searchInput.addEventListener("input", function(){ resultLimit = 50; renderResults(); });
    renderResults();
    const datedMessages = chat.messages.filter(function(message){ return timestampValue(message.timestampUtc) > 0; }).slice().sort(function(left, right){ return timestampValue(left.timestampUtc) - timestampValue(right.timestampUtc); });
    const messagesByDate = new Map();
    datedMessages.forEach(function(message){ const key = dateKey(message.timestampUtc); if(!messagesByDate.has(key)) messagesByDate.set(key, []); messagesByDate.get(key).push(message); });
    dateButton.disabled = !datedMessages.length;
    let visibleMonth = datedMessages.length ? new Date(timestampValue(datedMessages[datedMessages.length - 1].timestampUtc)) : new Date();
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
    const firstDate = datedMessages.length ? new Date(timestampValue(datedMessages[0].timestampUtc)) : new Date();
    const lastDate = datedMessages.length ? new Date(timestampValue(datedMessages[datedMessages.length - 1].timestampUtc)) : new Date();
    const earliestMonth = new Date(firstDate.getFullYear(), firstDate.getMonth(), 1);
    const latestMonth = new Date(lastDate.getFullYear(), lastDate.getMonth(), 1);
    let selectedDateKey = datedMessages.length ? dateKey(datedMessages[datedMessages.length - 1].timestampUtc) : dateKey(new Date().toISOString());
    function nearestMessage(targetDate){
      let nearest = null;
      datedMessages.forEach(function(message){ const distance = Math.abs(timestampValue(message.timestampUtc) - targetDate.getTime()); if(!nearest || distance < nearest.distance) nearest = { message:message, distance:distance }; });
      return nearest && nearest.message;
    }
    function closeDatePicker(){ datePopover.hidden = true; dateButton.setAttribute("aria-expanded", "false"); if(state.closeDatePicker === closeDatePicker) state.closeDatePicker = null; }
    function renderDatePicker(){
      datePopover.replaceChildren();
      const header = element("div", "date-picker-header");
      const title = element("div", "date-picker-title"); title.append(element("h3", "", visibleMonth.getFullYear() + "年" + (visibleMonth.getMonth() + 1) + "月"), element("small", "", "有圆点的日期包含消息"));
      const navigation = element("div", "date-picker-navigation");
      const previous = element("button", "date-picker-nav-button"); previous.type = "button"; previous.setAttribute("aria-label", "上个月"); previous.disabled = visibleMonth.getTime() <= earliestMonth.getTime(); previous.append(svgIcon("chevron-left"));
      const next = element("button", "date-picker-nav-button"); next.type = "button"; next.setAttribute("aria-label", "下个月"); next.disabled = visibleMonth.getTime() >= latestMonth.getTime(); next.append(svgIcon("chevron-right"));
      navigation.append(previous, next); header.append(title, navigation); datePopover.append(header);
      const weekdays = element("div", "date-picker-weekdays"); ["周一","周二","周三","周四","周五","周六","周日"].forEach(function(label){ weekdays.append(element("span", "", label)); }); datePopover.append(weekdays);
      const firstDay = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
      const mondayOffset = (firstDay.getDay() + 6) % 7;
      const gridStart = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1 - mondayOffset);
      for(let rowIndex = 0; rowIndex < 6; rowIndex += 1){
        const week = element("div", "date-picker-week");
        for(let dayIndex = 0; dayIndex < 7; dayIndex += 1){
          const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + rowIndex * 7 + dayIndex);
          const key = dateKey(date.toISOString());
          const available = messagesByDate.has(key);
          const withinRange = date.getTime() >= new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate()).getTime() && date.getTime() <= new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate(), 23, 59, 59).getTime();
          const day = element("button", "date-picker-day" + (date.getMonth() === visibleMonth.getMonth() ? "" : " is-outside-month") + (available ? " has-messages" : "") + (key === selectedDateKey ? " is-selected" : ""), date.getDate());
          day.type = "button"; day.disabled = !withinRange; day.setAttribute("aria-label", formatSearchDate(date.toISOString()) + (available ? "，" + messagesByDate.get(key).length + " 条消息" : "，跳转到最近消息")); day.setAttribute("aria-selected", key === selectedDateKey ? "true" : "false");
          if(withinRange) day.addEventListener("click", function(){ const target = (messagesByDate.get(key) || [nearestMessage(date)])[0]; if(!target) return; selectedDateKey = key; closeDetail(); jumpToMessage(target.id, true); });
          week.append(day);
        }
        datePopover.append(week);
      }
      previous.addEventListener("click", function(){ visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1); renderDatePicker(); });
      next.addEventListener("click", function(){ visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1); renderDatePicker(); });
    }
    dateButton.addEventListener("click", function(event){
      event.stopPropagation();
      if(!datePopover.hidden){ closeDatePicker(); return; }
      if(state.closeDatePicker && state.closeDatePicker !== closeDatePicker) state.closeDatePicker();
      renderDatePicker(); datePopover.hidden = false; dateButton.setAttribute("aria-expanded", "true"); state.closeDatePicker = closeDatePicker;
      requestAnimationFrame(function(){ const selected = datePopover.querySelector('.date-picker-day[aria-selected="true"]'); const available = datePopover.querySelector('.date-picker-day:not(:disabled)'); if(selected && !selected.disabled) selected.focus(); else if(available) available.focus(); });
    });
    detailPanel.hidden = false;
    requestAnimationFrame(function(){ searchInput.focus(); });
  }
  function renderAttachment(attachment, options){
    const settings = options && typeof options === "object" ? options : { compact:Boolean(options) };
    const wrap = element("div", "attachment");
    const url = attachment.status === "available" ? assetUrl(attachment.assetId) : null;
    if(!url){
      const missing = element("div", "missing-card");
      missing.append(svgIcon("info"));
      const copy = element("span", "file-copy"); copy.append(element("strong", "", attachment.fileName || "媒体不可用"), element("small", "", attachment.failureReason || "采集结果中没有该文件"));
      missing.append(copy); wrap.append(missing); return wrap;
    }
    if(attachment.kind === "image"){
      const image = document.createElement("img"); image.src = url; image.alt = attachment.fileName || "图片"; image.loading = "lazy";
      image.addEventListener("error", function(){
        const missing = element("div", "missing-card");
        missing.append(svgIcon("image"));
        const copy = element("span", "file-copy"); copy.append(element("strong", "", attachment.fileName || "图片"), element("small", "", "图片无法显示")); missing.append(copy);
        wrap.replaceChildren(missing);
      }, { once:true });
      image.addEventListener("click", function(){ openMedia(attachment, settings.sequence, settings.owner); }); wrap.append(image); return wrap;
    }
    if(attachment.kind === "video"){
      const video = document.createElement("video"); video.src = url; video.controls = true; video.preload = "metadata"; video.playsInline = true; wrap.append(video);
      const preview = element("button", "attachment-preview-button"); preview.type = "button"; preview.title = "打开媒体预览"; preview.setAttribute("aria-label", "打开媒体预览"); preview.append(svgIcon("expand")); preview.addEventListener("click", function(){ openMedia(attachment, settings.sequence, settings.owner); }); wrap.append(preview); return wrap;
    }
    if(attachment.kind === "audio"){
      const audio = document.createElement("audio"); audio.src = url; audio.controls = true; audio.preload = "metadata"; wrap.append(audio); return wrap;
    }
    const link = element("a", "document-card"); link.href = url; link.download = attachment.fileName || "附件";
    link.append(svgIcon("file")); const copy = element("span", "file-copy"); copy.append(element("strong", "", attachment.fileName || "文档"), element("small", "", formatBytes(attachment.sizeBytes) || attachment.mimeType || "附件")); link.append(copy); wrap.append(link); return wrap;
  }
  function mediaEntryKey(entry){
    if(!entry) return "";
    const ownerId = entry.chat ? entry.chat.id : entry.channel ? entry.channel.id : entry.ownerTitle || "";
    return [ownerId, entry.message && entry.message.id, entry.attachment && entry.attachment.assetId, entry.attachment && entry.attachment.fileName].join("\u0000");
  }
  function normalizeMediaItems(items){
    const result = [];
    const seen = new Set();
    (items || []).forEach(function(entry){
      if(!entry || !isPreviewableMediaEntry(entry)) return;
      const key = mediaEntryKey(entry);
      if(!key || seen.has(key)) return;
      seen.add(key); result.push(entry);
    });
    return result;
  }
  function mediaSender(entry){
    const message = entry && entry.message;
    if(entry && entry.channel){
      return { name:entry.channel.title || entry.ownerTitle || "频道", avatarAssetId:entry.channel.avatarAssetId || null };
    }
    if(message && message.fromMe){
      return { name:"你", avatarAssetId:accountAvatarAssetId };
    }
    const chat = entry && entry.chat;
    const name = message && message.senderDisplayName || message && message.senderId || chat && chat.title || entry && entry.ownerTitle || "未知发送者";
    return { name:name, avatarAssetId:chat && !isGroup(chat) ? chat.avatarAssetId : null };
  }
  function renderMediaFilmstrip(){
    mediaFilmstripTrack.replaceChildren();
    mediaFilmstrip.hidden = state.dialogItems.length === 0;
    if(!state.dialogItems.length) return;
    const radius = 20;
    const start = Math.max(0, state.dialogIndex - radius);
    const end = Math.min(state.dialogItems.length, state.dialogIndex + radius + 1);
    let selectedButton = null;
    for(let index = start; index < end; index += 1){
      const entry = state.dialogItems[index];
      const attachment = entry.attachment;
      const fileName = originalAttachmentName(attachment);
      const button = element("button", "media-filmstrip-item" + (index === state.dialogIndex ? " is-selected" : ""));
      button.type = "button";
      button.title = fileName;
      button.setAttribute("aria-label", "预览第 " + (index + 1) + " 项媒体，共 " + state.dialogItems.length + " 项");
      button.setAttribute("aria-current", index === state.dialogIndex ? "true" : "false");
      button.dataset.mediaIndex = String(index);
      const url = assetUrl(attachment.assetId);
      if(url && attachment.kind === "image"){
        const image = document.createElement("img"); image.src = url; image.alt = ""; image.loading = "lazy"; button.append(image);
      }else if(url && attachment.kind === "video"){
        const video = document.createElement("video"); video.src = url; video.muted = true; video.preload = "metadata"; video.playsInline = true; button.append(video);
        const badge = element("span", "media-kind-badge"); badge.append(svgIcon("video")); button.append(badge);
      }else{
        button.append(svgIcon(attachment.kind === "audio" ? "calls" : attachment.kind === "video" ? "video" : "image"));
      }
      button.addEventListener("click", function(){ if(index !== state.dialogIndex){ state.dialogIndex = index; renderMediaDialogItem(); } });
      mediaFilmstripTrack.append(button);
      if(index === state.dialogIndex) selectedButton = button;
    }
    if(selectedButton) requestAnimationFrame(function(){ selectedButton.scrollIntoView({ block:"nearest", inline:"center", behavior:"auto" }); });
  }
  function openMedia(attachment, sequence, owner){
    const fallbackOwner = owner || allMedia().find(function(entry){ return entry.attachment === attachment || entry.attachment.assetId === attachment.assetId; });
    let items = normalizeMediaItems(sequence && sequence.length ? sequence : allMedia());
    let index = items.findIndex(function(entry){ return entry.attachment === attachment || mediaEntryKey(entry) === mediaEntryKey(fallbackOwner); });
    if(index < 0 && fallbackOwner && isPreviewableMediaEntry(fallbackOwner)){ items = items.concat([fallbackOwner]); index = items.length - 1; }
    if(index < 0) return;
    state.dialogItems = items;
    state.dialogIndex = index;
    if(!mediaDialog.open) mediaDialog.showModal();
    renderMediaDialogItem();
    requestAnimationFrame(function(){ document.getElementById("mediaClose").focus({ preventScroll:true }); });
  }
  function renderMediaDialogItem(){
    const entry = state.dialogItems[state.dialogIndex];
    if(!entry) return;
    const existing = mediaDialogBody.querySelector("video,audio");
    if(existing) existing.pause();
    const attachment = entry.attachment;
    const url = assetUrl(attachment.assetId);
    const originalFileName = originalAttachmentName(attachment);
    const sender = mediaSender(entry);
    mediaSenderAvatarSlot.replaceChildren(avatar(sender.name, sender.avatarAssetId, "media-sender-avatar"));
    mediaSenderName.textContent = sender.name;
    mediaSentAt.textContent = formatMediaTimestamp(entry.message && entry.message.timestampUtc);
    document.getElementById("mediaTitle").textContent = originalFileName;
    document.getElementById("mediaMeta").textContent = [entry.ownerTitle, formatDateTime(entry.message && entry.message.timestampUtc, false), attachment.mimeType, formatBytes(attachment.sizeBytes)].filter(Boolean).join(" · ");
    document.getElementById("mediaCounter").textContent = (state.dialogIndex + 1) + " / " + state.dialogItems.length;
    mediaJumpToMessage.disabled = !entry.message;
    mediaJumpToMessage.dataset.sourceMessageId = entry.message ? entry.message.id : "";
    mediaPrevious.hidden = state.dialogItems.length <= 1;
    mediaNext.hidden = state.dialogItems.length <= 1;
    mediaPrevious.disabled = state.dialogIndex <= 0;
    mediaNext.disabled = state.dialogIndex >= state.dialogItems.length - 1;
    const download = document.getElementById("mediaDownload");
    if(url){ download.href = url; download.download = originalFileName; download.setAttribute("aria-disabled", "false"); }
    else{ download.removeAttribute("href"); download.setAttribute("aria-disabled", "true"); }
    renderMediaFilmstrip();
    mediaDialogBody.replaceChildren();
    if(!url){
      const failed = element("div", "media-error"); failed.append(svgIcon("info"), element("strong", "", "媒体文件无法读取"), element("span", "", attachment.failureReason || "该文件不在离线预览中")); mediaDialogBody.append(failed); return;
    }
    let media;
    if(attachment.kind === "video"){ media = document.createElement("video"); media.controls = true; media.preload = "metadata"; media.playsInline = true; }
    else if(attachment.kind === "audio"){ media = document.createElement("audio"); media.controls = true; }
    else{ media = document.createElement("img"); media.alt = originalFileName; }
    media.addEventListener("error", function(){
      const failed = element("div", "media-error"); failed.append(svgIcon("info"), element("strong", "", "媒体文件无法显示"), element("span", "", "可以保存原文件后使用本地程序打开")); mediaDialogBody.replaceChildren(failed);
    }, { once:true });
    media.src = url; mediaDialogBody.append(media);
  }
  function navigateMediaDialog(delta){
    if(!mediaDialog.open) return false;
    const next = state.dialogIndex + Number(delta || 0);
    if(next < 0 || next >= state.dialogItems.length || next === state.dialogIndex) return false;
    state.dialogIndex = next; renderMediaDialogItem(); return true;
  }
  function jumpFromMediaDialog(){
    const entry = state.dialogItems[state.dialogIndex];
    if(!entry || !entry.message) return;
    closeMediaDialog();
    jumpToLibrarySource(entry);
  }
  function closeMediaDialog(){
    if(!mediaDialog.open) return;
    const media = mediaDialogBody.querySelector("video,audio"); if(media) media.pause();
    state.dialogItems = []; state.dialogIndex = -1;
    document.getElementById("mediaCounter").textContent = "";
    mediaJumpToMessage.dataset.sourceMessageId = "";
    mediaSenderAvatarSlot.replaceChildren();
    mediaFilmstripTrack.replaceChildren();
    mediaDialogBody.replaceChildren(); mediaDialog.close();
  }
  function renderChannel(channel){
    if(!channel){ renderEmptyMain("没有频道可预览", "该账号没有已采集的频道记录。", "channel"); return; }
    renderHeader(
      channel.title,
      channel.eventCount + " 条更新",
      channel.avatarAssetId,
      null,
      channel.avatarAssetId ? null : "channel"
    );
    contentBody.replaceChildren();
    const view = element("div", "messages-background");
    const feed = element("div", "channel-feed");
    const mediaSequence = channelMedia(channel);
    channel.messages.forEach(function(message){
      const card = element("article", "channel-card");
      card.dataset.messageId = message.id;
      card.dataset.timestamp = message.timestampUtc || "";
      (message.attachments || []).forEach(function(attachment){ card.append(renderAttachment(attachment, { compact:true, sequence:mediaSequence, owner:{ chat:null, channel:channel, message:message, ownerTitle:channel.title } })); });
      const copy = element("div", "channel-card-copy");
      const text = message.isRevoked ? "此频道更新已撤回" : message.text || message.caption || "频道更新";
      copy.append(element("p", "", text));
      const footer = element("footer", "", (message.isForwarded ? "已转发，" : "") + formatDateTime(message.timestampUtc, true)); copy.append(footer); card.append(copy); feed.append(card);
    });
    if(!channel.messages.length) feed.append(emptyInline("该频道没有已采集的更新。"));
    view.append(feed); contentBody.append(view);
    const pendingMessageId = state.pendingMessageId;
    state.pendingMessageId = null;
    if(pendingMessageId){
      if(!jumpToMessage(pendingMessageId, false)) contentBody.scrollTop = 0;
    }else contentBody.scrollTop = 0;
  }
  function renderCallDetail(call){
    if(!call){ renderEmptyMain("没有通话记录", "该账号没有已采集的通话信息。", "calls"); return; }
    renderHeader(call.title, call.isVideo ? "视频通话" : "语音通话", null, null, "calls");
    renderFeaturePage(call.title, call.state || "通话记录", [
      ["时间", formatDateTime(call.timestampUtc, true)],
      ["方向", call.direction === "incoming" ? "呼入" : call.direction === "outgoing" ? "呼出" : "未知"],
      ["时长", call.durationSeconds === null ? "未记录" : call.durationSeconds + " 秒"],
      ["类型", call.isVideo ? "视频通话" : "语音通话"],
      ["群组通话", call.isGroup ? "是" : "否"]
    ], "calls");
  }
  function renderStatusDetail(status){
    if(!status){ renderEmptyMain("没有动态记录", "该账号没有已采集的动态信息。", "status"); return; }
    renderHeader(status.title, status.itemCount + " 条动态", null, null, "status");
    renderFeaturePage(status.title, status.preview || "动态记录", [
      ["发布时间", formatDateTime(status.timestampUtc, true)],
      ["到期时间", formatDateTime(status.expiresAtUtc, true)],
      ["记录数量", status.itemCount + " 条"]
    ], "status");
  }
  function renderCommunityDetail(community){
    if(!community){ renderEmptyMain("没有社群关系", "该账号没有已采集的社群信息。", "community"); return; }
    renderHeader(community.title, community.childGroups.length + " 个群组", null, null, "community");
    readonlyComposer.hidden = true;
    contentBody.replaceChildren();
    const view = element("div", "feature-view"); const inner = element("div", "feature-view-inner");
    const hero = element("div", "feature-hero"); const heroAvatar = element("span", "avatar"); heroAvatar.append(svgIcon("community")); hero.append(heroAvatar);
    const heroCopy = element("div"); heroCopy.append(element("h2", "", community.title), element("p", "", community.description || "社群主对话与群聊集合")); hero.append(heroCopy); inner.append(hero);
    const card = element("section", "feature-card"); card.append(element("h3", "", "社群中的对话"));
    community.childGroups.forEach(function(group){
      const button = element("button", "community-detail-group"); button.type = "button";
      const groupAvatar = element("span", "avatar avatar-small"); groupAvatar.append(svgIcon(group.role === "announcement" ? "community" : "chat")); button.append(groupAvatar);
      const copy = element("span", "row-main"); copy.append(element("strong", "", group.role === "announcement" ? community.title : group.title), element("span", "row-context", group.role === "announcement" ? "社群主对话" : community.title + "，社群群聊")); button.append(copy);
      const chat = model.conversations.find(function(item){ return item.id === group.id; });
      if(chat) button.addEventListener("click", function(){ state.selectedCommunityId = community.id; state.selectedCommunityChatId = chat.id; state.selectedChatId = chat.id; renderDrawer(); renderMain(); }); else button.disabled = true;
      card.append(button);
    });
    if(!community.childGroups.length) card.append(element("p", "", "没有采集到子群组关系。"));
    inner.append(card); view.append(inner); contentBody.append(view);
  }
  function renderProfile(){
    renderHeader(accountName, model.account.formattedPhoneNumber || model.source.specimenName, accountAvatarAssetId, null, accountAvatarAssetId ? null : "user");
    renderFeaturePage(accountName, model.account.about || "该采集结果没有账号简介。", [
      ["账号标识", model.account.nativeId || "未记录"],
      ["电话号码", model.account.formattedPhoneNumber || "未记录"],
      ["检材名称", model.source.specimenName],
      ["案件名称", model.caseName],
      ["导出时间", formatDateTime(model.generatedAtUtc, true)]
    ], "user");
  }
  function renderFeaturePage(title, description, rows, iconName){
    readonlyComposer.hidden = true;
    contentBody.replaceChildren();
    const view = element("div", "feature-view"); const inner = element("div", "feature-view-inner");
    const hero = element("div", "feature-hero"); const heroAvatar = element("span", "avatar"); heroAvatar.append(svgIcon(iconName)); hero.append(heroAvatar);
    const heroCopy = element("div"); heroCopy.append(element("h2", "", title), element("p", "", description)); hero.append(heroCopy); inner.append(hero);
    const card = element("section", "feature-card"); const grid = document.createElement("dl"); grid.className = "info-grid";
    rows.forEach(function(row){ grid.append(element("dt", "", row[0]), element("dd", "", row[1] || "未记录")); }); card.append(grid); inner.append(card); view.append(inner); contentBody.append(view);
  }
  function renderEmptyMain(title, description, iconName){
    contentHeader.replaceChildren(); contentBody.replaceChildren(); readonlyComposer.hidden = true;
    const empty = element("div", "empty-view"); empty.append(svgIcon(iconName), element("h3", "", title), element("p", "", description)); contentBody.append(empty);
  }
  function emptyInline(text){ return element("div", "feature-card", text); }
  function openChatDetail(chat){
    detailPanelTitle.textContent = isGroup(chat) ? "群组信息" : "联系人信息";
    detailBody.replaceChildren();
    const hero = element("div", "profile-hero"); hero.append(avatar(chat.title, chat.avatarAssetId), element("h2", "", chat.title));
    if(chat.community && chat.community.role === "group") hero.append(element("p", "", chat.community.title + "，社群群聊")); else hero.append(element("p", "", isGroup(chat) ? "群聊" : "个人对话"));
    detailBody.append(hero);
    const actions = element("div", "profile-actions");
    [["chat","消息"],["calls","通话"],["search","搜索"]].forEach(function(action){
      const item = element("span", "profile-action"); const button = element("span", "icon-button"); button.append(svgIcon(action[0])); item.append(button, element("span", "", action[1])); actions.append(item);
    });
    detailBody.append(actions);
    const info = element("section", "info-section"); info.append(element("h3", "", "记录概览")); const grid = document.createElement("dl"); grid.className = "info-grid";
    const rows = [["消息", chat.messageCount + " 条"],["媒体", chat.mediaCount + " 个"],["星标消息", chat.starredMessageCount + " 条"],["参与者", chat.participantCount + " 个"]];
    if(!isGroup(chat)) rows.push(["电话号码", chat.formattedPhoneNumber || (chat.phoneNumber ? "+" + chat.phoneNumber : "未采集")]);
    rows.push(["会话标识", chat.id]);
    rows.forEach(function(row){ grid.append(element("dt", "", row[0]), element("dd", "", row[1])); }); info.append(grid); detailBody.append(info);
    const media = conversationMedia(chat);
    const mediaSection = element("section", "info-section"); mediaSection.append(element("h3", "", "影音内容 " + media.length)); const gridMedia = element("div", "media-grid");
    media.slice(0, 60).forEach(function(entry){ const attachment = entry.attachment; const tile = element("button", "media-tile"); tile.type = "button"; const url = assetUrl(attachment.assetId); if(url){ if(attachment.kind === "image"){ const image = document.createElement("img"); image.src = url; image.alt = attachment.fileName || "图片"; tile.append(image); }else{ const video = document.createElement("video"); video.src = url; video.muted = true; video.preload = "metadata"; tile.append(video); } tile.addEventListener("click", function(){ openMedia(attachment, media, entry); }); } gridMedia.append(tile); });
    if(!media.length) gridMedia.append(element("p", "row-preview", "没有可预览的图片或视频。")); mediaSection.append(gridMedia); detailBody.append(mediaSection);
    detailPanel.hidden = false;
  }
  function closeDetail(){
    if(state.closeDatePicker) state.closeDatePicker();
    state.detailChatId = null;
    detailPanel.hidden = true;
    detailPanel.removeAttribute("data-mode");
    detailBody.replaceChildren();
  }

  document.querySelectorAll("[data-section]").forEach(function(button){ button.addEventListener("click", function(){ setSection(button.dataset.section); }); });
  document.querySelectorAll("[data-chat-filter]").forEach(function(button){
    button.addEventListener("click", function(){
      if(button.disabled) return;
      state.chatFilter = button.dataset.chatFilter;
      document.querySelectorAll("[data-chat-filter]").forEach(function(candidate){ candidate.classList.toggle("is-selected", candidate === button); });
      renderDrawer();
    });
  });
  drawerSearch.addEventListener("input", function(){ state.search = drawerSearch.value; state.searchLimit = 50; renderDrawer(); });
  libraryOpen.addEventListener("click", openLibraryDialog);
  document.querySelectorAll("[data-library-tab]").forEach(function(button){
    button.addEventListener("click", function(){ state.libraryTab = button.dataset.libraryTab; renderLibraryDialog(); });
  });
  document.getElementById("libraryClose").addEventListener("click", closeLibraryDialog);
  libraryDialog.addEventListener("click", function(event){ if(event.target === event.currentTarget) closeLibraryDialog(); });
  libraryDialog.addEventListener("cancel", function(event){ event.preventDefault(); closeLibraryDialog(); });
  document.getElementById("detailClose").addEventListener("click", closeDetail);
  document.getElementById("mediaClose").addEventListener("click", closeMediaDialog);
  mediaJumpToMessage.addEventListener("click", jumpFromMediaDialog);
  mediaPrevious.addEventListener("click", function(){ navigateMediaDialog(-1); });
  mediaNext.addEventListener("click", function(){ navigateMediaDialog(1); });
  mediaDialog.addEventListener("click", function(event){ if(event.target === event.currentTarget) closeMediaDialog(); });
  mediaDialog.addEventListener("cancel", function(event){ event.preventDefault(); closeMediaDialog(); });
  contentBody.addEventListener("scroll", function(){ if(state.floatingDateReady) updateFloatingDate(true); }, { passive:true });
  document.addEventListener("click", function(event){
    if(!state.closeDatePicker) return;
    const picker = detailPanel.querySelector(".detail-date-picker-wrap");
    if(picker && !picker.contains(event.target)) state.closeDatePicker();
  });
  document.addEventListener("keydown", function(event){
    if(mediaDialog.open){
      const tagName = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
      if((event.key === "ArrowLeft" || event.key === "ArrowRight") && tagName !== "input" && tagName !== "textarea" && tagName !== "video" && tagName !== "audio"){
        if(navigateMediaDialog(event.key === "ArrowLeft" ? -1 : 1)) event.preventDefault();
        return;
      }
      if(event.key === "Escape"){ event.preventDefault(); closeMediaDialog(); }
      return;
    }
    if(libraryDialog.open){
      if(event.key === "Escape"){ event.preventDefault(); closeLibraryDialog(); }
      return;
    }
    if(event.key === "Escape"){
      if(state.closeDatePicker){ state.closeDatePicker(); return; }
      if(!detailPanel.hidden) closeDetail();
    }
  });
  window.addEventListener("beforeunload", function(){ assetUrls.forEach(function(url){ URL.revokeObjectURL(url); }); });

  setAccountAvatars();
  renderDrawer();
  renderMain();
})();
`;
