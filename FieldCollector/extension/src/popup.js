"use strict";

const input = document.getElementById("pairing-code");
const button = document.getElementById("connect");
const pasteButton = document.getElementById("paste");
const statusNode = document.getElementById("status");

function normalizePairingCode(value) {
  return String(value || "").toUpperCase().replace(/[^2-9A-HJ-NP-Z]/g, "").slice(0, 10);
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({kind: "get_status"});
  statusNode.textContent = status?.message || "等待连接";
  button.disabled = status?.phase === "connecting" || status?.phase === "paired";
}

button.addEventListener("click", async () => {
  button.disabled = true;
  const pairingCode = input.value.trim().toUpperCase();
  const response = await chrome.runtime.sendMessage({kind: "begin_pairing", pairingCode});
  statusNode.textContent = response?.message || "连接失败";
  button.disabled = response?.ok === true;
});

input.addEventListener("input", () => {
  input.value = normalizePairingCode(input.value);
});

pasteButton.addEventListener("click", async () => {
  try {
    input.value = normalizePairingCode(await navigator.clipboard.readText());
    input.focus();
    statusNode.textContent = input.value.length === 10
      ? "连接码已粘贴"
      : "剪贴板中没有有效的 10 位连接码";
  } catch (error) {
    statusNode.textContent = `无法读取剪贴板：${String(error?.message || error)}`;
  }
});

void refresh();
