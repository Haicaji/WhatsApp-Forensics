"use strict";

// Stable extension/Collector protocol surface. The extension build concatenates
// this module ahead of the relay worker so the shipped MV3 package still has a
// single service-worker entry point.
const PROTOCOL = "wafc-extension-relay/1";
const SUBPROTOCOL = "wafc-extension-v1";
const COLLECTOR_URL = "ws://127.0.0.1:17653/wafc-extension";
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const CONTROLLER_PROTOCOL = "wafc-bridge/2";
const CONTROLLER_VERSION = "0.2.5";
const MAX_MESSAGE_BYTES = 1024 * 1024;
const PAIRING_PATTERN = /^[2-9A-HJ-NP-Z]{10}$/;
const REQUEST_ID_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const SESSION_ID_PATTERN = /^wafc-session-[0-9a-f]{32}$/;
const ALLOWED_EVENTS = new Set([
  "Page.navigatedWithinDocument",
  "Page.frameNavigated",
  "Runtime.executionContextCreated",
  "Runtime.executionContextsCleared",
  "Inspector.detached",
  "Target.targetDestroyed",
  "Target.detachedFromTarget",
  "Target.targetInfoChanged",
]);
const SIMPLE_COMMANDS = new Set([
  "Runtime.enable",
  "Page.enable",
  "Page.getFrameTree",
]);
const DISPATCH_FUNCTION = "function(request){ return this.dispatch(request); }";
const NEXT_FUNCTION = "function(){ return this.next(); }";
const ACK_FUNCTION = "function(sequence){ return this.ack(sequence); }";
const BINDING_FUNCTION = "function(){ return this.checkAccountBinding(); }";
const MEDIA_CONTROL_FUNCTION = "function(command){ return this.controlMedia(command); }";
const ALLOWED_FUNCTIONS = new Set([
  DISPATCH_FUNCTION,
  NEXT_FUNCTION,
  ACK_FUNCTION,
  BINDING_FUNCTION,
  MEDIA_CONTROL_FUNCTION,
]);

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactWhatsAppUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname === "web.whatsapp.com"
      && parsed.port === ""
      && parsed.username === ""
      && parsed.password === "";
  } catch {
    return false;
  }
}

function browserIdentity() {
  const agent = navigator.userAgent;
  const edge = /Edg\/([0-9.]+)/.exec(agent);
  if (edge) {
    return {browser_family: "edge", browser_version: `Edge/${edge[1]}`};
  }
  const chrome = /Chrome\/([0-9.]+)/.exec(agent);
  if (chrome) {
    return {browser_family: "chrome", browser_version: `Chrome/${chrome[1]}`};
  }
  throw new Error("unsupported_browser");
}
