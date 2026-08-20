import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const argumentsMap = new Map(process.argv.slice(2).map((argument) => {
  const separator = argument.indexOf("=");
  return separator === -1
    ? [argument, "true"]
    : [argument.slice(0, separator), argument.slice(separator + 1)];
}));
const port = Number(argumentsMap.get("--port") ?? "9334");
const outputDirectory = resolve(argumentsMap.get("--output") ?? ".e2e-artifacts");
const closeAfterCapture = argumentsMap.get("--close") === "true";
const emptyCaseOnly = argumentsMap.get("--empty-case") === "true";
const emptyTaskOnly = argumentsMap.get("--empty-task") === "true";

const targets = await waitForTargets(port);
const target = targets.find((candidate) =>
  candidate.type === "page" && candidate.url.startsWith("file://"),
);
assert.ok(target?.webSocketDebuggerUrl, "未找到 AnalysisWorkstation 渲染页面");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolvePromise, rejectPromise) => {
  socket.addEventListener("open", resolvePromise, { once: true });
  socket.addEventListener("error", rejectPromise, { once: true });
});

let nextId = 0;
const pending = new Map();
const runtimeErrors = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const handlers = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(JSON.stringify(message.error)));
    else handlers.resolve(message.result);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    runtimeErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  }
  if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    runtimeErrors.push(message.params.entry.text);
  }
});

function command(method, params = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? "页面脚本执行失败");
  }
  return response.result.value;
}

async function waitForText(text, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
  }
  throw new Error(`等待界面文本超时：${text}`);
}

async function waitFor(expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
  }
  throw new Error(`等待界面状态超时：${label}`);
}

async function click(selector) {
  const clicked = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.click();
    return true;
  })()`);
  assert.equal(clicked, true, `找不到元素：${selector}`);
}

async function doubleClick(selector) {
  const clicked = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      detail: 2,
      view: window,
    }));
    return true;
  })()`);
  assert.equal(clicked, true, `找不到元素：${selector}`);
}

async function setInputValue(selector, value) {
  const changed = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  assert.equal(changed, true, `找不到输入框：${selector}`);
}

