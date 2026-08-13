"use strict";

// Fail-closed CDP command policy. The relay worker cannot execute an arbitrary
// method, expression or function supplied over the local channel.
function validateEvaluate(params, adapterText) {
  if (!exactKeys(params, ["expression", "awaitPromise", "returnByValue", "userGesture"])) {
    return false;
  }
  if (params.userGesture !== false || params.awaitPromise !== false) {
    return false;
  }
  if (params.expression === adapterText) {
    return params.returnByValue === false;
  }
  return params.expression === "window.location.origin" && params.returnByValue === true;
}

const MEDIA_TOTAL_KEYS = Object.freeze([
  "requested", "available", "missing", "expired", "decryptError",
  "downloadTimeout", "noProgressTimeout", "tooLarge", "diskSpaceInsufficient",
  "hashMismatch", "transportInterrupted", "canceled", "unavailable", "notAttempted"
]);

function validateResume(value) {
  if (!exactKeys(value, [
    "challengeHex", "existing", "mediaPlanSha256", "mediaStartIndex", "mediaTotals"
  ]) || typeof value.existing !== "boolean"
      || typeof value.challengeHex !== "string" || !/^[0-9a-f]{64}$/.test(value.challengeHex)
      || !Number.isSafeInteger(value.mediaStartIndex) || value.mediaStartIndex < 0
      || !exactKeys(value.mediaTotals, MEDIA_TOTAL_KEYS)
      || !MEDIA_TOTAL_KEYS.every((key) => Number.isSafeInteger(value.mediaTotals[key])
        && value.mediaTotals[key] >= 0)) {
    return false;
  }
  const terminal = MEDIA_TOTAL_KEYS
    .filter((key) => key !== "requested")
    .reduce((sum, key) => sum + value.mediaTotals[key], 0);
  return value.existing
    ? typeof value.mediaPlanSha256 === "string" && /^[0-9a-f]{64}$/.test(value.mediaPlanSha256)
      && terminal === value.mediaStartIndex && value.mediaTotals.requested >= value.mediaStartIndex
    : value.mediaPlanSha256 === null && value.mediaStartIndex === 0
      && MEDIA_TOTAL_KEYS.every((key) => value.mediaTotals[key] === 0);
}

function validateCallFunction(params) {
  if (!exactKeys(params, [
    "functionDeclaration", "arguments", "awaitPromise", "returnByValue", "userGesture", "objectId",
  ])) {
    return false;
  }
  const callShapeValid = ALLOWED_FUNCTIONS.has(params.functionDeclaration)
    && typeof params.objectId === "string"
    && params.objectId.length > 0
    && params.objectId.length <= 512
    && Array.isArray(params.arguments)
    && params.arguments.length <= 1
    && JSON.stringify(params.arguments).length <= 1024
    && params.awaitPromise === true
    && params.returnByValue === true
    && params.userGesture === false;
  if (!callShapeValid) return false;

  if (params.functionDeclaration === DISPATCH_FUNCTION) {
    if (params.arguments.length !== 1 || !exactKeys(params.arguments[0], ["value"])) return false;
    const request = params.arguments[0].value;
    if (!request || typeof request !== "object" || Array.isArray(request)) return false;
    if (request.protocol !== CONTROLLER_PROTOCOL
        || request.controllerVersion !== CONTROLLER_VERSION) return false;
    if (request.command === "probe"
        && exactKeys(request, ["command", "controllerVersion", "protocol"])) return true;
    if (request.command === "start_t0"
        && exactKeys(request, ["command", "controllerVersion", "protocol", "resume"])
        && validateResume(request.resume)) return true;
    if (request.command !== "start_comprehensive"
        || !exactKeys(request, ["command", "controllerVersion", "mediaPolicy", "protocol", "resume"])
        || !validateResume(request.resume)) return false;
    const policy = request.mediaPolicy;
    return exactKeys(policy, [
      "mode", "maxAssetBytes", "maxTotalBytes", "cacheLookupTimeoutSeconds",
      "noProgressTimeoutSeconds", "attemptTimeoutSeconds", "maxAssetDurationSeconds",
      "maxAttempts", "continueOnFailure"
    ]) && ["cached_only", "network_best_effort", "metadata_only"].includes(policy.mode)
      && [
        policy.maxAssetBytes, policy.maxTotalBytes, policy.cacheLookupTimeoutSeconds,
        policy.noProgressTimeoutSeconds, policy.attemptTimeoutSeconds,
        policy.maxAssetDurationSeconds, policy.maxAttempts
      ].every((value) => Number.isSafeInteger(value) && value > 0)
      && policy.maxAssetBytes <= 34359738368
      && policy.maxTotalBytes >= policy.maxAssetBytes
      && policy.maxTotalBytes <= 35184372088832
      && policy.cacheLookupTimeoutSeconds <= 300
      && policy.noProgressTimeoutSeconds >= 5 && policy.noProgressTimeoutSeconds <= 3600
      && policy.attemptTimeoutSeconds >= 5 && policy.attemptTimeoutSeconds <= 7200
      && policy.maxAssetDurationSeconds >= policy.attemptTimeoutSeconds
      && policy.maxAssetDurationSeconds <= 86400
      && policy.maxAttempts <= 5
      && typeof policy.continueOnFailure === "boolean";
  }
  if (params.functionDeclaration === ACK_FUNCTION) {
    return params.arguments.length === 1
      && exactKeys(params.arguments[0], ["value"])
      && typeof params.arguments[0].value === "string"
      && REQUEST_ID_PATTERN.test(params.arguments[0].value);
  }
  if (params.functionDeclaration === MEDIA_CONTROL_FUNCTION) {
    if (params.arguments.length !== 1 || !exactKeys(params.arguments[0], ["value"])) return false;
    const command = params.arguments[0].value;
    if (!command || typeof command !== "object" || Array.isArray(command)) return false;
    if (["begin_download", "retry_current"].includes(command.action)) {
      return exactKeys(command, ["action"]);
    }
    if (command.action === "terminate_current") {
      return exactKeys(command, ["action", "reason"]) && [
        "media_download_timeout", "media_no_progress_timeout", "media_too_large",
        "media_disk_space_insufficient", "media_hash_mismatch",
        "media_transport_interrupted", "media_canceled", "media_not_attempted",
        "media_total_limit_reached", "media_cache_miss_network_disallowed",
        "media_policy_stop_after_failure"
      ].includes(command.reason);
    }
    return command.action === "stop_media_queue"
      && exactKeys(command, ["action", "reason"])
      && [
        "media_total_limit_reached", "media_disk_space_insufficient", "media_canceled",
        "media_policy_stop_after_failure"
      ].includes(command.reason);
  }
  return (params.functionDeclaration === NEXT_FUNCTION
      || params.functionDeclaration === BINDING_FUNCTION)
    && params.arguments.length === 0;
}

function validateRelease(params) {
  return exactKeys(params, ["objectId"])
    && typeof params.objectId === "string"
    && params.objectId.length > 0
    && params.objectId.length <= 512;
}

function validateCommand(method, params, adapterText) {
  if (SIMPLE_COMMANDS.has(method)) return exactKeys(params, []);
  if (method === "Runtime.evaluate") return validateEvaluate(params, adapterText);
  if (method === "Runtime.callFunctionOn") return validateCallFunction(params);
  if (method === "Runtime.releaseObject") return validateRelease(params);
  return false;
}
