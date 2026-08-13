"use strict";

const CODE_PATTERN = /^[2-9A-HJ-NP-Z]{10}$/;
const input = document.getElementById("pairing-code");
const connectButton = document.getElementById("connect");
const status = document.getElementById("status");

function renderStatus(message, tone = "neutral") {
  status.textContent = message;
  status.dataset.tone = tone;
}

function normalizeCode(value) {
  return String(value || "").toUpperCase().replace(/[^2-9A-HJ-NP-Z]/g, "").slice(0, 10);
}

input.addEventListener("input", () => {
  input.value = normalizeCode(input.value);
});

connectButton.addEventListener("click", async () => {
  const pairingCode = normalizeCode(input.value);
  input.value = pairingCode;
  if (!CODE_PATTERN.test(pairingCode)) {
    renderStatus("请输入 Collector 显示的 10 位一次性配对码。", "error");
    input.focus();
    return;
  }
  connectButton.disabled = true;
  renderStatus("正在核对当前 WhatsApp 页面并建立只读连接……");
  try {
    const response = await chrome.runtime.sendMessage({
      kind: "begin_pairing",
      pairingCode,
    });
    if (!response || response.ok !== true) {
      renderStatus(response?.message || "连接未完成，请按 Collector 向导重试。", "error");
      connectButton.disabled = false;
      return;
    }
    input.value = "";
    renderStatus("已连接。请返回 Field Collector 完成页面确认。", "success");
  } catch {
    renderStatus("连接未完成，请确认 Collector 正在等待扩展。", "error");
    connectButton.disabled = false;
  }
});

async function refreshStatus() {
  try {
    const response = await chrome.runtime.sendMessage({kind: "get_status"});
    if (!response || typeof response.phase !== "string") {
      return;
    }
    if (response.phase === "paired" || response.phase === "collecting") {
      renderStatus("已连接。请返回 Field Collector 继续。", "success");
      connectButton.disabled = true;
    } else if (response.phase === "connecting") {
      renderStatus("正在核对当前 WhatsApp 页面并建立只读连接……");
      connectButton.disabled = true;
    } else if (response.phase === "failed") {
      renderStatus(response.message || "连接已停止，请按 Collector 向导重试。", "error");
      connectButton.disabled = false;
    } else if (response.phase === "completed") {
      renderStatus(response.message || "本次只读连接已结束。", "success");
      connectButton.disabled = false;
    } else {
      renderStatus("等待输入 Collector 显示的一次性配对码");
      connectButton.disabled = false;
    }
  } catch {
    // Popup status is advisory; the service worker and Collector fail closed.
  }
}

void refreshStatus();
const statusTimer = setInterval(() => void refreshStatus(), 500);
window.addEventListener("unload", () => clearInterval(statusTimer), {once: true});
input.focus();