async function clickButton(label) {
  const clicked = await evaluate(`(() => {
    const label = ${JSON.stringify(label)};
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim().includes(label) || candidate.getAttribute("aria-label") === label);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `找不到按钮：${label}`);
}

async function clickRowContaining(selector, text) {
  const clicked = await evaluate(`(() => {
    const selector = ${JSON.stringify(selector)};
    const text = ${JSON.stringify(text)};
    const element = [...document.querySelectorAll(selector)]
      .find((candidate) => candidate.textContent?.includes(text));
    if (!element) return false;
    element.click();
    return true;
  })()`);
  assert.equal(clicked, true, `找不到包含指定文字的行：${text}`);
}

async function setViewport(width, height) {
  await command("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 180));
}

async function screenshot(name, width, height) {
  await setViewport(width, height);
  mkdirSync(outputDirectory, { recursive: true });
  const result = await command("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const path = resolve(outputDirectory, `${name}-${width}x${height}.png`);
  writeFileSync(path, Buffer.from(result.data, "base64"));
  return path;
}

await Promise.all([command("Runtime.enable"), command("Page.enable"), command("Log.enable")]);
const screenshots = [];
let layoutAudit = null;
if (emptyCaseOnly || emptyTaskOnly) {
  await waitForText("还没有案件");
  layoutAudit = await evaluate(`(() => {
    const toolbar = document.querySelector(".case-browser__toolbar");
    const search = toolbar?.querySelector(".search-field");
    const create = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "新建案件");
    const titlebar = document.querySelector(".titlebar");
    const rail = document.querySelector(".navigation-rail");
    const controls = document.querySelector(".titlebar__controls");
    const appShell = document.querySelector(".app-shell");
    const caseList = document.querySelector(".case-list");
    const searchInput = search?.querySelector("input");
    searchInput?.focus();
    const toolbarRect = toolbar?.getBoundingClientRect();
    const searchRect = search?.getBoundingClientRect();
    const createRect = create?.getBoundingClientRect();
    const titlebarRect = titlebar?.getBoundingClientRect();
    const railRect = rail?.getBoundingClientRect();
    const controlsRect = controls?.getBoundingClientRect();
    const caseListStyle = caseList ? getComputedStyle(caseList) : null;
    const searchStyle = search ? getComputedStyle(search) : null;
    const searchInputStyle = searchInput ? getComputedStyle(searchInput) : null;
    let caseListStillScrolls = false;
    if (caseList) {
      const filler = document.createElement('div');
      filler.style.cssText = 'display:block;min-height:1600px;height:1600px;flex:0 0 1600px;';
      caseList.append(filler);
      filler.getBoundingClientRect();
      caseList.scrollTop = 40;
      caseListStillScrolls = caseList.scrollHeight > caseList.clientHeight && caseList.scrollTop > 0;
      filler.remove();
      caseList.scrollTop = 0;
    }
    return {
      createButtonCount: [...document.querySelectorAll("button")]
        .filter((button) => button.textContent?.trim() === "新建案件").length,
      hasEmptyMark: document.querySelector(".empty-state__mark") !== null,
      titlebarText: document.querySelector(".titlebar")?.innerText.trim() ?? "",
      appShellTop: appShell?.getBoundingClientRect().top ?? null,
      titlebarHeight: titlebarRect?.height ?? null,
      titlebarCoversWorkspace: titlebarRect && railRect
        ? Math.abs(titlebarRect.left - railRect.right) < 1
          && Math.abs(titlebarRect.right - innerWidth) < 1
        : false,
      toolbarBelowTitlebar: toolbarRect && titlebarRect
        ? toolbarRect.top >= titlebarRect.bottom
        : false,
      businessButtonsInTitlebar: titlebar?.querySelectorAll(
        ".primary-button, .secondary-button, .ghost-button, .danger-button, .text-button",
      ).length ?? -1,
      buttonRadius: create ? getComputedStyle(create).borderRadius : null,
      sameToolbarRow: searchRect && createRect
        ? Math.abs((searchRect.top + searchRect.height / 2) - (createRect.top + createRect.height / 2)) < 1
        : false,
      controlsShareFirstRow: toolbarRect && controlsRect
        ? controlsRect.top >= toolbarRect.top && controlsRect.bottom <= toolbarRect.bottom
        : false,
      searchFocusHasPurpleFrame: searchStyle?.borderColor === "rgb(101, 75, 232)"
        || (searchInputStyle?.outlineStyle !== "none"
          && searchInputStyle?.outlineColor === "rgb(101, 75, 232)"),
      searchInputOutlineStyle: searchInputStyle?.outlineStyle ?? null,
      caseListScrollbarHidden: caseListStyle?.scrollbarWidth === 'none',
      caseListStillScrolls,
    };
  })()`);
  assert.equal(layoutAudit.createButtonCount, 1, "案件空状态不应重复显示新建按钮");
  assert.equal(layoutAudit.hasEmptyMark, false, "空状态装饰方块应移除");
  assert.equal(layoutAudit.titlebarText, "", "标题栏不应显示产品名或页面名");
  assert.equal(layoutAudit.appShellTop, 0, "工作区应从窗口顶部开始");
  assert.equal(layoutAudit.titlebarHeight, 44, "自绘标题栏高度应保持 44px");
  assert.equal(layoutAudit.titlebarCoversWorkspace, true, "自绘标题栏应覆盖右侧工作区整行");
  assert.equal(layoutAudit.toolbarBelowTitlebar, true, "案件工具栏应位于自绘标题栏下方");
  assert.equal(layoutAudit.businessButtonsInTitlebar, 0, "自绘标题栏内不应放置业务按钮");
  assert.equal(layoutAudit.buttonRadius, "3px", "按钮圆角应收紧到 3px");
  assert.equal(layoutAudit.sameToolbarRow, true, "搜索框与新建按钮应在同一行");
  assert.equal(layoutAudit.controlsShareFirstRow, false, "窗口控制不应与页面业务工具栏共用一行");
  assert.equal(layoutAudit.searchFocusHasPurpleFrame, false, "搜索框聚焦时不应显示紫色套框");
  assert.equal(layoutAudit.searchInputOutlineStyle, "none", "搜索框输入区不应显示内层焦点框");
  assert.equal(layoutAudit.caseListScrollbarHidden, true, "案件列表不应显示滚动条");
  assert.equal(layoutAudit.caseListStillScrolls, true, "隐藏滚动条后案件列表仍应能够滚动");
  screenshots.push(await screenshot("empty-case-management", 1440, 900));
  screenshots.push(await screenshot("empty-case-management", 1120, 720));
  await clickButton("新建案件");
  await waitForText("案件保存位置");
  const createDialogAudit = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const nameInput = dialog?.querySelector('.field input');
    return {
      headerDescriptionCount: dialog?.querySelectorAll('.modal__header p').length ?? -1,
      namePlaceholder: nameInput?.getAttribute('placeholder') ?? null,
      helperTextCount: dialog?.querySelectorAll('.field > small').length ?? -1,
      hasCancelButton: [...(dialog?.querySelectorAll('button') ?? [])]
        .some((button) => button.textContent?.trim() === '取消'),
    };
  })()`);
  assert.equal(createDialogAudit.headerDescriptionCount, 0, "新建案件弹窗不应显示标题说明");
  assert.equal(createDialogAudit.namePlaceholder, null, "案件名称不应显示示例占位");
  assert.equal(createDialogAudit.helperTextCount, 0, "保存位置不应显示目录命名提示");
  assert.equal(createDialogAudit.hasCancelButton, false, "弹窗底部不应显示取消按钮");
  layoutAudit.createDialog = createDialogAudit;
  screenshots.push(await screenshot("new-case-modal", 1120, 720));
  if (emptyTaskOnly) {
    const filled = await evaluate(`(() => {
      const input = document.querySelector('[role="dialog"] .field input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!input || !setter) return false;
      setter.call(input, '任务布局验收案件');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    assert.equal(filled, true, "无法填写测试案件名称");
    await waitFor(
      `document.querySelector('[role="dialog"] button[type="submit"]')?.disabled === false`,
      "创建案件按钮启用",
    );
    await clickButton("创建并进入");
    await waitForText("还没有下发任务");
    const taskPageAudit = await evaluate(`(() => {
      const actions = document.querySelector('.task-list-heading .page-header__actions');
      const titlebar = document.querySelector('.titlebar');
      const logo = document.querySelector('.navigation-rail__logo');
      const taskNav = document.querySelector('.rail-button[aria-label="任务"]');
      const chatNav = document.querySelector('.rail-button[aria-label="聊天"]');
      const taskPanel = document.querySelector('.task-list-panel');
      const taskHeading = document.querySelector('.task-list-heading');
      const taskTableHeader = document.querySelector('.task-table-header');
      const buttons = [...(actions?.querySelectorAll('button') ?? [])];
      const taskHeadingRect = taskHeading?.getBoundingClientRect();
      const actionsRect = actions?.getBoundingClientRect();
      const titlebarRect = titlebar?.getBoundingClientRect();
      const logoRect = logo?.getBoundingClientRect();
      const taskNavRect = taskNav?.getBoundingClientRect();
      const chatNavRect = chatNav?.getBoundingClientRect();
      const taskPanelStyle = taskPanel ? getComputedStyle(taskPanel) : null;
      const taskHeadingStyle = taskHeading ? getComputedStyle(taskHeading) : null;
      const taskTableHeaderStyle = taskTableHeader ? getComputedStyle(taskTableHeader) : null;
      return {
        caseNameCount: document.querySelectorAll('.task-page__case-name').length,
        headingAndActionsSameRow: taskHeadingRect && actionsRect
          ? actionsRect.top >= taskHeadingRect.top && actionsRect.bottom <= taskHeadingRect.bottom
          : false,
        actionButtonsSameRow: buttons.length === 2
          ? Math.abs(buttons[0].getBoundingClientRect().top - buttons[1].getBoundingClientRect().top) < 1
          : false,
        taskHeadingBelowTitlebar: taskHeadingRect && titlebarRect
          ? taskHeadingRect.top >= titlebarRect.bottom + 20
          : false,
        taskActionsOutsideTitlebar: actionsRect && titlebarRect
          ? actionsRect.top >= titlebarRect.bottom + 20
          : false,
        railSeparatorCount: document.querySelectorAll('.navigation-rail__separator').length,
        compactRailGroup: logoRect && taskNavRect && chatNavRect
          ? taskNavRect.top - logoRect.bottom <= 12
            && chatNavRect.top - taskNavRect.bottom <= 12
          : false,
        taskPanelUnframed: taskPanelStyle
          ? taskPanelStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
            && taskPanelStyle.borderTopWidth === '0px'
            && taskPanelStyle.borderRadius === '0px'
            && taskPanelStyle.boxShadow === 'none'
          : false,
        taskSectionUsesCanvas: taskHeadingStyle && taskTableHeaderStyle
          ? taskHeadingStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
            && taskTableHeaderStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
          : false,
        hasRemovedPageTitle: document.body.innerText.includes('任务下发与接收'),
        hasRemovedPageDescription: document.body.innerText.includes('每只 U 盘对应一个任务'),
        taskHeadingParagraphCount: document.querySelectorAll('.task-list-heading p').length,
        taskLegendCount: document.querySelectorAll('.task-legend').length,
        emptyDescriptionCount: document.querySelectorAll('.task-list > .empty-state p').length,
        emptyActionCount: document.querySelectorAll('.task-list > .empty-state button').length,
      };
    })()`);
    assert.equal(taskPageAudit.caseNameCount, 0, "任务页不应重复显示案件名");
    assert.equal(taskPageAudit.headingAndActionsSameRow, true, "任务操作应与已下发任务标题位于同一行");
    assert.equal(taskPageAudit.actionButtonsSameRow, true, "接收结果和分配任务应在同一行");
    assert.equal(taskPageAudit.taskHeadingBelowTitlebar, true, "任务工具栏应与标题栏明确分层");
    assert.equal(taskPageAudit.taskActionsOutsideTitlebar, true, "任务操作按钮不应放入标题栏");
    assert.equal(taskPageAudit.railSeparatorCount, 2, "Logo、任务和聊天之间应有两条分隔线");
    assert.equal(taskPageAudit.compactRailGroup, true, "Logo、任务和聊天应紧凑排列");
    assert.equal(taskPageAudit.taskPanelUnframed, true, "任务区不应使用独立卡片边框或背景");
    assert.equal(taskPageAudit.taskSectionUsesCanvas, true, "任务标题和表头应自然融入工作区背景");
    assert.equal(taskPageAudit.hasRemovedPageTitle, false, "任务页旧标题应删除");
    assert.equal(taskPageAudit.hasRemovedPageDescription, false, "任务页旧说明应删除");
    assert.equal(taskPageAudit.taskHeadingParagraphCount, 0, "任务数量说明应删除");
    assert.equal(taskPageAudit.taskLegendCount, 0, "任务状态说明应删除");
    assert.equal(taskPageAudit.emptyDescriptionCount, 0, "空任务说明应删除");
    assert.equal(taskPageAudit.emptyActionCount, 0, "空任务重复按钮应删除");
    layoutAudit.taskPage = taskPageAudit;
    screenshots.push(await screenshot("empty-task-page", 1120, 720));
    await clickButton("分配任务");
    await waitForText("U 盘根目录");
    const assignDialogAudit = await evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const inputs = [...(dialog?.querySelectorAll('.field input') ?? [])];
      return {
        headerDescriptionCount: dialog?.querySelectorAll('.modal__header p').length ?? -1,
        taskNamePlaceholder: inputs[0]?.getAttribute('placeholder') ?? null,
        usbRootPlaceholder: inputs[1]?.getAttribute('placeholder') ?? null,
        writeRuleCount: [...(dialog?.querySelectorAll('*') ?? [])]
          .filter((element) => element.textContent?.trim() === '写入规则').length,
        noticePanelCount: dialog?.querySelectorAll('.notice-panel').length ?? -1,
      };
    })()`);
    assert.equal(assignDialogAudit.headerDescriptionCount, 0, "分配任务弹窗不应显示标题说明");
    assert.equal(assignDialogAudit.taskNamePlaceholder, null, "任务名称不应显示示例占位");
    assert.equal(assignDialogAudit.usbRootPlaceholder, null, "U 盘根目录不应显示选择提示");
    assert.equal(assignDialogAudit.writeRuleCount, 0, "分配任务弹窗不应显示写入规则");
    assert.equal(assignDialogAudit.noticePanelCount, 0, "写入规则框应整体删除");
    layoutAudit.assignDialog = assignDialogAudit;
    screenshots.push(await screenshot("assign-task-modal", 1120, 720));
  }
} else {
  await waitForText("浦江路移动终端调查");
  const caseSearchSelector = '.case-browser__toolbar input[type="search"]';
  await setInputValue(caseSearchSelector, "fixture-cases");
  await waitForText("没有匹配案件");
  assert.equal(
    await evaluate(`document.querySelectorAll('.case-row').length`),
    0,
    "案件搜索不应匹配保存路径",
  );
  await setInputValue(caseSearchSelector, "浦江路");
  await waitFor(`document.querySelectorAll('.case-row').length === 1`, "案件名称搜索结果");
  await setInputValue(caseSearchSelector, "");
  await waitFor(`document.querySelectorAll('.case-row').length === 1`, "清空案件搜索");
  const caseManagementAudit = await evaluate(`(() => {
    const caseList = document.querySelector('.case-list');
    const caseListStyle = caseList ? getComputedStyle(caseList) : null;
    const preview = document.querySelector('.case-preview');
    return {
      caseListScrollbarHidden: caseListStyle?.scrollbarWidth === 'none',
      caseRowPathCount: document.querySelectorAll('.case-row__content small').length,
      previewKickerCount: preview?.querySelectorAll('.page-kicker').length ?? -1,
      previewPathCount: preview?.querySelectorAll('.case-preview__path').length ?? -1,
      previewStatsCount: preview?.querySelectorAll('.case-stat-grid, .case-stat').length ?? -1,
      previewEnterButtonCount: [...(preview?.querySelectorAll('button') ?? [])]
        .filter((button) => button.textContent?.includes('进入案件')).length,
      recentOpenedCount: [...(preview?.querySelectorAll('.case-details dt') ?? [])]
        .filter((label) => label.textContent?.trim() === '最近打开').length,
      previewNoticeCount: preview?.querySelectorAll('.notice-panel').length ?? -1,
      searchPlaceholder: document.querySelector('.case-browser__toolbar input[type="search"]')
        ?.getAttribute('placeholder') ?? null,
      detailLabels: [...(preview?.querySelectorAll('.case-details dt') ?? [])]
        .map((label) => label.textContent?.trim()),
    };
  })()`);
  assert.equal(caseManagementAudit.caseListScrollbarHidden, true, "案件列表不应显示滚动条");
  assert.equal(caseManagementAudit.caseRowPathCount, 0, "案件列表项不应显示保存路径");
  assert.equal(caseManagementAudit.previewKickerCount, 0, "案件预览标签应删除");
  assert.equal(caseManagementAudit.previewPathCount, 0, "案件名下方不应重复显示保存路径");
  assert.equal(caseManagementAudit.previewStatsCount, 0, "案件统计卡应删除");
  assert.equal(caseManagementAudit.previewEnterButtonCount, 0, "案件预览不应显示进入案件按钮");
  assert.equal(caseManagementAudit.recentOpenedCount, 0, "最近打开信息应删除");
  assert.equal(caseManagementAudit.previewNoticeCount, 0, "案件预览接收策略说明应删除");
  assert.equal(caseManagementAudit.searchPlaceholder, "搜索案件名称", "案件搜索提示应只包含案件名称");
  assert.deepEqual(caseManagementAudit.detailLabels, ["创建时间", "案件编号", "保存位置"]);
  layoutAudit = { caseManagement: caseManagementAudit };
  screenshots.push(await screenshot("01-case-management", 1440, 900));
  await doubleClick(".case-row");
  await waitForText("第一批现场手机提取");
  const populatedTaskAudit = await evaluate(`(() => {
    const heading = document.querySelector('.task-list-heading');
    const actions = heading?.querySelector('.page-header__actions');
    const headingRect = heading?.getBoundingClientRect();
    const actionsRect = actions?.getBoundingClientRect();
    const rowActions = document.querySelector('.task-row__actions');
    const disableButton = rowActions?.querySelector('button[aria-label^="停用任务："]');
    return {
      caseNameCount: document.querySelectorAll('.task-page__case-name').length,
      headingActionsSameRow: headingRect && actionsRect
        ? actionsRect.top >= headingRect.top && actionsRect.bottom <= headingRect.bottom
        : false,
      headingActionButtonCount: actions?.querySelectorAll('button').length ?? -1,
      openTaskFolderButtonCount: document.querySelectorAll('button[aria-label^="打开任务目录"]').length,
      rowActionButtonCount: rowActions?.querySelectorAll('button').length ?? -1,
      disableButtonText: disableButton?.textContent?.trim() ?? null,
      disableButtonTitle: disableButton?.getAttribute('title') ?? null,
    };
  })()`);
  assert.equal(populatedTaskAudit.caseNameCount, 0, "任务页不应显示案件名");
  assert.equal(populatedTaskAudit.headingActionsSameRow, true, "任务操作应与已下发任务标题位于同一行");
  assert.equal(populatedTaskAudit.headingActionButtonCount, 2, "任务标题行应包含接收结果和分配任务");
  assert.equal(populatedTaskAudit.openTaskFolderButtonCount, 0, "任务行不应显示打开文件夹按钮");
  assert.equal(populatedTaskAudit.rowActionButtonCount, 1, "任务行只保留停用图标操作");
  assert.equal(populatedTaskAudit.disableButtonText, "", "停用操作不应显示文字");
  assert.equal(populatedTaskAudit.disableButtonTitle, "停用任务", "停用图标应保留可访问提示");
  layoutAudit.taskPagePopulated = populatedTaskAudit;
  screenshots.push(await screenshot("02-task-page", 1120, 720));
  await clickButton("聊天");
  await waitForText("Alex 的 Android 手机");
  await waitForText("项目协调群");
  await waitFor(`document.querySelectorAll('.message-bubble, .system-message').length > 0`, "聊天消息加载");
  await setViewport(1440, 900);
  const chatPageAudit = await evaluate(`(() => {
    const workspace = document.querySelector('.chat-workspace');
    const sourcePane = document.querySelector('.source-pane');
    const chatPane = document.querySelector('.chat-pane');
    const messagePane = document.querySelector('.message-pane');
    const paneHeading = document.querySelector('.pane-heading');
    const chatHeader = document.querySelector('.chat-pane__header');
    const conversationHeader = document.querySelector('.conversation-header');
    const firstChatRow = document.querySelector('.chat-row');
    const messageTime = document.querySelector('.message-bubble__meta time');
    return {
      workspaceWidth: workspace?.getBoundingClientRect().width ?? 0,
      sourceWidth: sourcePane?.getBoundingClientRect().width ?? 0,
      chatWidth: chatPane?.getBoundingClientRect().width ?? 0,
      messageWidth: messagePane?.getBoundingClientRect().width ?? 0,
      paneHeadingHeight: paneHeading?.getBoundingClientRect().height ?? 0,
      chatHeaderHeight: chatHeader?.getBoundingClientRect().height ?? 0,
      conversationHeaderHeight: conversationHeader?.getBoundingClientRect().height ?? 0,
      firstChatRowHeight: firstChatRow?.getBoundingClientRect().height ?? 0,
      searchPlaceholder: chatHeader?.querySelector('input')?.getAttribute('placeholder') ?? null,
      dateSeparatorCount: document.querySelectorAll('.message-date-separator').length,
      messageTime: messageTime?.textContent?.trim() ?? null,
      composeControlCount: messagePane?.querySelectorAll('input, textarea').length ?? -1,
      horizontalOverflow: document.body.scrollWidth > innerWidth,
    };
  })()`);
  assert.ok(chatPageAudit.sourceWidth >= 200 && chatPageAudit.sourceWidth <= 240, "检材栏应保持紧凑");
  assert.ok(chatPageAudit.chatWidth >= 340 && chatPageAudit.chatWidth <= 390, "会话栏应采用紧凑 WhatsApp 式宽度");
  assert.ok(chatPageAudit.messageWidth > chatPageAudit.chatWidth, "消息区应是聊天页的主要区域");
  assert.equal(chatPageAudit.paneHeadingHeight, chatPageAudit.chatHeaderHeight, "检材栏与会话栏头部应对齐");
  assert.ok(chatPageAudit.conversationHeaderHeight >= 60 && chatPageAudit.conversationHeaderHeight <= 68, "会话顶栏高度应紧凑稳定");
  assert.ok(chatPageAudit.firstChatRowHeight >= 70 && chatPageAudit.firstChatRowHeight <= 76, "会话列表项应保持两行紧凑密度");
  assert.equal(chatPageAudit.searchPlaceholder, "搜索会话", "会话搜索提示应明确");
  assert.ok(chatPageAudit.dateSeparatorCount >= 1, "消息流应显示日期分隔");
  assert.equal(chatPageAudit.messageTime?.includes("/"), false, "消息气泡内应只显示时间");
  assert.equal(chatPageAudit.composeControlCount, 0, "取证预览不应出现虚假的消息输入控件");
  assert.equal(chatPageAudit.horizontalOverflow, false, "聊天页不应出现横向溢出");
  layoutAudit.chatPage = chatPageAudit;
  screenshots.push(await screenshot("03-chat-page", 1440, 900));
  screenshots.push(await screenshot("03b-chat-page-compact", 1120, 720));
  const compactChatAudit = await evaluate(`(() => {
    const sourcePane = document.querySelector('.source-pane');
    const chatPane = document.querySelector('.chat-pane');
    const messagePane = document.querySelector('.message-pane');
    return {
      sourceWidth: sourcePane?.getBoundingClientRect().width ?? 0,
      chatWidth: chatPane?.getBoundingClientRect().width ?? 0,
      messageWidth: messagePane?.getBoundingClientRect().width ?? 0,
      horizontalOverflow: document.body.scrollWidth > innerWidth,
    };
  })()`);
  assert.ok(compactChatAudit.sourceWidth >= 200 && compactChatAudit.sourceWidth <= 210, "紧凑窗口检材栏宽度异常");
  assert.ok(compactChatAudit.chatWidth >= 300 && compactChatAudit.chatWidth <= 320, "紧凑窗口会话栏宽度异常");
  assert.ok(compactChatAudit.messageWidth > compactChatAudit.chatWidth, "紧凑窗口仍应优先保留消息区");
  assert.equal(compactChatAudit.horizontalOverflow, false, "紧凑聊天页不应出现横向溢出");
  layoutAudit.chatPageCompact = compactChatAudit;
  screenshots.push(await screenshot("04-chat-page-wide", 1920, 1080));
  await clickRowContaining(".source-row", "Alex 的 Android 手机");
  await waitForText("项目协调群");
  await clickRowContaining(".chat-row", "项目协调群");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
  await evaluate(`(() => {
    const viewport = document.querySelector(".message-viewport");
    if (!viewport) return false;
    viewport.scrollTop = 250;
    return true;
  })()`);
  await waitFor(
    `document.querySelector(".image-preview img")?.complete === true && document.querySelector(".image-preview img")?.naturalWidth > 0`,
    "图片媒体加载完成",
  );
  screenshots.push(await screenshot("05-chat-media", 1440, 900));
  await clickButton("设置");
  await waitForText("软件数据目录");
  assert.equal(
    await evaluate(`document.querySelector('button[aria-label="设置"] .rail-button__label') === null`),
    true,
    "设置导航按钮应只显示图标",
  );
  screenshots.push(await screenshot("06-settings", 1120, 720));
}

assert.deepEqual(runtimeErrors, [], `渲染进程出现错误：${runtimeErrors.join("；")}`);
const metrics = await evaluate(`({
  bodyWidth: document.body.scrollWidth,
  bodyHeight: document.body.scrollHeight,
  viewportWidth: innerWidth,
  viewportHeight: innerHeight,
  horizontalOverflow: document.body.scrollWidth > innerWidth,
  text: document.body.innerText.slice(0, 1600)
})`);
process.stdout.write(`${JSON.stringify({ screenshots, layoutAudit, metrics }, null, 2)}\n`);
if (closeAfterCapture) {
  try {
    await Promise.race([
      command("Browser.close"),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 500)),
    ]);
  } catch {
    socket.close();
  }
} else {
  socket.close();
}

async function waitForTargets(targetPort) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${targetPort}/json/list`);
      if (response.ok) return await response.json();
    } catch {
      // Electron is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 160));
  }
  throw new Error("等待 Electron 调试端口超时");
}
