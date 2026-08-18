FC.mimeExtensions = Object.freeze({
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "video/webm": ".webm", "audio/ogg": ".ogg", "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a", "application/pdf": ".pdf", "text/vcard": ".vcf", "text/x-vcard": ".vcf"
});

FC.base64ToBytes = function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

FC.bytesToBase64 = function bytesToBase64(bytes) {
  let output = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    output += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunk)));
  }
  return btoa(output);
};

FC.mediaSourceFrom = function mediaSourceFrom(value, source = "unknown") {
  if (!value) return null;
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return {
      stream: value.stream(),
      byteLength: value.size,
      transferMode: "blob_stream",
      source,
      mimeType: value.type || null
    };
  }
  if (value instanceof ArrayBuffer) {
    return {
      bytes: new Uint8Array(value),
      byteLength: value.byteLength,
      transferMode: "buffered_bytes",
      source
    };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      bytes: new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      byteLength: value.byteLength,
      transferMode: "buffered_bytes",
      source
    };
  }
  if (typeof value.getReader === "function") {
    return {stream: value, byteLength: null, transferMode: "readable_stream", source};
  }
  if (value.body && typeof value.body.getReader === "function") {
    const contentLengthHeader = value.headers?.get?.("content-length");
    const contentLength = Number(contentLengthHeader);
    return {
      stream: value.body,
      byteLength: contentLengthHeader !== null && contentLengthHeader !== undefined &&
        Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null,
      transferMode: "response_stream",
      source
    };
  }
  return null;
};

FC.mediaErrorText = function mediaErrorText(error) {
  return String(error?.message || error || "unknown_media_error").replace(/\s+/g, " ").slice(0, 500);
};

FC.mediaUrlExpiry = function mediaUrlExpiry(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const encoded = new URL(value).searchParams.get("oe");
    if (!encoded || !/^[0-9a-f]+$/i.test(encoded)) return null;
    const seconds = Number.parseInt(encoded, 16);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
};

FC.mediaUrlIsExpired = function mediaUrlIsExpired(value, now = Date.now()) {
  const expiry = FC.mediaUrlExpiry(value);
  return expiry !== null && expiry <= now;
};

FC.mediaNeedsChatRefresh = function mediaNeedsChatRefresh(message, env, now = Date.now()) {
  const url = FC.mediaHelperValue(
    env,
    "getDeprecatedMms3Url",
    message,
    ["deprecatedMms3Url", "clientUrl", "url"]
  );
  return typeof url === "string" && FC.mediaUrlIsExpired(url, now);
};

FC.detectMediaMime = function detectMediaMime(bytes, fallback = null) {
  if (!(bytes instanceof Uint8Array)) return fallback;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  return fallback;
};

FC.mediaAwait = function mediaAwait(promise, timeoutMs, reason, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout?.(reason); } catch {}
      reject(new Error(reason));
    }, timeoutMs);
    Promise.resolve(promise).then(value => {
      clearTimeout(timer);
      resolve(value);
    }, error => {
      clearTimeout(timer);
      reject(error);
    });
  });
};

