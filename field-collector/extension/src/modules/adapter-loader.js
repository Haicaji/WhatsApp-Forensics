"use strict";

// Adapter integrity and version gate. Frequently changing WhatsApp readers stay
// in adapter/collector.iife.js; the extension shell only verifies and injects it.
async function loadAdapter() {
  const manifestResponse = await fetch(chrome.runtime.getURL("adapter/adapter-manifest.json"));
  const adapterResponse = await fetch(chrome.runtime.getURL("adapter/collector.iife.js"));
  if (!manifestResponse.ok || !adapterResponse.ok) {
    throw new Error("adapter_unavailable");
  }
  const [adapterManifest, adapterText] = await Promise.all([
    manifestResponse.json(),
    adapterResponse.text(),
  ]);
  if (!exactKeys(adapterManifest, ["schemaVersion", "adapterId", "version", "bridgeProtocol", "sha256"])) {
    throw new Error("adapter_manifest_invalid");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(adapterText));
  const sha256 = `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (adapterManifest.schemaVersion !== "wafc-adapter-manifest/1"
      || adapterManifest.adapterId !== "wa-private-collections-v2"
      || adapterManifest.version !== "2.5.3"
      || adapterManifest.bridgeProtocol !== CONTROLLER_PROTOCOL
      || adapterManifest.sha256 !== sha256) {
    throw new Error("adapter_hash_mismatch");
  }
  return Object.freeze({
    text: adapterText,
    id: adapterManifest.adapterId,
    version: adapterManifest.version,
    sha256,
  });
}
