import assert from "node:assert/strict";

const argumentsMap = new Map(process.argv.slice(2).map((argument) => {
  const separator = argument.indexOf("=");
  return separator === -1
    ? [argument, "true"]
    : [argument.slice(0, separator), argument.slice(separator + 1)];
}));
const port = Number(argumentsMap.get("--port") ?? "9334");
const urls = (argumentsMap.get("--urls") ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
assert.ok(urls.length > 0, "必须通过 --urls 提供至少一个媒体 URL");

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
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const handlers = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) handlers.reject(new Error(JSON.stringify(message.error)));
  else handlers.resolve(message.result);
});

function command(method, params = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const response = await command("Runtime.evaluate", {
  expression: `Promise.all(${JSON.stringify(urls)}.map((url) => new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => resolve({
      url,
      loaded: true,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    }), { once: true });
    image.addEventListener("error", () => resolve({ url, loaded: false }), { once: true });
    image.src = url;
  })))`,
  awaitPromise: true,
  returnByValue: true,
});
if (response.exceptionDetails) {
  throw new Error(response.exceptionDetails.exception?.description ?? "页面脚本执行失败");
}
process.stdout.write(`${JSON.stringify(response.result.value, null, 2)}\n`);
socket.close();

async function waitForTargets(debugPort) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (response.ok) return response.json();
    } catch {
      // Electron may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
  }
  throw new Error(`等待 Electron 调试端口超时：${debugPort}`);
}
