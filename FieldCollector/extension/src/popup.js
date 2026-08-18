"use strict";

const input = document.getElementById("pairing-code");
const button = document.getElementById("connect");
const statusNode = document.getElementById("status");

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
  input.value = input.value.toUpperCase().replace(/[^2-9A-HJ-NP-Z]/g, "");
});

void refresh();

