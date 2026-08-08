import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const argumentsMap = new Map(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    return separator === -1
      ? [argument, "true"]
      : [argument.slice(0, separator), argument.slice(separator + 1)];
  }),
);
const port = Number(argumentsMap.get("--port") ?? "9333");
const mode = argumentsMap.get("--mode") ?? "capture";
const outputDirectory = resolve(
  argumentsMap.get("--output") ?? ".e2e-artifacts",
);

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(
  (candidate) =>
    candidate.type === "page" && candidate.url === "wafc://app/index.html",
);
assert.ok(target?.webSocketDebuggerUrl, "未找到 Analysis Workstation 渲染页面");

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
    runtimeErrors.push(message.params.exceptionDetails.text);
  }
  if (
    message.method === "Log.entryAdded" &&
    ["error", "warning"].includes(message.params.entry.level)
  ) {
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
    if (await evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`等待界面文本超时：${text}`);
}

async function clickButton(text, modalOnly = false) {
  const clicked = await evaluate(`(() => {
    const text = ${JSON.stringify(text)};
    const root = ${modalOnly ? 'document.querySelector("[role=dialog]")' : "document"};
    if (!root) return false;
    const button = [...root.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim().includes(text));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `找不到按钮：${text}`);
}

async function fillForm(values, textareaValue = null) {
  const filled = await evaluate(`(() => {
    const values = ${JSON.stringify(values)};
    const inputs = [...document.querySelectorAll("input")];
    if (inputs.length < values.length) return false;
    const inputSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set;
    values.forEach((value, index) => {
      inputSetter.call(inputs[index], value);
      inputs[index].dispatchEvent(new Event("input", { bubbles: true }));
    });
    const textareaValue = ${JSON.stringify(textareaValue)};
    if (textareaValue !== null) {
      const textarea = document.querySelector("textarea");
      if (!textarea) return false;
      const textareaSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      ).set;
      textareaSetter.call(textarea, textareaValue);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  })()`);
  assert.equal(filled, true, "表单字段数量与预期不符");
}

async function screenshot(name) {
  mkdirSync(outputDirectory, { recursive: true });
  const result = await command("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const path = resolve(outputDirectory, `${name}.png`);
  writeFileSync(path, Buffer.from(result.data, "base64"));
  return path;
}

await Promise.all([
  command("Runtime.enable"),
  command("Page.enable"),
  command("Log.enable"),
]);
const screenshots = [];

if (mode === "onboarding") {
  await waitForText("WAFC ANALYSIS WORKSTATION");
  await waitForText("建立实验室信任身份");
  screenshots.push(await screenshot("01-onboarding"));
  await fillForm([
    "lab-ui-smoke-001",
    "workstation-config-ui-smoke-001",
    "visual-smoke-passphrase-2026",
    "visual-smoke-passphrase-2026",
  ]);
  await clickButton("初始化工作站");
  await waitForText("案件工作区", 30_000);
  screenshots.push(await screenshot("02-empty-case-list"));
  await clickButton("创建案件");
  await waitForText("聊天正文将进入该案件独立的 SQLite 数据库");
  await fillForm(
    ["case-ui-smoke", "UI 纵向验收案件", "AUTH-UI-SMOKE", "合成测试机构"],
    "仅包含合成数据的界面验收案件",
  );
  await clickButton("创建案件", true);
  await waitForText("UI 纵向验收案件", 20_000);
  screenshots.push(await screenshot("03-case-overview"));
} else if (mode === "review") {
  await waitForText("案件工作区");
  await waitForText("合成证据导入案件");
  screenshots.push(await screenshot("11-case-list-with-evidence"));
  await clickButton("合成证据导入案件");
  await waitForText("案件概览");
  screenshots.push(await screenshot("12-imported-case-overview"));
  await clickButton("聊天记录");
  await waitForText("合成测试会话");
  await waitForText("合成的测试消息");
  screenshots.push(await screenshot("13-chat-browser"));
  await clickButton("全文检索");
  await fillForm(["合成的测试消息"]);
  await waitForText("证据记录", 10_000);
  screenshots.push(await screenshot("14-message-search"));
  await clickButton("完整性");
  await waitForText("来源校验明细");
  screenshots.push(await screenshot("15-integrity"));
} else {
  screenshots.push(await screenshot("00-current"));
}

assert.deepEqual(runtimeErrors, [], `渲染进程出现错误：${runtimeErrors.join("；")}`);
const bodyText = await evaluate("document.body.innerText");
const inputValues = await evaluate(
  "[...document.querySelectorAll('input, textarea')].map((element) => element.value)",
);
socket.close();
process.stdout.write(
  `${JSON.stringify({ mode, screenshots, inputValues, bodyText: bodyText.slice(0, 2_000) }, null, 2)}\n`,
);
