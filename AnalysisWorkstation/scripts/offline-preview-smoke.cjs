const assert = require("node:assert/strict");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { isAbsolute, relative, resolve, sep } = require("node:path");
const { app, BrowserWindow } = require("electron");

const argumentsMap = new Map(process.argv.slice(2).map((argument) => {
  const separator = argument.indexOf("=");
  return separator === -1
    ? [argument, "true"]
    : [argument.slice(0, separator), argument.slice(separator + 1)];
}));
const analysisRoot = resolve(__dirname, "..");
const allowedInputRoot = resolve(analysisRoot, ".e2e-data");
const allowedOutputRoot = resolve(analysisRoot, ".e2e-artifacts");
const suppliedFile = argumentsMap.get("--file");
const suppliedOutput = argumentsMap.get("--output")
  || resolve(allowedOutputRoot, "offline-preview", "offline-preview-1440x900.png");

assert.ok(suppliedFile && isAbsolute(suppliedFile), "必须通过 --file 提供绝对 HTML 路径");
const inputFile = resolve(suppliedFile);
const outputFile = resolve(suppliedOutput);
const channelOutputFile = outputFile.replace(/\.png$/iu, "-channels.png");
const communityOutputFile = outputFile.replace(/\.png$/iu, "-communities.png");
const communityChatOutputFile = outputFile.replace(/\.png$/iu, "-community-chat.png");
const detailOutputFile = outputFile.replace(/\.png$/iu, "-detail.png");
const searchOutputFile = outputFile.replace(/\.png$/iu, "-search.png");
const dateOutputFile = outputFile.replace(/\.png$/iu, "-date-navigation.png");
const libraryOutputFile = outputFile.replace(/\.png$/iu, "-media-library.png");
const mediaOutputFile = outputFile.replace(/\.png$/iu, "-media-preview.png");
assertInside(allowedInputRoot, inputFile, "离线预览冒烟测试只能读取 .e2e-data 内的 HTML");
assertInside(allowedOutputRoot, outputFile, "离线预览截图只能写入 .e2e-artifacts");
assert.ok(existsSync(inputFile), `离线预览文件不存在：${inputFile}`);

const runtimeRoot = resolve(allowedOutputRoot, "offline-preview", "runtime");
mkdirSync(runtimeRoot, { recursive: true });
app.setPath("userData", resolve(runtimeRoot, "user-data"));
app.setPath("sessionData", resolve(runtimeRoot, "session-data"));
app.setPath("logs", resolve(runtimeRoot, "logs"));
app.setPath("crashDumps", resolve(runtimeRoot, "crash-dumps"));

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("force-color-profile", "srgb");

