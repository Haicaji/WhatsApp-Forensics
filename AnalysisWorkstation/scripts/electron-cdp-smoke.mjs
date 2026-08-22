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
const settingsOnly = argumentsMap.get("--settings") === "true";

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
if (settingsOnly) {
  await clickButton("设置");
  await waitForText("数据目录");
  layoutAudit = await evaluate(`(() => {
    const settingsButton = document.querySelector('.navigation-rail .rail-button[aria-label="设置"]');
    const settingsHeader = document.querySelector('.settings-page .page-header');
    const settingsList = document.querySelector('.settings-page .settings-list');
    settingsButton?.focus();
    const activeButton = document.querySelector('.navigation-rail .rail-button--active');
    const activeStyle = activeButton ? getComputedStyle(activeButton) : null;
    const focusStyle = settingsButton ? getComputedStyle(settingsButton) : null;
    const settingsHeaderRect = settingsHeader?.getBoundingClientRect();
    const settingsListRect = settingsList?.getBoundingClientRect();
    return {
      title: document.querySelector('.settings-page .page-header h1')?.textContent?.trim() ?? null,
      headerParagraphCount: document.querySelectorAll('.settings-page .page-header p').length,
      pageKickerCount: document.querySelectorAll('.settings-page .page-kicker').length,
      settingRowCount: document.querySelectorAll('.settings-page .setting-row').length,
      rowLabel: document.querySelector('.settings-page .setting-row strong')?.textContent?.trim() ?? null,
      rowDescriptionCount: document.querySelectorAll('.settings-page .setting-row p').length,
      rowIconCount: document.querySelectorAll('.settings-page .setting-row__icon').length,
      noticeCount: document.querySelectorAll('.settings-page .settings-notice, .settings-page .notice-panel').length,
      openButtonCount: [...document.querySelectorAll('.settings-page button')]
        .filter((button) => button.textContent?.trim() === '打开目录').length,
      path: document.querySelector('.settings-page .setting-row code')?.textContent?.trim() ?? null,
      removedLabelsVisible: ['软件数据目录', '默认案件目录', '案件目录索引', '便携存储约束', '本机设置', '数据位置']
        .some((label) => document.querySelector('.settings-page')?.textContent?.includes(label)),
      activeButtonCount: document.querySelectorAll('.navigation-rail .rail-button--active').length,
      activeBackground: activeStyle?.backgroundColor ?? null,
      activeUsesPurple: activeStyle?.backgroundColor === 'rgb(101, 75, 232)',
      focusOutlineColor: focusStyle?.outlineColor ?? null,
      focusUsesPurple: focusStyle?.outlineColor === 'rgb(101, 75, 232)',
      topSpacerCount: document.querySelectorAll('.navigation-rail__top-spacer').length,
      headerToListGap: settingsHeaderRect && settingsListRect
        ? settingsListRect.top - settingsHeaderRect.bottom
        : null,
    };
  })()`);
  assert.equal(layoutAudit.title, "设置", "设置页标题应简化为设置");
  assert.equal(layoutAudit.headerParagraphCount, 0, "设置页顶部不应显示说明文字");
  assert.equal(layoutAudit.pageKickerCount, 0, "设置页不应显示本机设置提示");
  assert.equal(layoutAudit.settingRowCount, 1, "设置页只应显示一个数据目录设置");
  assert.equal(layoutAudit.rowLabel, "数据目录", "目录设置名称应统一为数据目录");
  assert.equal(layoutAudit.rowDescriptionCount, 0, "数据目录不应显示附加说明");
  assert.equal(layoutAudit.rowIconCount, 0, "数据目录不应显示装饰图标");
  assert.equal(layoutAudit.noticeCount, 0, "设置页不应显示便携存储提示框");
  assert.equal(layoutAudit.openButtonCount, 1, "数据目录应保留打开目录操作");
  assert.ok(layoutAudit.path, "数据目录应显示实际路径");
  assert.equal(layoutAudit.removedLabelsVisible, false, "已删除的目录概念不应继续显示");
  assert.equal(layoutAudit.activeButtonCount, 1, "工具栏应只标记当前设置入口");
  assert.equal(layoutAudit.activeUsesPurple, false, "工具栏选中态不应使用紫色背景");
  assert.equal(layoutAudit.focusUsesPurple, false, "工具栏键盘焦点不应使用紫色描边");
  assert.equal(layoutAudit.topSpacerCount, 0, "左侧工具栏顶部不应保留空占位");
  assert.ok(
    layoutAudit.headerToListGap >= 10 && layoutAudit.headerToListGap <= 18,
    `设置标题与数据目录间距应保持紧凑，实际为 ${layoutAudit.headerToListGap}px`,
  );
  screenshots.push(await screenshot("settings", 1440, 900));
  screenshots.push(await screenshot("settings", 1120, 720));
  await clickButton("设置");
  await waitFor(`document.querySelector('.case-management') !== null`, "再次点击设置返回案件中心");
  const settingsToggleAudit = await evaluate(`(() => ({
    settingsVisible: document.querySelector('.settings-page') !== null,
    caseManagementVisible: document.querySelector('.case-management') !== null,
    settingsActive: document.querySelector('button[aria-label="设置"]')?.getAttribute('aria-current') === 'page',
  }))()`);
  assert.equal(settingsToggleAudit.settingsVisible, false, "再次点击设置应关闭设置页");
  assert.equal(settingsToggleAudit.caseManagementVisible, true, "无案件时关闭设置应返回案件中心");
  assert.equal(settingsToggleAudit.settingsActive, false, "关闭设置后设置按钮不应保持选中");
  layoutAudit.settingsToggle = settingsToggleAudit;
} else if (emptyCaseOnly || emptyTaskOnly) {
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
      railLogoCount: document.querySelectorAll('.navigation-rail__logo').length,
      exitCaseButtonCount: document.querySelectorAll('button[aria-label="退出案件"]').length,
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
  assert.equal(layoutAudit.railLogoCount, 0, "案件中心左上角不应显示 Logo 按钮");
  assert.equal(layoutAudit.exitCaseButtonCount, 0, "未进入案件时不应显示退出案件按钮");
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
      const rail = document.querySelector('.navigation-rail');
      const taskNav = document.querySelector('.rail-button[aria-label="勘察"]');
      const chatNav = document.querySelector('.rail-button[aria-label="预览"]');
      const exitCase = document.querySelector('.rail-button[aria-label="退出案件"]');
      const settings = document.querySelector('.rail-button[aria-label="设置"]');
      const taskPanel = document.querySelector('.task-list-panel');
      const taskHeading = document.querySelector('.task-list-heading');
      const taskTableHeader = document.querySelector('.task-table-header');
      const buttons = [...(actions?.querySelectorAll('button') ?? [])];
      const taskHeadingRect = taskHeading?.getBoundingClientRect();
      const actionsRect = actions?.getBoundingClientRect();
      const titlebarRect = titlebar?.getBoundingClientRect();
      const railRect = rail?.getBoundingClientRect();
      const taskNavRect = taskNav?.getBoundingClientRect();
      const chatNavRect = chatNav?.getBoundingClientRect();
      const exitCaseRect = exitCase?.getBoundingClientRect();
      const settingsRect = settings?.getBoundingClientRect();
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
        railLogoCount: document.querySelectorAll('.navigation-rail__logo').length,
        exitCaseButtonCount: document.querySelectorAll('.rail-button[aria-label="退出案件"]').length,
        exitCaseLabelVisible: exitCase?.querySelector('.rail-button__label') !== null,
        exitCaseAboveSettings: exitCaseRect && settingsRect
          ? exitCaseRect.bottom <= settingsRect.top
          : false,
        railSeparatorCount: document.querySelectorAll('.navigation-rail__separator').length,
        topSpacerCount: document.querySelectorAll('.navigation-rail__top-spacer').length,
        railStartsWithTask: taskNavRect && railRect
          ? taskNavRect.top - railRect.top <= 12
          : false,
        compactRailGroup: taskNavRect && chatNavRect
          ? chatNavRect.top - taskNavRect.bottom <= 12
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
    assert.equal(taskPageAudit.railLogoCount, 0, "案件工作区左上角不应显示 Logo 按钮");
    assert.equal(taskPageAudit.exitCaseButtonCount, 1, "进入案件后应显示退出案件按钮");
    assert.equal(taskPageAudit.exitCaseLabelVisible, false, "退出案件按钮应只显示图标");
    assert.equal(taskPageAudit.exitCaseAboveSettings, true, "退出案件按钮应位于设置按钮上方");
    assert.equal(taskPageAudit.railSeparatorCount, 1, "任务和聊天之间应保留一条分隔线");
    assert.equal(taskPageAudit.topSpacerCount, 0, "案件工具栏顶部不应保留空占位");
    assert.equal(taskPageAudit.railStartsWithTask, true, "任务入口应从工具栏顶部开始排列");
    assert.equal(taskPageAudit.compactRailGroup, true, "任务和聊天应紧凑排列");
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
    await click('[role="dialog"] button[aria-label="关闭"]');
    await waitFor(`document.querySelector('[role="dialog"]') === null`, "关闭分配任务弹窗");
    await clickButton("设置");
    await waitForText("数据目录");
    await clickButton("设置");
    await waitFor(`document.querySelector('.task-page') !== null`, "再次点击设置返回任务页");
    const settingsToggleFromCaseAudit = await evaluate(`(() => ({
      settingsVisible: document.querySelector('.settings-page') !== null,
      taskVisible: document.querySelector('.task-page') !== null,
      settingsActive: document.querySelector('button[aria-label="设置"]')?.getAttribute('aria-current') === 'page',
      taskActive: document.querySelector('button[aria-label="勘察"]')?.getAttribute('aria-current') === 'page',
    }))()`);
    assert.equal(settingsToggleFromCaseAudit.settingsVisible, false, "再次点击设置应关闭设置页");
    assert.equal(settingsToggleFromCaseAudit.taskVisible, true, "案件内关闭设置应返回原任务页");
    assert.equal(settingsToggleFromCaseAudit.settingsActive, false, "关闭设置后设置按钮不应保持选中");
    assert.equal(settingsToggleFromCaseAudit.taskActive, true, "关闭设置后应恢复原任务入口选中态");
    layoutAudit.settingsToggleFromCase = settingsToggleFromCaseAudit;
    await click('button[aria-label="退出案件"]');
    await waitFor(`document.querySelector('.case-management') !== null`, "退出案件返回案件中心");
    assert.equal(
      await evaluate(`document.querySelector('button[aria-label="退出案件"]') === null`),
      true,
      "返回案件中心后应隐藏退出案件按钮",
    );
    screenshots.push(await screenshot("case-center-after-exit", 1120, 720));
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
      railLogoCount: document.querySelectorAll('.navigation-rail__logo').length,
      exitCaseButtonCount: document.querySelectorAll('button[aria-label="退出案件"]').length,
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
  assert.equal(caseManagementAudit.railLogoCount, 0, "案件中心左上角不应显示 Logo 按钮");
  assert.equal(caseManagementAudit.exitCaseButtonCount, 0, "案件中心不应显示退出案件按钮");
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
    const exitCase = document.querySelector('button[aria-label="退出案件"]');
    const settings = document.querySelector('button[aria-label="设置"]');
    const exitCaseRect = exitCase?.getBoundingClientRect();
    const settingsRect = settings?.getBoundingClientRect();
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
      railLogoCount: document.querySelectorAll('.navigation-rail__logo').length,
      exitCaseButtonCount: document.querySelectorAll('button[aria-label="退出案件"]').length,
      exitCaseLabelVisible: exitCase?.querySelector('.rail-button__label') !== null,
      exitCaseAboveSettings: exitCaseRect && settingsRect
        ? exitCaseRect.bottom <= settingsRect.top
        : false,
    };
  })()`);
  assert.equal(populatedTaskAudit.caseNameCount, 0, "任务页不应显示案件名");
  assert.equal(populatedTaskAudit.headingActionsSameRow, true, "任务操作应与已下发任务标题位于同一行");
  assert.equal(populatedTaskAudit.headingActionButtonCount, 2, "任务标题行应包含接收结果和分配任务");
  assert.equal(populatedTaskAudit.openTaskFolderButtonCount, 0, "任务行不应显示打开文件夹按钮");
  assert.equal(populatedTaskAudit.rowActionButtonCount, 1, "任务行只保留停用图标操作");
  assert.equal(populatedTaskAudit.disableButtonText, "", "停用操作不应显示文字");
  assert.equal(populatedTaskAudit.disableButtonTitle, "停用任务", "停用图标应保留可访问提示");
  assert.equal(populatedTaskAudit.railLogoCount, 0, "案件工作区左上角不应显示 Logo 按钮");
  assert.equal(populatedTaskAudit.exitCaseButtonCount, 1, "案件工作区应显示退出案件按钮");
  assert.equal(populatedTaskAudit.exitCaseLabelVisible, false, "退出案件按钮应只显示图标");
  assert.equal(populatedTaskAudit.exitCaseAboveSettings, true, "退出案件按钮应位于设置按钮上方");
  await click('.task-row__actions button[aria-label^="停用任务："]');
  await waitFor(`document.querySelector('[role="dialog"]')?.textContent?.includes('停用任务') === true`, "停用任务弹窗");
  const disableModalAudit = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return {
      title: dialog?.querySelector('h2')?.textContent?.trim() ?? null,
      descriptionCount: dialog?.querySelectorAll('.modal__header p').length ?? -1,
      warningCount: dialog?.querySelectorAll('.confirm-content, .confirm-content__icon').length ?? -1,
      actionLabels: [...(dialog?.querySelectorAll('.modal__actions button') ?? [])]
        .map((button) => button.textContent?.trim()),
      closeButtonCount: dialog?.querySelectorAll('button[aria-label="关闭"]').length ?? -1,
    };
  })()`);
  assert.equal(disableModalAudit.title, "停用任务", "停用弹窗应保留标题");
  assert.equal(disableModalAudit.descriptionCount, 0, "停用弹窗不应显示说明文字");
  assert.equal(disableModalAudit.warningCount, 0, "停用弹窗不应显示警示图标或确认文案");
  assert.deepEqual(disableModalAudit.actionLabels, ["确认停用"], "停用弹窗只保留确认操作");
  assert.equal(disableModalAudit.closeButtonCount, 1, "停用弹窗应保留关闭按钮");
  screenshots.push(await screenshot("02b-disable-task-modal", 1120, 720));
  await click('[role="dialog"] button[aria-label="关闭"]');
  await waitFor(`document.querySelector('[role="dialog"]') === null`, "关闭停用任务弹窗");
  layoutAudit.taskPagePopulated = populatedTaskAudit;
  layoutAudit.disableTaskModal = disableModalAudit;
  screenshots.push(await screenshot("02-task-page", 1120, 720));
  await clickButton("预览");
  await waitForText("Alex 的 Android 手机");
  await waitForText("现场工作社群");
  await waitFor(`document.querySelectorAll('.message-bubble, .system-message').length > 0`, "聊天消息加载");
  await setViewport(1440, 900);
  const chatPageAudit = await evaluate(`(() => {
    const workspace = document.querySelector('.chat-workspace');
    const sourcePane = document.querySelector('.source-pane');
    const whatsappEvidence = document.querySelector('.whatsapp-evidence');
    const featureRail = document.querySelector('.whatsapp-feature-rail');
    const chatPane = document.querySelector('.chat-pane');
    const messagePane = document.querySelector('.message-pane');
    const paneHeading = document.querySelector('.pane-heading');
    const sourceRows = [...document.querySelectorAll('.source-row')];
    const chatHeader = document.querySelector('.chat-pane__header');
    const conversationHeader = document.querySelector('.conversation-header');
    const firstChatRow = document.querySelector('.chat-row');
    const messageTime = document.querySelector('.message-bubble__meta time');
    const outerRail = document.querySelector('.navigation-rail');
    const innerButtons = [...document.querySelectorAll('.whatsapp-feature-button')];
    const profileButton = document.querySelector('[data-workspace-section="profile"]');
    const communityButton = document.querySelector('[data-workspace-section="communities"]');
    const outerRailRect = outerRail?.getBoundingClientRect();
    const featureRailRect = featureRail?.getBoundingClientRect();
    const profileRect = profileButton?.getBoundingClientRect();
    const communityRect = communityButton?.getBoundingClientRect();
    const chatRows = [...document.querySelectorAll('.chat-row')];
    const chatRowHeights = chatRows.map((row) => row.getBoundingClientRect().height);
    const announcementRow = chatRows.find((row) => row.getAttribute('data-community-role') === 'announcement');
    const childGroupRow = chatRows.find((row) => row.textContent?.includes('家人'));
    const standaloneRow = chatRows.find((row) => row.textContent?.includes('物流对接'));
    const conversationAvatar = conversationHeader?.querySelector('.conversation-header__avatar');
    const conversationAvatarImage = conversationAvatar?.querySelector('img.captured-avatar:not([hidden])');
    const conversationAvatarRect = conversationAvatar?.getBoundingClientRect();
    const conversationAvatarImageRect = conversationAvatarImage?.getBoundingClientRect();
    const conversationAvatarStyle = conversationAvatar ? getComputedStyle(conversationAvatar) : null;
    return {
      workspaceWidth: workspace?.getBoundingClientRect().width ?? 0,
      sourceWidth: sourcePane?.getBoundingClientRect().width ?? 0,
      evidenceWidth: whatsappEvidence?.getBoundingClientRect().width ?? 0,
      featureRailWidth: featureRailRect?.width ?? 0,
      chatWidth: chatPane?.getBoundingClientRect().width ?? 0,
      messageWidth: messagePane?.getBoundingClientRect().width ?? 0,
      paneHeadingHeight: paneHeading?.getBoundingClientRect().height ?? 0,
      accountHeadingText: paneHeading?.querySelector('h1')?.textContent?.trim() ?? null,
      accountKickerCount: paneHeading?.querySelectorAll('.page-kicker').length ?? -1,
      accountCountTextCount: paneHeading?.querySelectorAll(':scope > span').length ?? -1,
      sourceRowCount: sourceRows.length,
      sourceRowHeight: sourceRows[0]?.getBoundingClientRect().height ?? 0,
      sourceDecorativeIconCount: document.querySelectorAll('.source-row__icon').length,
      sourceSmallTextCount: document.querySelectorAll('.source-row small').length,
      sourceStatusCount: document.querySelectorAll('.source-status').length,
      sourceExportButtonCount: document.querySelectorAll('.source-row__export').length,
      chatHeaderHeight: chatHeader?.getBoundingClientRect().height ?? 0,
      conversationHeaderHeight: conversationHeader?.getBoundingClientRect().height ?? 0,
      firstChatRowHeight: firstChatRow?.getBoundingClientRect().height ?? 0,
      chatRowHeights,
      announcementCommunityText: announcementRow?.querySelector('.chat-row__community')?.textContent?.trim() ?? null,
      announcementTitle: announcementRow?.querySelector('.chat-row__topline strong')?.textContent?.trim() ?? null,
      announcementAvatarCount: announcementRow?.querySelectorAll('.chat-avatar__single').length ?? -1,
      announcementCapturedAvatarCount: announcementRow?.querySelectorAll('img.captured-avatar').length ?? -1,
      announcementPairCount: announcementRow?.querySelectorAll('.chat-avatar__pair').length ?? -1,
      childGroupCommunityText: childGroupRow?.querySelector('.chat-row__community')?.textContent?.trim() ?? null,
      childGroupAnnouncementLabelCount: childGroupRow?.querySelectorAll('.chat-row__community em').length ?? -1,
      childGroupPairCount: childGroupRow?.querySelectorAll('.chat-avatar__pair').length ?? -1,
      childGroupParentAvatarCount: childGroupRow?.querySelectorAll('.chat-avatar__community-parent').length ?? -1,
      childGroupChildAvatarCount: childGroupRow?.querySelectorAll('.chat-avatar__community-child').length ?? -1,
      childGroupCapturedAvatarCount: childGroupRow?.querySelectorAll('img.captured-avatar').length ?? -1,
      childGroupRole: childGroupRow?.getAttribute('data-community-role') ?? null,
      standaloneCommunityTextCount: standaloneRow?.querySelectorAll('.chat-row__community').length ?? -1,
      standaloneSingleAvatarCount: standaloneRow?.querySelectorAll('.chat-avatar__single').length ?? -1,
      standaloneCapturedAvatarCount: standaloneRow?.querySelectorAll('img.captured-avatar').length ?? -1,
      standaloneRole: standaloneRow?.getAttribute('data-community-role') ?? null,
      internalCommunityRowCount: chatRows.filter((row) => row.textContent?.includes('社群内部信息')).length,
      conversationCapturedAvatarCount: conversationHeader?.querySelectorAll('img.captured-avatar').length ?? -1,
      conversationAvatarBackground: conversationAvatarStyle?.backgroundColor ?? null,
      conversationAvatarBorderWidths: conversationAvatarStyle === null
        ? []
        : [
            conversationAvatarStyle.borderTopWidth,
            conversationAvatarStyle.borderRightWidth,
            conversationAvatarStyle.borderBottomWidth,
            conversationAvatarStyle.borderLeftWidth,
          ],
      conversationAvatarImageFillsFrame: conversationAvatarRect && conversationAvatarImageRect
        ? Math.abs(conversationAvatarRect.width - conversationAvatarImageRect.width) < 0.5
          && Math.abs(conversationAvatarRect.height - conversationAvatarImageRect.height) < 0.5
        : false,
      loadedCapturedAvatarCount: [...document.querySelectorAll('img.captured-avatar')]
        .filter((image) => image.complete && image.naturalWidth > 0).length,
      brokenCapturedAvatarCount: [...document.querySelectorAll('img.captured-avatar')]
        .filter((image) => image.complete && image.naturalWidth === 0).length,
      searchPlaceholder: chatHeader?.querySelector('input')?.getAttribute('placeholder') ?? null,
      dateSeparatorCount: document.querySelectorAll('.message-date-separator').length,
      messageTime: messageTime?.textContent?.trim() ?? null,
      composeControlCount: messagePane?.querySelectorAll('input, textarea').length ?? -1,
      internalButtonCount: innerButtons.length,
      internalButtonLabels: innerButtons.map((button) => button.getAttribute('aria-label')),
      internalRailDistinctFromOuter: outerRailRect && featureRailRect
        ? featureRailRect.left >= outerRailRect.right
          && getComputedStyle(featureRail).backgroundColor !== getComputedStyle(outerRail).backgroundColor
        : false,
      profileAnchoredAtBottom: profileRect && communityRect
        ? profileRect.top > communityRect.bottom + 100
        : false,
      horizontalOverflow: document.body.scrollWidth > innerWidth,
    };
  })()`);
  assert.ok(chatPageAudit.sourceWidth >= 200 && chatPageAudit.sourceWidth <= 240, "账号栏应保持紧凑");
  assert.ok(chatPageAudit.featureRailWidth >= 54 && chatPageAudit.featureRailWidth <= 58, "WhatsApp 内部功能栏宽度异常");
  assert.ok(chatPageAudit.chatWidth >= 340 && chatPageAudit.chatWidth <= 390, "会话栏应采用紧凑 WhatsApp 式宽度");
  assert.ok(chatPageAudit.messageWidth > chatPageAudit.chatWidth, "消息区应是聊天页的主要区域");
  assert.equal(chatPageAudit.paneHeadingHeight, chatPageAudit.chatHeaderHeight, "账号栏与会话栏头部应对齐");
  assert.equal(chatPageAudit.accountHeadingText, "WhatsApp 账号", "账号栏标题错误");
  assert.equal(chatPageAudit.accountKickerCount, 0, "账号栏不应显示检材标签");
  assert.equal(chatPageAudit.accountCountTextCount, 0, "账号栏不应显示检材数量");
  assert.ok(chatPageAudit.sourceRowHeight >= 58 && chatPageAudit.sourceRowHeight <= 62, "账号项应保持单行紧凑高度");
  assert.equal(chatPageAudit.sourceDecorativeIconCount, 0, "账号项不应显示左侧装饰图标");
  assert.equal(chatPageAudit.sourceSmallTextCount, 0, "账号项不应显示会话和消息统计小字");
  assert.equal(chatPageAudit.sourceStatusCount, 0, "账号项不应显示采集状态");
  assert.equal(chatPageAudit.sourceExportButtonCount, chatPageAudit.sourceRowCount, "每个账号都应提供离线 Web 预览导出图标");
  assert.ok(chatPageAudit.conversationHeaderHeight >= 60 && chatPageAudit.conversationHeaderHeight <= 68, "会话顶栏高度应紧凑稳定");
  assert.ok(chatPageAudit.firstChatRowHeight >= 84 && chatPageAudit.firstChatRowHeight <= 92, "会话项应容纳所属社群关系且保持紧凑");
  assert.ok(chatPageAudit.chatRowHeights.length > 1, "会话行高检查需要覆盖多个对话");
  assert.ok(
    Math.max(...chatPageAudit.chatRowHeights) - Math.min(...chatPageAudit.chatRowHeights) < 0.5,
    "所有独立对话、群聊和社群对话必须使用一致行高",
  );
  assert.equal(chatPageAudit.announcementCommunityText, null, "社群主对话不应重复显示社群归属标签");
  assert.equal(chatPageAudit.announcementTitle, "现场工作社群", "社群主对话应直接使用社群名称");
  assert.equal(chatPageAudit.announcementAvatarCount, 1, "社群主对话应使用单头像");
  assert.equal(chatPageAudit.announcementCapturedAvatarCount, 1, "社群主对话应渲染采集到的社群头像");
  assert.equal(chatPageAudit.announcementPairCount, 0, "社群主对话不应使用子群双头像");
  assert.equal(chatPageAudit.childGroupCommunityText, "现场工作社群", "普通子群应显示所属社群");
  assert.equal(chatPageAudit.childGroupAnnouncementLabelCount, 0, "普通子群不应被标记为公告群");
  assert.equal(chatPageAudit.childGroupPairCount, 1, "普通社群子群应显示双头像关系");
  assert.equal(chatPageAudit.childGroupParentAvatarCount, 1, "普通社群子群应显示父社群头像");
  assert.equal(chatPageAudit.childGroupChildAvatarCount, 1, "普通社群子群应显示子群头像");
  assert.equal(chatPageAudit.childGroupCapturedAvatarCount, 2, "普通社群子群应渲染采集到的父子头像");
  assert.equal(chatPageAudit.childGroupRole, "group", "普通社群子群应保留结构化关系角色");
  assert.equal(chatPageAudit.standaloneCommunityTextCount, 0, "独立对话不应伪造社群归属");
  assert.equal(chatPageAudit.standaloneSingleAvatarCount, 1, "独立对话应保持单头像");
  assert.equal(chatPageAudit.standaloneCapturedAvatarCount, 1, "独立对话应渲染采集到的头像");
  assert.equal(chatPageAudit.standaloneRole, "standalone", "独立对话应标记为无社群归属");
  assert.equal(chatPageAudit.internalCommunityRowCount, 0, "社群内部记录不应出现在对话栏");
  assert.equal(chatPageAudit.conversationCapturedAvatarCount, 1, "会话顶栏应渲染采集到的头像");
  assert.equal(chatPageAudit.conversationAvatarBackground, "rgba(0, 0, 0, 0)", "已加载头像不应透出深蓝底圈");
  assert.deepEqual(chatPageAudit.conversationAvatarBorderWidths, ["0px", "0px", "0px", "0px"], "会话顶栏头像不应有边框");
  assert.equal(chatPageAudit.conversationAvatarImageFillsFrame, true, "会话顶栏头像应完整填满圆形裁切区域");
  assert.ok(chatPageAudit.loadedCapturedAvatarCount >= 1, "至少一个采集头像应完成解码");
  assert.equal(chatPageAudit.brokenCapturedAvatarCount, 0, "采集头像不应出现加载失败");
  assert.equal(chatPageAudit.searchPlaceholder, "搜索对话", "对话搜索提示应明确");
  assert.ok(chatPageAudit.dateSeparatorCount >= 1, "消息流应显示日期分隔");
  assert.equal(chatPageAudit.messageTime?.includes("/"), false, "消息气泡内应只显示时间");
  assert.match(chatPageAudit.messageTime ?? "", /UTC[+-]\d{2}:\d{2}/u, "消息时间应明确显示 UTC 偏移");
  assert.equal(chatPageAudit.composeControlCount, 0, "取证预览不应出现虚假的消息输入控件");
  assert.equal(chatPageAudit.internalButtonCount, 6, "WhatsApp 内部功能栏应包含五个功能和个人资料");
  assert.deepEqual(
    chatPageAudit.internalButtonLabels,
    ["对话", "通话", "动态", "频道", "社群", "个人资料"],
    "WhatsApp 内部功能栏顺序错误",
  );
  assert.equal(chatPageAudit.internalRailDistinctFromOuter, true, "WhatsApp 功能栏必须与软件主功能栏明确区分");
  assert.equal(chatPageAudit.profileAnchoredAtBottom, true, "个人资料按钮应固定在内部功能栏底部");
  assert.equal(chatPageAudit.horizontalOverflow, false, "聊天页不应出现横向溢出");
  layoutAudit.chatPage = chatPageAudit;
  screenshots.push(await screenshot("03-chat-page", 1440, 900));

  await click('[data-workspace-section="calls"]');
  await waitForText("最近通话");
  await waitForText("物流对接");
  assert.equal(
    await evaluate(`document.querySelector('.feature-detail')?.textContent.includes('只读证据预览') === false`),
    true,
    "有通话记录时应直接显示选中记录详情",
  );
  screenshots.push(await screenshot("03c-whatsapp-calls", 1440, 900));
  await click('[data-workspace-section="statuses"]');
  await waitForText("设备清点完成");
  await click('[data-workspace-section="channels"]');
  await waitForText("现场通知频道");
  await waitForText("第二阶段采集已开始");
  await waitFor(
    `document.querySelectorAll('.channel-message').length >= 4`,
    "频道消息流加载",
  );
  await waitFor(
    `document.querySelector('.channel-message .image-preview img')?.complete === true
      && document.querySelector('.channel-message .image-preview img')?.naturalWidth > 0`,
    "频道图片加载",
  );
  await waitFor(
    `document.querySelector('.feature-row__avatar .captured-avatar')?.complete === true
      && document.querySelector('.feature-row__avatar .captured-avatar')?.naturalWidth > 0
      && document.querySelector('.channel-feed__avatar .captured-avatar')?.complete === true
      && document.querySelector('.channel-feed__avatar .captured-avatar')?.naturalWidth > 0`,
    "频道头像加载",
  );
  const channelAudit = await evaluate(`(() => ({
    messageCount: document.querySelectorAll('.channel-message').length,
    dateSeparatorCount: document.querySelectorAll('.channel-feed .message-date-separator').length,
    headerTitle: document.querySelector('.channel-feed__identity h1')?.textContent?.trim() ?? null,
    imageCount: document.querySelectorAll('.channel-message .image-preview img').length,
    listAvatarCount: document.querySelectorAll('.feature-row__avatar .captured-avatar:not([hidden])').length,
    headerAvatarCount: document.querySelectorAll('.channel-feed__avatar .captured-avatar:not([hidden])').length,
    summaryPanelCount: document.querySelectorAll('.feature-record-detail__preview').length,
    horizontalOverflow: document.body.scrollWidth > innerWidth,
  }))()`);
  assert.ok(channelAudit.messageCount >= 4, "频道应逐条显示已采集消息");
  assert.ok(channelAudit.dateSeparatorCount >= 1, "频道消息流应显示日期分隔");
  assert.equal(channelAudit.headerTitle, "现场通知频道", "频道消息区顶部应显示选中频道");
  assert.ok(channelAudit.imageCount >= 1, "频道媒体应通过安全协议显示");
  assert.ok(channelAudit.listAvatarCount >= 1, "频道列表应显示采集头像");
  assert.equal(channelAudit.headerAvatarCount, 1, "频道消息区顶部应显示采集头像");
  assert.equal(channelAudit.summaryPanelCount, 0, "频道不应继续显示旧的单条摘要详情");
  assert.equal(channelAudit.horizontalOverflow, false, "频道消息流不应造成横向溢出");
  layoutAudit.channelPage = channelAudit;
  screenshots.push(await screenshot("03d-whatsapp-channels", 1440, 900));
  await click('[data-workspace-section="communities"]');
  await waitForText("现场工作社群");
  await waitForText("你所在的群组");
  const communityAudit = await evaluate(`(() => ({
    searchInputCount: document.querySelectorAll('.community-pane input').length,
    collectionCount: document.querySelectorAll('.community-collection').length,
    announcementCount: document.querySelectorAll('[data-community-child-role="announcement"]').length,
    mainConversationText: document.querySelector('[data-community-child-role="announcement"] strong')?.textContent?.trim() ?? null,
    regularGroupCount: document.querySelectorAll('[data-community-child-role="group"]').length,
    selectedDetailTitle: document.querySelector('.community-detail__identity h1')?.textContent?.trim() ?? null,
    headingExpanded: document.querySelector('.community-collection__heading')?.getAttribute('aria-expanded') ?? null,
    interactiveChildCount: document.querySelectorAll('button.community-child-row').length,
    interactiveDetailCount: document.querySelectorAll('button.community-detail-group').length,
    containsStandaloneGroup: document.querySelector('.community-collection-list')?.textContent?.includes('独立普通群聊') ?? true,
    containsBooleanPseudoGroup: /(^|\\s)(true|false)(\\s|$)/u.test(
      document.querySelector('.community-collection-list')?.textContent ?? ''
    ),
  }))()`);
  assert.equal(communityAudit.searchInputCount, 0, "社群页不应显示搜索框");
  assert.equal(communityAudit.collectionCount, 1, "普通群聊不应被提升为独立社群");
  assert.equal(communityAudit.announcementCount, 1, "社群合集应保留一个主对话关系");
  assert.equal(communityAudit.mainConversationText, "现场工作社群", "社群主对话应直接使用社群名称");
  assert.equal(communityAudit.regularGroupCount, 1, "社群合集应嵌套显示所属群组");
  assert.equal(communityAudit.selectedDetailTitle, "现场工作社群", "右侧应展示选中的社群合集");
  assert.equal(communityAudit.headingExpanded, "true", "社群合集默认应展开");
  assert.equal(communityAudit.interactiveChildCount, 2, "社群主对话和子群应可点击打开预览");
  assert.equal(communityAudit.interactiveDetailCount, 2, "社群详情中的主对话和子群应可点击打开预览");
  assert.equal(communityAudit.containsStandaloneGroup, false, "社群列表不应包含未关联普通群聊");
  assert.equal(communityAudit.containsBooleanPseudoGroup, false, "社群列表不应显示 true/false 伪群组");
  screenshots.push(await screenshot("03de-whatsapp-communities", 1440, 900));
  await click('.community-collection__heading');
  await waitFor(
    `document.querySelector('.community-collection__heading')?.getAttribute('aria-expanded') === 'false'
      && document.querySelectorAll('.community-child-row').length === 0`,
    "折叠社群合集",
  );
  await click('.community-collection__heading');
  await waitFor(
    `document.querySelector('.community-collection__heading')?.getAttribute('aria-expanded') === 'true'
      && document.querySelectorAll('.community-child-row').length === 2`,
    "展开社群合集",
  );
  await click('[data-community-child-role="announcement"]');
  await waitFor(
    `document.querySelector('[data-workspace-section="chats"]')?.getAttribute('aria-pressed') === 'true'
      && document.querySelector('.chat-row--selected')?.getAttribute('data-community-role') === 'announcement'
      && document.querySelector('.conversation-header h2')?.textContent?.trim() === '现场工作社群'`,
    "从社群主对话进入聊天预览",
  );
  await click('[data-workspace-section="communities"]');
  await waitForText("你所在的群组");
  await click('button.community-detail-group--group');
  await waitFor(
    `document.querySelector('[data-workspace-section="chats"]')?.getAttribute('aria-pressed') === 'true'
      && document.querySelector('.chat-row--selected')?.getAttribute('data-community-role') === 'group'
      && document.querySelector('.conversation-header h2')?.textContent?.trim() === '家人'`,
    "从社群子群进入聊天预览",
  );
  layoutAudit.communityPage = communityAudit;
  await click('[data-workspace-section="profile"]');
  await waitForText("账号标识");
  await waitForText("移动终端采集账号");
  const profileAudit = await evaluate(`(() => ({
    profileMenuRows: document.querySelectorAll('.profile-menu__row').length,
    profileHeaderSubtitleCount: document.querySelectorAll('.profile-pane__header p').length,
    collectionInfoLabelCount: [...document.querySelectorAll('.profile-pane *')]
      .filter((element) => element.textContent?.trim() === '采集信息').length,
    headerText: document.querySelector('.profile-pane__header')?.textContent?.trim() ?? '',
  }))()`);
  assert.equal(profileAudit.profileMenuRows, 1, "账号页只保留账号资料入口");
  assert.equal(profileAudit.profileHeaderSubtitleCount, 0, "账号页顶部不应显示检材名副标题");
  assert.equal(profileAudit.collectionInfoLabelCount, 0, "账号页不应显示采集信息入口");
  assert.equal(profileAudit.headerText.includes('Alex 的 Android 手机'), false, "账号页顶部不应显示检材名");
  assert.equal(profileAudit.headerText.includes('商务沟通备用机'), false, "账号页顶部不应显示检材名");
  layoutAudit.profilePage = profileAudit;
  screenshots.push(await screenshot("03e-whatsapp-profile", 1440, 900));
  await click('[data-workspace-section="chats"]');
  await waitFor(`document.querySelectorAll('.message-bubble, .system-message').length > 0`, "返回对话消息");
  await click('.chat-row .chat-avatar');
  await waitFor(`document.querySelector('.conversation-info') !== null`, "打开会话资料侧栏");
  const infoDrawerAudit = await evaluate(`(() => ({
    title: document.querySelector('.conversation-info__header h2')?.textContent?.trim() ?? null,
    nativeIdVisible: document.querySelector('.conversation-info')?.textContent.includes('WhatsApp 标识') ?? false,
    mediaSummaryVisible: document.querySelector('.conversation-info')?.textContent.includes('影音内容、链接和文档') ?? false,
    starredSummaryVisible: document.querySelector('.conversation-info')?.textContent.includes('已加星标消息') ?? false,
    fakeEditControls: [...(document.querySelector('.conversation-info')?.querySelectorAll('button') ?? [])]
      .filter((button) => button.getAttribute('aria-label') !== '关闭资料').length,
  }))()`);
  assert.equal(infoDrawerAudit.title, "群组信息", "群聊头像应打开群组信息侧栏");
  assert.equal(infoDrawerAudit.nativeIdVisible, true, "资料侧栏应显示原生 WhatsApp 标识");
  assert.equal(infoDrawerAudit.mediaSummaryVisible, true, "资料侧栏应显示媒体索引摘要");
  assert.equal(infoDrawerAudit.starredSummaryVisible, true, "资料侧栏应显示标星消息摘要");
  assert.equal(infoDrawerAudit.fakeEditControls, 0, "只读资料侧栏不应出现编辑、拨号或搜索等伪操作");
  layoutAudit.infoDrawer = infoDrawerAudit;
  screenshots.push(await screenshot("03f-chat-info-drawer", 1440, 900));
  await click('[aria-label="关闭资料"]');
  await clickRowContaining('.chat-row', '物流对接');
  await waitFor(
    `document.querySelector('.conversation-header h2')?.textContent?.trim() === '物流对接'`,
    "打开联系人对话",
  );
  await click('.chat-row--selected .chat-avatar');
  await waitFor(`document.querySelector('.conversation-info') !== null`, "打开联系人资料侧栏");
  const contactInfoAudit = await evaluate(`(() => ({
    title: document.querySelector('.conversation-info__header h2')?.textContent?.trim() ?? null,
    text: document.querySelector('.conversation-info')?.textContent ?? '',
  }))()`);
  assert.equal(contactInfoAudit.title, "联系人信息", "个人对话头像应打开联系人信息侧栏");
  assert.match(contactInfoAudit.text, /电话号码/u, "联系人资料侧栏应显示电话号码字段");
  assert.match(contactInfoAudit.text, /\+8613664182073/u, "联系人资料侧栏应显示采集到的电话号码");
  layoutAudit.contactInfoDrawer = contactInfoAudit;
  screenshots.push(await screenshot("03g-contact-info-drawer", 1440, 900));
  await click('[aria-label="关闭资料"]');
  screenshots.push(await screenshot("03b-chat-page-compact", 1120, 720));
  const compactChatAudit = await evaluate(`(() => {
    const sourcePane = document.querySelector('.source-pane');
    const featureRail = document.querySelector('.whatsapp-feature-rail');
    const chatPane = document.querySelector('.chat-pane');
    const messagePane = document.querySelector('.message-pane');
    return {
      sourceWidth: sourcePane?.getBoundingClientRect().width ?? 0,
      featureRailWidth: featureRail?.getBoundingClientRect().width ?? 0,
      chatWidth: chatPane?.getBoundingClientRect().width ?? 0,
      messageWidth: messagePane?.getBoundingClientRect().width ?? 0,
      horizontalOverflow: document.body.scrollWidth > innerWidth,
    };
  })()`);
  assert.ok(compactChatAudit.sourceWidth >= 200 && compactChatAudit.sourceWidth <= 210, "紧凑窗口检材栏宽度异常");
  assert.ok(compactChatAudit.featureRailWidth >= 52 && compactChatAudit.featureRailWidth <= 56, "紧凑窗口内部功能栏宽度异常");
  assert.ok(compactChatAudit.chatWidth >= 288 && compactChatAudit.chatWidth <= 296, "紧凑窗口对话栏宽度异常");
  assert.ok(compactChatAudit.messageWidth > compactChatAudit.chatWidth, "紧凑窗口仍应优先保留消息区");
  assert.equal(compactChatAudit.horizontalOverflow, false, "紧凑聊天页不应出现横向溢出");
  layoutAudit.chatPageCompact = compactChatAudit;
  screenshots.push(await screenshot("04-chat-page-wide", 1920, 1080));
  await clickRowContaining(".source-row__select", "Alex 的 Android 手机");
  await waitForText("现场工作社群");
  await click('[data-community-role="announcement"]');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
  await evaluate(`(() => {
    const viewport = document.querySelector(".message-viewport");
    if (!viewport) return false;
    // The chat view now has a fixed WhatsApp-style header and internal rail.
    // Put the synthetic image message inside the visible viewport so Chromium's
    // native lazy-loading policy actually requests the asset.
    viewport.scrollTop = 650;
    viewport.dispatchEvent(new Event("scroll"));
    return true;
  })()`);
  await waitFor(
    `document.querySelector(".image-preview img")?.complete === true && document.querySelector(".image-preview img")?.naturalWidth > 0`,
    "图片媒体加载完成",
  );
  await evaluate(`(() => {
    const image = document.querySelector(".message-pane .image-preview img");
    image?.scrollIntoView({ block: "center", inline: "nearest" });
    return Boolean(image);
  })()`);
  screenshots.push(await screenshot("05-chat-media", 1440, 900));
  await clickButton("设置");
  await waitForText("数据目录");
  assert.equal(
    await evaluate(`document.querySelector('button[aria-label="设置"] .rail-button__label') === null`),
    true,
    "设置导航按钮应只显示图标",
  );
  screenshots.push(await screenshot("06-settings", 1120, 720));
  await clickButton("设置");
  await waitFor(`document.querySelector('.chat-workspace') !== null`, "再次点击设置返回聊天页");
  const settingsToggleFromCaseAudit = await evaluate(`(() => ({
    settingsVisible: document.querySelector('.settings-page') !== null,
    chatVisible: document.querySelector('.chat-workspace') !== null,
    settingsActive: document.querySelector('button[aria-label="设置"]')?.getAttribute('aria-current') === 'page',
    chatActive: document.querySelector('button[aria-label="预览"]')?.getAttribute('aria-current') === 'page',
  }))()`);
  assert.equal(settingsToggleFromCaseAudit.settingsVisible, false, "再次点击设置应关闭设置页");
  assert.equal(settingsToggleFromCaseAudit.chatVisible, true, "案件内关闭设置应返回原聊天页");
  assert.equal(settingsToggleFromCaseAudit.settingsActive, false, "关闭设置后设置按钮不应保持选中");
  assert.equal(settingsToggleFromCaseAudit.chatActive, true, "关闭设置后应恢复原聊天入口选中态");
  layoutAudit.settingsToggleFromCase = settingsToggleFromCaseAudit;
  await click('button[aria-label="退出案件"]');
  await waitFor(`document.querySelector('.case-management') !== null`, "退出案件返回案件中心");
  assert.equal(
    await evaluate(`document.querySelector('button[aria-label="退出案件"]') === null`),
    true,
    "返回案件中心后应隐藏退出案件按钮",
  );
  layoutAudit.exitCase = { returnedToCaseCenter: true, hiddenAfterExit: true };
  screenshots.push(await screenshot("07-case-center-after-exit", 1120, 720));
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