FC.streamMediaSource = async function streamMediaSource(source, onChunk, isCancelled, options = {}) {
  const chunkBytes = Number(options.chunkBytes) > 0 ? Number(options.chunkBytes) : 128 * 1024;
  const idleTimeoutMs = Number(options.idleTimeoutMs) > 0 ? Number(options.idleTimeoutMs) : 0;
  const deadlineAt = Number(options.deadlineAt) > 0 ? Number(options.deadlineAt) : 0;
  const abortController = options.abortController || null;
  let byteLength = 0;
  let complete = true;
  const remainingTotalMs = () => deadlineAt > 0 ? deadlineAt - Date.now() : Infinity;
  const ensureWithinDeadline = () => {
    if (remainingTotalMs() <= 0) {
      try { abortController?.abort("media_total_timeout"); } catch {}
      throw new Error("media_total_timeout");
    }
  };
  const forward = async value => {
    let bytes;
    if (value instanceof Uint8Array) bytes = value;
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else throw new Error("media_stream_returned_non_binary_chunk");
    for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      ensureWithinDeadline();
      if (isCancelled()) {
        complete = false;
        return;
      }
      const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes));
      await onChunk(chunk);
      byteLength += chunk.byteLength;
    }
  };

  if (source.bytes) {
    await forward(source.bytes);
    return {complete, byteLength};
  }
  if (!source.stream || typeof source.stream.getReader !== "function") {
    throw new Error("media_source_is_not_streamable");
  }
  const reader = source.stream.getReader();
  try {
    while (true) {
      ensureWithinDeadline();
      if (isCancelled()) {
        complete = false;
        await reader.cancel("field_collector_cancelled");
        break;
      }
      const totalRemaining = remainingTotalMs();
      const readTimeout = Math.min(idleTimeoutMs || Infinity, totalRemaining);
      const timeoutReason = idleTimeoutMs <= 0 || totalRemaining <= idleTimeoutMs
        ? "media_total_timeout"
        : "media_idle_timeout";
      const item = await FC.mediaAwait(reader.read(), readTimeout, timeoutReason, reason => {
        try { abortController?.abort(reason); } catch {}
        try { void reader.cancel(reason); } catch {}
      });
      if (item.done) break;
      await forward(item.value);
      if (!complete) {
        await reader.cancel("field_collector_cancelled");
        break;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  return {complete, byteLength};
};

FC.blobFromMessage = function blobFromMessage(message) {
  const containers = [
    message,
    FC.first(message, ["mediaData", "mediaInfo"]),
    FC.read(message, "mediaObject")
  ];
  for (const container of containers) {
    for (const key of ["mediaBlob", "blob", "_blob"]) {
      const value = FC.read(container, key);
      if (typeof Blob !== "undefined" && value instanceof Blob && value.size > 0) return value;
      if (typeof value?.forceToBlob === "function") {
        try {
          const forced = value.forceToBlob();
          if (forced instanceof Blob && forced.size > 0) return forced;
        } catch {}
      }
    }
  }
  return null;
};

FC.cachedMediaBlob = function cachedMediaBlob(message, env) {
  const cache = env?.mediaBlobCache;
  if (!cache || typeof cache.get !== "function") return null;
  const mediaObject = FC.read(message, "mediaObject");
  const filehash = FC.first(mediaObject, ["filehash", "fileHash"]) || FC.first(message, ["filehash", "fileHash"]);
  if (!filehash) return null;
  try {
    const cached = cache.get(filehash);
    if (cached instanceof Blob && cached.size > 0) return cached;
    if (typeof cached?.forceToBlob === "function") {
      const forced = cached.forceToBlob();
      if (forced instanceof Blob && forced.size > 0) return forced;
    }
  } catch {}
  return null;
};

FC.mediaHelperValue = function mediaHelperValue(env, method, message, fallbacks) {
  try {
    if (env.msgGetters && typeof env.msgGetters[method] === "function") return env.msgGetters[method](message);
  } catch {}
  return FC.first(message, fallbacks);
};

FC.mediaMeta = function mediaMeta(message, env, chatId, role = "original") {
  const messageId = FC.messageId(message);
  const type = String(FC.mediaHelperValue(env, "getType", message, ["type", "kind"]) || "file");
  const vcard = type === "vcard" || type === "multi_vcard";
  const fallbackMime = vcard ? "text/vcard" : "application/octet-stream";
  const mimeType = String(FC.mediaHelperValue(env, "getMimetype", message, ["mimetype", "mimeType"]) || fallbackMime);
  let originalFileName = FC.first(message, ["filename", "fileName"]);
  if (!originalFileName) {
    const mimeBase = mimeType.split(";", 1)[0].trim();
    originalFileName = vcard
      ? `contact_${messageId || "unknown"}.vcf`
      : `${type}_${messageId}${FC.mimeExtensions[mimeType] || FC.mimeExtensions[mimeBase] || ".bin"}`;
  }
  return {
    scope: "chat",
    chatId,
    messageId,
    type,
    role,
    isOriginal: role === "original",
    mimeType,
    originalFileName: String(originalFileName)
  };
};

FC.tryDownloadMedia = async function tryDownloadMedia(message, env, options = {}) {
  const mediaData = FC.first(message, ["mediaData", "mediaObject", "mediaInfo"]);
  const candidates = [...new Set([mediaData, message].filter(Boolean))];
  const waitMs = Number(options.waitMs) > 0 ? Number(options.waitMs) : 5_000;
  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 200;
  const requestTimeoutMs = Number(options.requestTimeoutMs) > 0 ? Number(options.requestTimeoutMs) : 15_000;
  const initialUrl = FC.mediaHelperValue(env, "getDeprecatedMms3Url", message, ["deprecatedMms3Url", "clientUrl", "url"]);
  const deadlineAt = Date.now() + waitMs;
  const failures = [];
  let attempted = false;
  for (const candidate of candidates) {
    if (typeof candidate?.downloadMedia !== "function") continue;
    attempted = true;
    try {
      const result = await FC.mediaAwait(
        candidate.downloadMedia({
          downloadEvenIfExpensive: true,
          rmrReason: 1,
          isUserInitiated: true
        }),
        requestTimeoutMs,
        "download_media_timeout"
      );
      const direct = FC.mediaSourceFrom(result, "downloadMedia_return");
      if (direct) return direct;
      const resultBlob = FC.first(result, ["mediaBlob", "blob", "_blob"]);
      const nested = FC.mediaSourceFrom(resultBlob, "downloadMedia_return_blob");
      if (nested) return nested;
      while (Date.now() < deadlineAt) {
        const populatedBlob = FC.blobFromMessage(message) || FC.cachedMediaBlob(message, env);
        const populated = FC.mediaSourceFrom(populatedBlob, "downloadMedia_populated_blob");
        if (populated) return populated;
        const mediaStage = String(FC.read(FC.read(message, "mediaData"), "mediaStage") || "");
        if (mediaStage.includes("ERROR")) throw new Error(`download_media_stage_${mediaStage}`);
        const currentUrl = FC.mediaHelperValue(env, "getDeprecatedMms3Url", message, ["deprecatedMms3Url", "clientUrl", "url"]);
        if (currentUrl && currentUrl !== initialUrl && !FC.mediaUrlIsExpired(String(currentUrl))) return null;
        await FC.sleep(Math.min(pollMs, Math.max(1, deadlineAt - Date.now())));
      }
    } catch (error) {
      failures.push(FC.mediaErrorText(error));
    }
  }
  if (failures.length > 0) throw new Error(`download_media_failed: ${failures.join(" | ")}`);
  if (attempted) throw new Error("download_media_completed_without_blob_or_fresh_url");
  return null;
};

FC.legacyDecryptMedia = async function legacyDecryptMedia(message, env) {
  const helper = env.msgGetters;
  const hkdf = env.cryptoHkdf;
  if (!helper) throw new Error("media_getters_unavailable");
  if (!hkdf?.extractAndExpand) throw new Error("media_hkdf_unavailable");
  let url;
  let mediaKey;
  let mediaType;
  try {
    url = helper.getDeprecatedMms3Url?.(message);
    mediaKey = helper.getMediaKey?.(message);
    mediaType = helper.getType?.(message);
  } catch (error) {
    throw new Error(`media_metadata_failed: ${FC.mediaErrorText(error)}`);
  }
  if (!url) throw new Error("media_url_unavailable");
  if (!mediaKey) throw new Error("media_key_unavailable");
  const expiry = FC.mediaUrlExpiry(String(url));
  if (expiry !== null && expiry <= Date.now()) {
    throw new Error(`media_url_expired_at_${new Date(expiry).toISOString()}`);
  }
  const labels = {
    image: "WhatsApp Image Keys", sticker: "WhatsApp Image Keys", video: "WhatsApp Video Keys",
    audio: "WhatsApp Audio Keys", ptt: "WhatsApp Audio Keys", document: "WhatsApp Document Keys"
  };
  const label = labels[mediaType];
  if (!label) throw new Error(`media_type_unsupported_${String(mediaType || "unknown")}`);
  const abortController = new AbortController();
  const response = await FC.mediaAwait(
    fetch(url, {signal: abortController.signal}),
    20_000,
    "media_request_timeout",
    reason => abortController.abort(reason)
  );
  if (!response.ok) throw new Error(`media_http_${response.status}`);
  const encryptedWithMac = new Uint8Array(await FC.mediaAwait(
    response.arrayBuffer(),
    30_000,
    "media_response_timeout",
    reason => abortController.abort(reason)
  ));
  if (encryptedWithMac.length <= 10) throw new Error("media_encrypted_payload_too_short");
  const encrypted = encryptedWithMac.slice(0, -10);
  const keyBytes = typeof mediaKey === "string" ? FC.base64ToBytes(mediaKey) : new Uint8Array(mediaKey);
  const expanded = new Uint8Array(await hkdf.extractAndExpand(keyBytes.buffer, label, 112));
  const key = await crypto.subtle.importKey("raw", expanded.slice(16, 48), {name: "AES-CBC"}, false, ["decrypt"]);
  const clear = await crypto.subtle.decrypt({name: "AES-CBC", iv: expanded.slice(0, 16)}, key, encrypted);
  return new Blob([clear]);
};

FC.originalMedia = async function originalMedia(message, env) {
  const type = String(FC.mediaHelperValue(env, "getType", message, ["type", "kind"]) || "").toLowerCase();
  if (type === "vcard" || type === "multi_vcard") {
    const body = FC.mediaHelperValue(env, "getBody", message, ["body", "text"]);
    if (typeof body === "string" && body.length > 0) {
      return FC.mediaSourceFrom(new TextEncoder().encode(body), "vcard_body");
    }
  }
  let blob = FC.blobFromMessage(message);
  if (blob) return FC.mediaSourceFrom(blob, "observable_blob");
  const failures = [];
  try {
    const downloaded = await FC.tryDownloadMedia(message, env);
    if (downloaded) return downloaded;
  } catch (error) {
    failures.push(FC.mediaErrorText(error));
  }
  blob = FC.blobFromMessage(message);
  if (blob) return FC.mediaSourceFrom(blob, "downloadMedia_populated_blob");
  try {
    blob = await FC.legacyDecryptMedia(message, env);
  } catch (error) {
    failures.push(FC.mediaErrorText(error));
  }
  if (!blob || blob.size <= 0) {
    throw new Error(failures.length > 0 ? failures.join("; ") : "media_source_unavailable");
  }
  const source = FC.mediaSourceFrom(blob, "legacy_aes_cbc_buffered");
  if (source) source.legacyBuffered = true;
  return source;
};

FC.previewMedia = async function previewMedia(message) {
  const mediaData = FC.first(message, ["mediaData", "mediaObject", "mediaInfo"]);
  const type = String(FC.first(message, ["type", "kind"]) || "").toLowerCase();
  for (const container of [mediaData, message]) {
    const keys = ["fullPreviewData", "previewData", "jpegThumbnail", "thumbnail", "previewBlob"];
    if (container === message && ["image", "video", "sticker"].includes(type)) keys.push("body");
    for (const key of keys) {
      const value = FC.read(container, key);
      const blob = value instanceof Blob ? value : FC.first(value, ["_blob", "blob"]);
      if (blob instanceof Blob && blob.size > 0) return FC.mediaSourceFrom(blob, "preview_blob");
      if (typeof value === "string" && /^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 64) {
        try {
          const bytes = FC.base64ToBytes(value.replace(/\s/g, ""));
          const source = FC.mediaSourceFrom(bytes, key === "body" ? "message_body_preview_base64" : "preview_base64");
          if (source) source.mimeType = FC.detectMediaMime(bytes, "application/octet-stream");
          return source;
        } catch {}
      }
    }
  }
  return null;
};

FC.isMediaMessage = function isMediaMessage(message, env) {
  const type = String(FC.mediaHelperValue(env, "getType", message, ["type", "kind"]) || "").toLowerCase();
  return ["image", "video", "ptt", "audio", "document", "sticker", "vcard", "multi_vcard"].includes(type) || Boolean(FC.first(message, ["mediaData", "mediaObject"]));
};

FC.avatarTasks = function avatarTasks(env, relevantIds) {
  const pictures = FC.collectionValues(env.profilePictures);
  const seen = new Set();
  return pictures.map(picture => {
    const contactId = FC.idString(FC.first(picture, ["id", "wid"]));
    if (!contactId || !relevantIds.has(contactId) || seen.has(contactId)) return null;
    const url = FC.first(picture, ["imgFull", "__x_imgFull", "img", "eurl"]);
    if (!url) return null;
    seen.add(contactId);
    return {contactId, url: String(url)};
  }).filter(Boolean);
};