app.whenReady().then(async () => {
  const runtimeErrors = [];
  let externalRequestCount = 0;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: "#161717",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) runtimeErrors.push(message);
  });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/iu.test(details.url)) {
      externalRequestCount += 1;
      callback({ cancel: true });
      return;
    }
    callback({ cancel: false });
  });

  await window.loadFile(inputFile);
  await waitFor(window, "document.querySelectorAll('.chat-row').length >= 3", "对话列表渲染");
  await waitFor(window, "document.querySelectorAll('.message-row,.system-message').length > 0", "消息流渲染");
  await evaluate(window, `(() => {
    const row = [...document.querySelectorAll('.chat-row')]
      .find((candidate) => candidate.querySelector('.row-line strong')?.textContent?.trim() === '现场工作社群');
    row?.click();
  })()`);
  await waitFor(window, "document.querySelectorAll('.attachment img').length >= 1", "内嵌图片渲染");

  const initialAudit = await evaluate(window, `(() => ({
    title: document.title,
    navLabels: [...document.querySelectorAll('.nav-button[aria-label],.profile-button[aria-label]')].map((button) => button.getAttribute('aria-label')).filter(Boolean),
    chatRows: document.querySelectorAll('.chat-row').length,
    sourceRowText: document.querySelector('.drawer-header')?.textContent?.trim() ?? '',
    messageRows: document.querySelectorAll('.message-row').length,
    systemRows: document.querySelectorAll('.system-message').length,
    imageAttachments: document.querySelectorAll('.attachment img').length,
    externalReferences: document.querySelectorAll('[src^="http"],[href^="http"]').length,
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? '',
    horizontalOverflow: document.body.scrollWidth > innerWidth,
    navWidth: Math.round(document.querySelector('.nav-rail')?.getBoundingClientRect().width ?? 0),
    brandMarks: document.querySelectorAll('.brand-mark,#icon-whatsapp').length,
    firstNavTop: Math.round(document.querySelector('.nav-primary .nav-button')?.getBoundingClientRect().top ?? 0),
    navButtonSize: (() => { const rect = document.querySelector('.nav-primary .nav-button')?.getBoundingClientRect(); return [Math.round(rect?.width ?? 0), Math.round(rect?.height ?? 0)]; })(),
    statusSectionGap: (() => { const calls = document.querySelector('[data-section="calls"]')?.getBoundingClientRect(); const status = document.querySelector('[data-section="statuses"]')?.getBoundingClientRect(); return Math.round((status?.top ?? 0) - (calls?.bottom ?? 0)); })(),
    navFooterGap: (() => { const buttons = [...document.querySelectorAll('.nav-footer > *')]; const first = buttons[0]?.getBoundingClientRect(); const second = buttons[1]?.getBoundingClientRect(); return Math.round((second?.top ?? 0) - (first?.bottom ?? 0)); })(),
    drawerWidth: Math.round(document.querySelector('.drawer')?.getBoundingClientRect().width ?? 0),
    headerHeight: Math.round(document.querySelector('.content-header')?.getBoundingClientRect().height ?? 0),
    drawerTitleFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.drawer-heading h1')).fontSize),
    drawerActionGap: (() => { const buttons = [...document.querySelectorAll('.drawer-actions .icon-button')]; const first = buttons[0]?.getBoundingClientRect(); const second = buttons[1]?.getBoundingClientRect(); return Math.round((second?.left ?? 0) - (first?.right ?? 0)); })(),
    searchHeight: Math.round(document.querySelector('.search-box')?.getBoundingClientRect().height ?? 0),
    searchFontSize: Number.parseFloat(getComputedStyle(document.getElementById('drawerSearch')).fontSize),
    filterHeight: Math.round(document.querySelector('.filter-chip')?.getBoundingClientRect().height ?? 0),
    filterGap: (() => { const buttons = [...document.querySelectorAll('.filter-chip')]; const first = buttons[0]?.getBoundingClientRect(); const second = buttons[1]?.getBoundingClientRect(); return Math.round((second?.left ?? 0) - (first?.right ?? 0)); })(),
    communityRowHeight: Math.round(document.querySelector('.chat-row.has-community')?.getBoundingClientRect().height ?? 0),
    ordinaryRowHeight: Math.round(document.querySelector('.chat-row:not(.has-community)')?.getBoundingClientRect().height ?? 0)
  }))()`);
  assert.equal(initialAudit.chatRows, 3, "离线预览应显示三个合成对话");
  assert.ok(initialAudit.messageRows + initialAudit.systemRows > 0, "离线预览应显示消息");
  assert.ok(initialAudit.imageAttachments >= 1, "离线预览应渲染内嵌图片");
  assert.equal(initialAudit.externalReferences, 0, "离线预览不应生成外部资源引用");
  assert.match(initialAudit.csp, /connect-src 'none'/u);
  assert.equal(initialAudit.horizontalOverflow, false, "离线预览不应横向溢出");
  assert.equal(initialAudit.navWidth, 64, "离线预览应使用 WhatsApp 风格的 64px 功能栏");
  assert.equal(initialAudit.brandMarks, 0, "功能栏顶部不应保留 WhatsApp 品牌图标");
  assert.equal(initialAudit.firstNavTop, 10, "首个功能按钮应与 WhatsApp Web 保持 10px 顶部间距");
  assert.deepEqual(initialAudit.navButtonSize, [40, 40], "功能栏按钮应为 40px 方形点击区域");
  assert.equal(initialAudit.statusSectionGap, 8, "通话与动态之间应保留 8px 分组间距");
  assert.equal(initialAudit.navFooterGap, 4, "底部功能按钮间距应为 4px");
  assert.equal(initialAudit.drawerWidth, 500, "1440px 视口下列表区应限制为 500px");
  assert.equal(initialAudit.headerHeight, 64, "会话标题栏应为 64px");
  assert.equal(initialAudit.drawerTitleFontSize, 22, "列表标题应与 WhatsApp Web 的 22px 标题尺度一致");
  assert.equal(initialAudit.drawerActionGap, 16, "列表标题栏操作按钮间距应为 16px");
  assert.equal(initialAudit.searchHeight, 40, "搜索框应为 40px 高");
  assert.equal(initialAudit.searchFontSize, 14, "搜索文字应为 14px");
  assert.equal(initialAudit.filterHeight, 32, "筛选按钮应为 32px 高");
  assert.equal(initialAudit.filterGap, 8, "筛选按钮之间应保留 8px 间距");
  assert.equal(initialAudit.communityRowHeight, 95, "带社群归属的对话行应为 95px 高");
  assert.equal(initialAudit.ordinaryRowHeight, 76, "普通对话行应为 76px 高");
  assert.deepEqual(
    initialAudit.navLabels.slice(0, 7),
    ["对话", "通话", "动态", "频道", "社群", "全部媒体", "账号资料"],
    "离线预览功能栏顺序错误",
  );

  const interactionAudit = await evaluate(window, `(async () => {
    const search = document.getElementById('drawerSearch');
    search.value = '物流';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const searchCount = document.querySelectorAll('.chat-row').length;
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-section="channels"]').click();
    const channelCards = document.querySelectorAll('.channel-card').length;
    const channelAvatarNodes = [...document.querySelectorAll('.channel-row .avatar img, .content-header .header-avatar-button .avatar img')];
    await Promise.all(channelAvatarNodes.map((image) => image.decode().catch(() => undefined)));
    const channelAvatarImages = channelAvatarNodes
      .filter((image) => image.complete && image.naturalWidth > 0).length;
    document.querySelector('[data-section="communities"]').click();
    const communityGroups = document.querySelectorAll('.community-children .community-group').length;
    const communityMainText = document.querySelector('.community-children .community-group strong')?.textContent?.trim() ?? '';
    const announcementLabelCount = [...document.querySelectorAll('.community-children .community-group *')]
      .filter((element) => element.textContent?.trim() === '公告').length;
    document.querySelector('[data-section="profile"]').click();
    const profileText = document.querySelector('.feature-view')?.textContent ?? '';
    document.querySelector('[data-section="chats"]').click();
    return { searchCount, channelCards, channelAvatarImages, communityGroups, communityMainText, announcementLabelCount, profileText };
  })()`);
  assert.equal(interactionAudit.searchCount, 1, "对话搜索应只保留匹配项");
  assert.ok(interactionAudit.channelCards >= 4, "频道应按消息流展示采集更新");
  assert.ok(interactionAudit.channelAvatarImages >= 2, "频道列表与消息标题栏都应显示采集头像");
  assert.equal(interactionAudit.communityGroups, 2, "社群应展示主对话与子群组关系");
  assert.equal(interactionAudit.communityMainText, "现场工作社群", "社群主对话应使用社群名称");
  assert.equal(interactionAudit.announcementLabelCount, 0, "社群主对话不应显示公告标签");
  assert.match(interactionAudit.profileText, /现场账号/u, "账号资料页应显示账号名称");

  mkdirSync(resolve(outputFile, ".."), { recursive: true });

  await evaluate(window, `(() => {
    const search = document.getElementById('drawerSearch');
    search.value = '原始清单';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(window, "document.querySelectorAll('.search-result-row').length >= 3", "全文消息搜索");
  await nextPaint(window);
  writeFileSync(searchOutputFile, (await window.capturePage()).toPNG());
  const searchAudit = await evaluate(window, `(() => {
    const rows = [...document.querySelectorAll('.search-result-row')];
    const target = rows[0];
    const result = {
      count: rows.length,
      messageId: target?.dataset.messageId ?? '',
      text: target?.textContent?.trim() ?? ''
    };
    target?.click();
    return result;
  })()`);
  assert.ok(searchAudit.count >= 3, "全文搜索应查找消息正文，而不只匹配对话名称");
  assert.match(searchAudit.text, /原始清单/u, "搜索结果应显示命中的消息摘要");
  await waitFor(window, `document.querySelector('#contentBody [data-message-id="${searchAudit.messageId}"]')`, "搜索结果打开原消息所在对话");
  await waitFor(window, `document.querySelector('#contentBody [data-message-id="${searchAudit.messageId}"]')?.classList.contains('is-highlighted')`, "搜索结果定位并高亮原消息", 3_000);

  await evaluate(window, `(() => {
    const search = document.getElementById('drawerSearch');
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const row = [...document.querySelectorAll('.chat-row')]
      .find((candidate) => candidate.querySelector('.row-line strong')?.textContent?.trim() === '现场工作社群');
    row?.click();
    document.querySelector('.content-header [aria-label="搜索消息"]')?.click();
  })()`);
  await waitFor(window, "!document.getElementById('detailPanel').hidden && document.querySelector('.detail-date-picker')", "会话搜索与日期面板");
  await evaluate(window, `(() => {
    const search = document.querySelector('.detail-search-box input');
    search.value = '原始清单';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.detail-date-picker')?.click();
  })()`);
  await waitFor(window, "document.querySelectorAll('.detail-result').length >= 2 && !document.querySelector('.date-picker-popover').hidden && document.querySelectorAll('.date-picker-day.has-messages').length >= 3", "日期日历标记消息日期");
  const dateAudit = await evaluate(window, `(() => ({
    resultCount: document.querySelectorAll('.detail-result').length,
    messageDateCount: document.querySelectorAll('.date-picker-day.has-messages').length,
    selectedDateCount: document.querySelectorAll('.date-picker-day[aria-selected="true"]').length
  }))()`);
  assert.ok(dateAudit.resultCount >= 2, "会话内搜索应列出匹配消息");
  assert.equal(dateAudit.messageDateCount, 3, "日历应标出合成会话中的三个消息日期");
  assert.equal(dateAudit.selectedDateCount, 1, "日历应标明当前消息日期");
  await nextPaint(window);
  writeFileSync(dateOutputFile, (await window.capturePage()).toPNG());
  const dateTarget = await evaluate(window, `(() => {
    const target = [...document.querySelectorAll('.date-picker-day.has-messages:not(.is-selected)')][0];
    const label = target?.getAttribute('aria-label') ?? '';
    target?.click();
    return label;
  })()`);
  assert.ok(dateTarget, "日期导航应提供其他有消息的日期");
  await waitFor(window, "document.getElementById('detailPanel').hidden && document.querySelector('.is-highlighted[data-message-id]')", "按日期定位消息");

  await evaluate(window, `document.getElementById('libraryOpen').click()`);
  await waitFor(window, "document.getElementById('libraryDialog').open && document.querySelectorAll('.library-media-item').length >= 2", "全部媒体弹窗");
  const libraryAudit = await evaluate(window, `(() => ({
    tabs: [...document.querySelectorAll('[data-library-tab]')].map((tab) => tab.childNodes[0]?.textContent?.trim() ?? ''),
    selectedTab: document.querySelector('[data-library-tab].is-selected')?.dataset.libraryTab ?? '',
    mediaNames: [...document.querySelectorAll('.library-file-name')].map((button) => button.textContent?.trim() ?? ''),
    isModal: document.getElementById('libraryDialog')?.open ?? false
  }))()`);
  assert.deepEqual(libraryAudit.tabs, ["影音内容", "文档", "链接"], "全部媒体应使用原版的三个分类");
  assert.equal(libraryAudit.selectedTab, "media", "全部媒体默认应显示影音内容");
  assert.equal(libraryAudit.isModal, true, "全部媒体应以弹窗形式显示");
  assert.ok(libraryAudit.mediaNames.includes("现场设备.png"), "媒体库应显示原始媒体文件名");
  assert.ok(libraryAudit.mediaNames.includes("频道现场设备.png"), "媒体库应保留频道媒体的原始文件名");
  await nextPaint(window);
  writeFileSync(libraryOutputFile, (await window.capturePage()).toPNG());

  const mediaSourceMessageId = await evaluate(window, `(() => {
    const target = [...document.querySelectorAll('.library-file-name')].find((button) => button.textContent?.trim() === '现场设备.png');
    const messageId = target?.dataset.sourceMessageId ?? '';
    target?.click();
    return messageId;
  })()`);
  assert.ok(mediaSourceMessageId, "媒体文件名应关联来源消息");
  await waitFor(window, `!document.getElementById('libraryDialog').open && document.querySelector('[data-message-id="${mediaSourceMessageId}"]')?.classList.contains('is-highlighted')`, "媒体文件名跳转到原消息", 3_000);

  await evaluate(window, `document.getElementById('libraryOpen').click(); document.querySelector('[data-library-tab="documents"]').click()`);
  await waitFor(window, "document.querySelector('[data-library-tab=\"documents\"].is-selected') && [...document.querySelectorAll('.library-source-button')].some((button) => button.textContent?.trim() === '材料清单.txt')", "文档分类与原始文件名");
  const documentSourceMessageId = await evaluate(window, `(() => {
    const target = [...document.querySelectorAll('.library-source-button')].find((button) => button.textContent?.trim() === '材料清单.txt');
    const messageId = target?.dataset.sourceMessageId ?? '';
    target?.click();
    return messageId;
  })()`);
  assert.ok(documentSourceMessageId, "文档文件名应关联来源消息");
  await waitFor(window, `!document.getElementById('libraryDialog').open && document.querySelector('[data-message-id="${documentSourceMessageId}"]')?.classList.contains('is-highlighted')`, "文档文件名跳转到原消息", 3_000);

  await evaluate(window, `document.getElementById('libraryOpen').click(); document.querySelector('[data-library-tab="links"]').click()`);
  await waitFor(window, "[...document.querySelectorAll('.library-link-url')].some((button) => button.textContent?.includes('https://example.test/review/field-device'))", "链接分类");
  const linkSourceMessageId = await evaluate(window, `(() => {
    const target = [...document.querySelectorAll('.library-link-url')].find((button) => button.textContent?.includes('https://example.test/review/field-device'));
    const messageId = target?.dataset.sourceMessageId ?? '';
    target?.click();
    return messageId;
  })()`);
  assert.ok(linkSourceMessageId, "链接应关联来源消息");
  await waitFor(window, `!document.getElementById('libraryDialog').open && document.querySelector('[data-message-id="${linkSourceMessageId}"]')?.classList.contains('is-highlighted')`, "链接跳转到原消息", 3_000);

  await evaluate(window, `document.getElementById('libraryOpen').click(); document.querySelector('.library-media-preview')?.click()`);
  await waitFor(window, "document.getElementById('mediaDialog').open && document.querySelector('#mediaDialogBody img, #mediaDialogBody video')", "媒体灯箱打开");
  const mediaAudit = await evaluate(window, `(() => ({
    counter: document.getElementById('mediaCounter')?.textContent?.trim() ?? '',
    title: document.getElementById('mediaTitle')?.textContent?.trim() ?? '',
    sender: document.getElementById('mediaSenderName')?.textContent?.trim() ?? '',
    sentAt: document.getElementById('mediaSentAt')?.textContent?.trim() ?? '',
    nextDisabled: document.getElementById('mediaNext')?.disabled ?? true,
    downloadName: document.getElementById('mediaDownload')?.getAttribute('download') ?? '',
    jumpMessageId: document.getElementById('mediaJumpToMessage')?.dataset.sourceMessageId ?? '',
    thumbnailCount: document.querySelectorAll('.media-filmstrip-item').length,
    selectedThumbnailCount: document.querySelectorAll('.media-filmstrip-item.is-selected').length
  }))()`);
  assert.equal(mediaAudit.counter, "1 / 2", "媒体灯箱应显示当前位置和媒体总数");
  assert.ok(mediaAudit.sender, "媒体灯箱左上角应显示发送者");
  assert.match(mediaAudit.sentAt, /\d{4}年\d{1,2}月\d{1,2}日/u, "媒体灯箱左上角应显示完整发送时间");
  assert.match(mediaAudit.sentAt, /UTC[+-]\d{2}:\d{2}/u, "媒体灯箱时间应明确显示 UTC 偏移");
  assert.equal(mediaAudit.nextDisabled, false, "媒体灯箱应支持连续浏览");
  assert.ok(mediaAudit.downloadName, "媒体灯箱应保留原文件下载入口");
  assert.ok(mediaAudit.jumpMessageId, "媒体灯箱应保留前往来源消息的入口");
  assert.equal(mediaAudit.thumbnailCount, 2, "媒体灯箱底部应显示同一序列的缩略图");
  assert.equal(mediaAudit.selectedThumbnailCount, 1, "媒体灯箱底部应标记当前缩略图");
  await nextPaint(window);
  writeFileSync(mediaOutputFile, (await window.capturePage()).toPNG());
  await evaluate(window, `document.getElementById('mediaNext')?.click()`);
  await waitFor(window, "document.getElementById('mediaCounter')?.textContent?.trim() === '2 / 2'", "媒体灯箱下一项");
  const mediaJumpMessageId = await evaluate(window, `(() => {
    const button = document.getElementById('mediaJumpToMessage');
    const messageId = button?.dataset.sourceMessageId ?? '';
    button?.click();
    return messageId;
  })()`);
  assert.ok(mediaJumpMessageId, "前往消息按钮应关联当前媒体的来源消息");
  await waitFor(window, `!document.getElementById('mediaDialog').open && document.querySelector('[data-message-id="${mediaJumpMessageId}"]')?.classList.contains('is-highlighted')`, "媒体灯箱前往消息", 3_000);

  await evaluate(window, `document.querySelector('[data-section="channels"]').click()`);
  await waitFor(window, "document.querySelectorAll('.channel-card').length >= 4", "频道视图截图");
  await waitFor(window, "[...document.querySelectorAll('.channel-row .avatar img, .content-header .header-avatar-button .avatar img')].filter((image) => image.complete && image.naturalWidth > 0).length >= 2", "频道头像截图");
  await nextPaint(window);
  writeFileSync(channelOutputFile, (await window.capturePage()).toPNG());
  await evaluate(window, `document.querySelector('[data-section="communities"]').click()`);
  await waitFor(window, "document.querySelectorAll('.community-children .community-group').length === 2", "社群视图截图");
  await nextPaint(window);
  writeFileSync(communityOutputFile, (await window.capturePage()).toPNG());
  await evaluate(window, `document.querySelector('.community-children .community-group')?.click()`);
  await waitFor(window, "document.querySelectorAll('.message-row,.system-message').length > 0", "社群主对话截图");
  await nextPaint(window);
  writeFileSync(communityChatOutputFile, (await window.capturePage()).toPNG());
  await evaluate(window, `(() => {
    document.querySelector('[data-section="chats"]').click();
    const row = [...document.querySelectorAll('.chat-row')]
      .find((candidate) => candidate.querySelector('.row-line strong')?.textContent?.trim() === '物流对接');
    row?.click();
    document.querySelector('.header-avatar-button')?.click();
  })()`);
  await waitFor(window, "!document.getElementById('detailPanel').hidden", "会话资料抽屉截图");
  const contactDetailText = await evaluate(window, `document.getElementById('detailBody')?.textContent ?? ''`);
  assert.match(contactDetailText, /电话号码/u, "联系人资料应显示电话号码字段");
  assert.match(contactDetailText, /\+8613664182073/u, "联系人资料应显示已采集的电话号码");
  await nextPaint(window);
  writeFileSync(detailOutputFile, (await window.capturePage()).toPNG());
  await evaluate(window, `document.getElementById('detailClose').click()`);
  await waitFor(window, "document.querySelectorAll('.chat-row').length === 3", "返回对话列表");
  const displayedTimestampAudit = await evaluate(window, `(() => {
    const values = [...document.querySelectorAll('time, .date-chip, .row-time')]
      .map((element) => element.textContent?.trim() ?? '')
      .filter((value) => value && /\\d/u.test(value));
    return {
      count: values.length,
      missingOffset: values.filter((value) => !/UTC[+-]\\d{2}:\\d{2}/u.test(value))
    };
  })()`);
  assert.ok(displayedTimestampAudit.count > 0, "离线预览应显示至少一个时间");
  assert.deepEqual(displayedTimestampAudit.missingOffset, [], "离线预览中的时间应全部明确显示 UTC 偏移");
  const image = await window.capturePage();
  writeFileSync(outputFile, image.toPNG());

  assert.deepEqual(runtimeErrors, [], `离线预览运行错误：${runtimeErrors.join("；")}`);
  assert.equal(externalRequestCount, 0, "离线预览不应尝试访问网络");
  process.stdout.write(`${JSON.stringify({
    inputFile,
    outputFile,
    viewOutputFiles: [
      channelOutputFile,
      communityOutputFile,
      communityChatOutputFile,
      detailOutputFile,
      searchOutputFile,
      dateOutputFile,
      libraryOutputFile,
      mediaOutputFile,
    ],
    initialAudit,
    interactionAudit: {
      searchCount: interactionAudit.searchCount,
      fullTextSearchCount: searchAudit.count,
      dateMessageCount: dateAudit.messageDateCount,
      libraryTabs: libraryAudit.tabs,
      mediaCounter: mediaAudit.counter,
      channelCards: interactionAudit.channelCards,
      communityGroups: interactionAudit.communityGroups,
      communityMainText: interactionAudit.communityMainText,
    },
    externalRequestCount,
  }, null, 2)}\n`);
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

function assertInside(parent, child, message) {
  const childRelativePath = relative(parent, child);
  assert.ok(
    childRelativePath !== "" &&
      childRelativePath !== ".." &&
      !childRelativePath.startsWith(`..${sep}`) &&
      !isAbsolute(childRelativePath),
    message,
  );
}

async function evaluate(window, expression) {
  return window.webContents.executeJavaScript(expression, true);
}

async function waitFor(window, expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(window, expression)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`等待离线预览状态超时：${label}`);
}

async function nextPaint(window) {
  await evaluate(window, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
}
