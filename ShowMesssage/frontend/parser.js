(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ShowMessageParser = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MEDIA_TYPES = new Set([
    "image",
    "video",
    "ptt",
    "audio",
    "document",
    "sticker",
    "vcard",
  ]);

  const CALL_TYPES = new Set(["call_log", "call", "missed_call", "group_call"]);
  const SYSTEM_TYPES = new Set([
    "ciphertext",
    "e2e_notification",
    "gp2",
    "notification",
    "protocol",
    "system",
  ]);
  const MAX_TIMESTAMP_SECONDS = 253402300799;
  const MAX_INLINE_PREVIEW_BASE64_LENGTH = 2 * 1024 * 1024;

  const MIME_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/ogg; codecs=opus": ".opus",
    "audio/opus": ".opus",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "application/pdf": ".pdf",
    "text/markdown": ".md",
    "text/plain": ".txt",
    "text/x-vcard": ".vcf",
    "application/zip": ".zip",
    "application/json": ".json",
  };

  const EXTENSION_MIMES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".opus": "audio/ogg; codecs=opus",
    ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".pdf": "application/pdf",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".vcf": "text/x-vcard",
    ".zip": "application/zip",
    ".json": "application/json",
  };

  class ArchiveError extends Error {
    constructor(code, message, cause) {
      super(message);
      this.name = "ArchiveError";
      this.code = code;
      if (cause) this.cause = cause;
    }
  }

  function toRecordArray(value) {
    if (value == null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value !== "object") return [value];
    if (
      Object.prototype.hasOwnProperty.call(value, "id") ||
      Object.prototype.hasOwnProperty.call(value, "type") ||
      Object.prototype.hasOwnProperty.call(value, "formattedTitle")
    ) {
      return [value];
    }
    return Object.values(value);
  }

  function basename(name) {
    return String(name || "").replace(/\\/g, "/").split("/").pop();
  }

  function normalizeId(value) {
    if (value == null) return "";
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
    return String(
      value._serialized || value.$1 || value.id || value.user || "",
    );
  }

  function normalizeBoolean(value) {
    if (typeof value === "string") return value.toLowerCase() === "true";
    return Boolean(value);
  }

  function normalizeTimestamp(value) {
    const parsed = Number(value == null || value === "" ? 0 : value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    let seconds = parsed;
    let divisions = 0;
    // Exported WhatsApp values have appeared as seconds, milliseconds,
    // microseconds and nanoseconds. Repeated scaling avoids relying on a
    // brittle digit-count threshold while still rejecting values beyond ns.
    while (seconds > MAX_TIMESTAMP_SECONDS && divisions < 3) {
      seconds /= 1000;
      divisions += 1;
    }
    seconds = Math.floor(seconds);
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > MAX_TIMESTAMP_SECONDS) {
      return 0;
    }
    return seconds;
  }

  function safeFileName(value, fallback) {
    const leaf = basename(String(value || ""))
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim();
    return leaf || fallback;
  }

  function extensionOf(name) {
    const clean = basename(name).replace(/\.embedded(?=\.|$)/i, "");
    const match = clean.match(/(\.[a-z0-9]{1,10})$/i);
    return match ? match[1].toLowerCase() : "";
  }

  function inferMime(name, fallback) {
    return EXTENSION_MIMES[extensionOf(name)] || fallback || "application/octet-stream";
  }

  function serializedMessageId(value) {
    const serialized = normalizeId(value).trim();
    const match =
      serialized.match(/^(true|false)_(.+?@[^_]+)_(.+)$/i) ||
      serialized.match(/^(true|false)_(.+)_([^_]+)$/i);
    if (!match) return null;
    return {
      fromMe: match[1].toLowerCase() === "true",
      remote: match[2],
      localId: match[3],
      key: `${match[1].toLowerCase()}_${match[2]}_${match[3]}`,
    };
  }

  function stableTextHash(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function normalizeMessageIdentity(raw, chatId) {
    const source = raw && raw.id;
    const serialized = serializedMessageId(source);
    const objectId = source && typeof source === "object" ? source : {};
    const fromMe = serialized
      ? serialized.fromMe
      : normalizeBoolean(objectId.fromMe != null ? objectId.fromMe : raw && raw.fromMe);
    const remote = normalizeId(
      (serialized && serialized.remote) ||
        objectId.remote ||
        chatId ||
        (raw && (raw.chatId || raw.from || raw.to)) ||
        "",
    );
    const scalarId =
      source != null && (typeof source === "string" || typeof source === "number")
        ? String(source)
        : "";
    const localId = normalizeId(
      (serialized && serialized.localId) || objectId.id || scalarId || (raw && raw.rowId) || "",
    );
    if (serialized) return { ...serialized, explicit: true };
    if (localId) {
      return {
        fromMe,
        remote,
        localId,
        key: `${fromMe ? "true" : "false"}_${remote}_${localId}`,
        explicit: true,
      };
    }

    const fingerprint = stableTextHash(
      JSON.stringify([
        remote,
        fromMe,
        raw && (raw.t || raw.timestamp),
        raw && (raw.from || raw.author || raw.sender),
        raw && raw.to,
        raw && raw.type,
        raw && (raw.body || raw.content),
        raw && raw.caption,
        raw && raw.filename,
        raw && raw.size,
      ]),
    );
    const fallbackId = `missing-${fingerprint}`;
    return {
      fromMe,
      remote,
      localId: fallbackId,
      key: `${fromMe ? "true" : "false"}_${remote}_${fallbackId}`,
      explicit: false,
    };
  }

  function mediaLabel(type) {
    return {
      image: "图片",
      video: "视频",
      ptt: "语音",
      audio: "音频",
      document: "文件",
      sticker: "贴纸",
      vcard: "联系人",
    }[type] || "附件";
  }

  function timestampStamp(timestamp) {
    const date = timestamp ? new Date(timestamp * 1000) : new Date(0);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  function normalizeOptions(value) {
    const items = Array.isArray(value)
      ? value
      : value && typeof value === "object"
        ? Object.values(value)
        : [];
    return items
      .map((item) => {
        if (typeof item === "string") return { name: item, id: item };
        if (!item || typeof item !== "object") return null;
        const name = String(item.name || item.title || item.text || "").trim();
        if (!name) return null;
        return { name, id: String(item.localId || item.id || name) };
      })
      .filter(Boolean);
  }

  function normalizeWaveform(value) {
    if (!value) return [];
    const items = Array.isArray(value) ? value : Object.values(value);
    return items
      .map(Number)
      .filter(Number.isFinite)
      .slice(0, 96);
  }

  function decodeBase64Prefix(value, byteLimit) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const bytes = [];
    let buffer = 0;
    let bitCount = 0;
    for (const character of String(value || "")) {
      if (character === "=") break;
      const digit = alphabet.indexOf(character);
      if (digit < 0) return [];
      buffer = (buffer << 6) | digit;
      bitCount += 6;
      if (bitCount < 8) continue;
      bitCount -= 8;
      bytes.push((buffer >> bitCount) & 0xff);
      if (bytes.length >= byteLimit) break;
    }
    return bytes;
  }

  function rasterMimeFromBytes(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (
      bytes[0] === 0x89
      && bytes[1] === 0x50
      && bytes[2] === 0x4e
      && bytes[3] === 0x47
      && bytes[4] === 0x0d
      && bytes[5] === 0x0a
      && bytes[6] === 0x1a
      && bytes[7] === 0x0a
    ) return "image/png";
    if (
      bytes[0] === 0x52
      && bytes[1] === 0x49
      && bytes[2] === 0x46
      && bytes[3] === 0x46
      && bytes[8] === 0x57
      && bytes[9] === 0x45
      && bytes[10] === 0x42
      && bytes[11] === 0x50
    ) return "image/webp";
    return "";
  }

  function extractInlineRasterPreview(value) {
    const compact = String(value || "").replace(/\s+/g, "");
    if (!compact || compact.length > MAX_INLINE_PREVIEW_BASE64_LENGTH + 64) return null;
    const dataMatch = compact.match(/^data:([^;,]+);base64,(.*)$/i);
    const declaredMime = dataMatch ? String(dataMatch[1] || "").toLowerCase() : "";
    if (declaredMime && !["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(declaredMime)) {
      return null;
    }
    let base64 = dataMatch ? dataMatch[2] : compact;
    if (
      base64.length < 16
      || base64.length > MAX_INLINE_PREVIEW_BASE64_LENGTH
      || !/^[a-z0-9+/]+={0,2}$/i.test(base64)
      || base64.length % 4 === 1
    ) return null;
    base64 = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const mime = rasterMimeFromBytes(decodeBase64Prefix(base64, 12));
    if (!mime) return null;
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    const size = Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
    return {
      dataUrl: `data:${mime};base64,${base64}`,
      mime,
      size,
    };
  }

  function normalizeBody(raw, type) {
    const caption = String(raw.caption || "");
    if (caption) return caption;
    const body = String(raw.body || raw.content || "");
    if (!MEDIA_TYPES.has(type)) return body;
    if (extractInlineRasterPreview(body)) return "";

    // Some exports place a base64 JPEG thumbnail in `body` for image/video
    // messages. It is media data, not a user-visible caption.
    const compact = body.replace(/\s+/g, "");
    if (
      compact.length > 512 &&
      (/^data:[^,]+;base64,/i.test(compact) || /^[a-z0-9+/]+=*$/i.test(compact))
    ) {
      return "";
    }
    return body;
  }

  function contactName(contact) {
    if (!contact || typeof contact !== "object") return "";
    return String(
      contact.formattedName ||
        contact.name ||
        contact.pushname ||
        contact.shortName ||
        contact.verifiedName ||
        "",
    ).trim();
  }

  function contactSignature(contact) {
    if (!contact || typeof contact !== "object") return "";
    const normalize = (value) =>
      String(value || "")
        .trim()
        .replace(/\s+/g, " ")
        .toLocaleLowerCase("zh-CN");
    const name = normalize(contact.name || contact.formattedName);
    const shortName = normalize(contact.shortName);
    const pushName = normalize(contact.pushname || contact.verifiedName);
    if (!name || (!shortName && !pushName)) return "";
    return `${name}\u241f${shortName}\u241f${pushName}`;
  }

  function phoneMetadataFromSource(source) {
    if (!source || typeof source !== "object") {
      return { phoneId: "", phoneNumber: "", deviceId: "" };
    }
    const candidates = [
      source.phoneId,
      source.pn,
      source.phoneNumber,
      source.phone,
      source.devicePn,
      source.wid,
      source.jid,
      /@c\.us$/i.test(normalizeId(source.id)) ? source.id : "",
    ];
    let phoneId = "";
    let phoneNumber = "";
    let deviceId = "";
    for (const candidate of candidates) {
      const parsed = normalizePhoneIdentity(candidate);
      phoneId ||= parsed.phoneId;
      phoneNumber ||= parsed.phoneNumber;
      deviceId ||= parsed.deviceId;
    }
    return { phoneId, phoneNumber, deviceId };
  }

  function makeContactPhoneIndex(contacts) {
    const byLid = new Map();
    const signatureGroups = new Map();
    for (const contact of contacts.values()) {
      const id = normalizeId(contact.id || contact.wid || contact.jid);
      const phone = phoneMetadataFromSource(contact);
      const lidCandidates = [id, normalizeId(contact.lid), normalizeId(contact.accountLid)].filter(
        (value) => /@lid$/i.test(value),
      );
      if (phone.phoneNumber) {
        for (const lid of lidCandidates) byLid.set(lid, phone);
      }

      const signature = contactSignature(contact);
      if (!signature) continue;
      if (!signatureGroups.has(signature)) {
        signatureGroups.set(signature, { lids: new Set(), phones: new Map() });
      }
      const group = signatureGroups.get(signature);
      for (const lid of lidCandidates) group.lids.add(lid);
      if (phone.phoneNumber) group.phones.set(phone.phoneNumber, phone);
    }

    const bySignature = new Map();
    for (const [signature, group] of signatureGroups) {
      if (group.lids.size !== 1 || group.phones.size !== 1) continue;
      const phone = Array.from(group.phones.values())[0];
      bySignature.set(signature, phone);
      for (const lid of group.lids) {
        if (!byLid.has(lid)) byLid.set(lid, phone);
      }
    }
    return { byLid, bySignature };
  }

  function resolveChatPhone(raw, id, contactPhones) {
    const directSources = [(raw && raw.contact) || null, raw || null];
    for (const source of directSources) {
      const phone = phoneMetadataFromSource(source);
      if (phone.phoneNumber) return { ...phone, phoneSource: "chat" };
    }

    const contact = raw && raw.contact;
    const lidCandidates = [
      id,
      normalizeId(raw && raw.accountLid),
      normalizeId(contact && contact.id),
      normalizeId(contact && contact.lid),
    ];
    for (const lid of lidCandidates) {
      const phone = contactPhones.byLid.get(lid);
      if (phone) return { ...phone, phoneSource: "contacts" };
    }

    const signature = contactSignature(contact);
    const paired = signature && contactPhones.bySignature.get(signature);
    return paired
      ? { ...paired, phoneSource: "contacts" }
      : { phoneId: "", phoneNumber: "", deviceId: "", phoneSource: "" };
  }

  function makeEntryIndex(zip) {
    const entries = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => ({
        entry,
        name: entry.name,
        base: basename(entry.name),
        lower: basename(entry.name).toLowerCase(),
      }));
    const byBase = new Map();
    for (const item of entries) {
      if (!byBase.has(item.lower) || item.name === item.base) {
        byBase.set(item.lower, item);
      }
    }
    return { entries, byBase };
  }

  async function readJson(item, label, required) {
    if (!item) {
      if (required) {
        throw new ArchiveError("MISSING_JSON", `ZIP 中缺少 ${label}`);
      }
      return null;
    }
    let text;
    try {
      text = await item.entry.async("string");
      return JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch (error) {
      throw new ArchiveError("INVALID_JSON", `${label} 不是有效的 JSON`, error);
    }
  }

  function findAttachment(entryIndex, serializedKey) {
    const prefix = `attachment ${serializedKey}`.toLowerCase();
    const candidates = entryIndex.entries.filter((item) => {
      if (!item.lower.startsWith(prefix)) return false;
      const suffix = item.lower.slice(prefix.length);
      // ZAPiXWEB normally appends an extension. Older exports can literally
      // append "undefined" when the original document has no attachment suffix.
      return suffix === "" || suffix.startsWith(".") || suffix === "undefined";
    });
    if (!candidates.length) return { primary: null, preview: null };
    const preview = candidates.find((item) => /\.embedded(?:\.|$)/i.test(item.base)) || null;
    const primary = candidates.find((item) => !/\.embedded(?:\.|$)/i.test(item.base)) || null;
    return { primary, preview };
  }

  function entrySize(item) {
    const data = item && item.entry && item.entry._data;
    return Number((data && data.uncompressedSize) || 0);
  }

  function normalizeMedia(raw, type, identity, timestamp, entryIndex) {
    if (!MEDIA_TYPES.has(type)) return null;
    const key = identity.key;
    const matches = findAttachment(entryIndex, key);
    const original = matches.primary;
    const preview = matches.preview;
    const intendedMime = String(raw.mimetype || "");
    const inlinePreview = ["image", "video", "sticker"].includes(type)
      ? extractInlineRasterPreview(raw.body || raw.content)
      : null;
    const previewMime = preview ? inferMime(preview.base, "image/jpeg") : "";
    const originalMime = inferMime(original && original.base, intendedMime);
    const previewOnly = !original && Boolean(preview || inlinePreview);
    // Images and stickers can use their embedded bitmap as the displayed
    // media. A video's JPEG preview must never masquerade as its MP4 original.
    const displayEntry = original || (type !== "video" ? preview : null);
    const mime = displayEntry === preview ? previewMime : originalMime;
    const suppliedName = safeFileName(raw.filename, "");
    const extension = extensionOf(original && original.base) || MIME_EXTENSIONS[intendedMime || mime] || "";
    const fallback = `${mediaLabel(type)}_${timestampStamp(timestamp)}${extension || ".bin"}`;
    const downloadName = suppliedName || fallback;
    return {
      key,
      kind: type,
      entryName: displayEntry ? displayEntry.name : "",
      previewEntryName: preview ? preview.name : "",
      previewDataUrl: inlinePreview ? inlinePreview.dataUrl : "",
      missing: !original && !preview && !inlinePreview,
      originalMissing: !original,
      previewAvailable: Boolean(preview || inlinePreview),
      previewOnly,
      mime,
      originalMime,
      previewMime: previewMime || (inlinePreview && inlinePreview.mime) || "",
      downloadName,
      size: Math.max(Number(raw.size || 0), entrySize(original)),
      previewSize: entrySize(preview) || (inlinePreview && inlinePreview.size) || 0,
      width: Number(raw.width || 0),
      height: Number(raw.height || 0),
      duration: Number(raw.duration || 0),
      waveform: normalizeWaveform(raw.waveform),
    };
  }

  function normalizeMessage(raw, chatId, index, entryIndex, contacts) {
    const identity = normalizeMessageIdentity(raw, chatId);
    const fromMe = identity.fromMe;
    const timestamp = normalizeTimestamp(raw.t) || normalizeTimestamp(raw.timestamp);
    const type = String(raw.type || "unknown").toLowerCase();
    const remote = identity.remote || normalizeId(chatId || raw.chatId || "");
    const localId = identity.localId;
    const rawSender = raw.sender;
    const rawSenderId = normalizeId(
      rawSender && typeof rawSender === "object"
        ? rawSender.id || rawSender.wid || rawSender.jid
        : rawSender,
    );
    const from = normalizeId(raw.from || raw.author || rawSenderId || "");
    const contact = contacts.get(from);
    const senderFallback =
      contactName(rawSender) ||
      (typeof rawSender === "string" || typeof rawSender === "number" ? String(rawSender) : "");
    return {
      id: localId,
      key: identity.key,
      chatId: remote || chatId,
      fromMe,
      from,
      to: normalizeId(raw.to || ""),
      senderName: String(raw.notifyName || contactName(contact) || senderFallback || "").trim(),
      timestamp,
      rowId: Number.isFinite(Number(raw.rowId)) ? Number(raw.rowId) : index,
      type,
      body: normalizeBody(raw, type),
      caption: String(raw.caption || ""),
      ack: Number(raw.ack || 0),
      forwarded: Boolean(raw.isForwarded),
      starred: Boolean(raw.star),
      media: normalizeMedia(raw, type, identity, timestamp, entryIndex),
      poll:
        type === "poll_creation"
          ? {
              name: String(raw.pollName || raw.body || "投票"),
              options: normalizeOptions(raw.pollOptions),
              selectable: Number(raw.pollSelectableOptionsCount || 1),
            }
          : null,
      event:
        type === "event_creation"
          ? {
              name: String(raw.eventName || "活动"),
              description: String(raw.eventDescription || ""),
              startTime: normalizeTimestamp(raw.eventStartTime),
              canceled: Boolean(raw.isEventCanceled),
            }
          : null,
    };
  }

  function chatPreview(message) {
    if (!message) return "暂无消息";
    if (message.type === "chat") return message.body || "消息";
    if (message.type === "poll_creation") return `投票：${message.poll ? message.poll.name : ""}`;
    if (message.type === "event_creation") return `活动：${message.event ? message.event.name : ""}`;
    if (MEDIA_TYPES.has(message.type)) {
      return `[${mediaLabel(message.type)}]${message.body ? ` ${message.body}` : ""}`;
    }
    if (message.type === "revoked") return "此消息已被删除";
    if (CALL_TYPES.has(message.type) || /(^|_)call(?:_|$)/i.test(message.type)) {
      return message.body || "[通话记录]";
    }
    if (
      SYSTEM_TYPES.has(message.type) ||
      /(?:notification|protocol|system)/i.test(message.type)
    ) {
      return message.body || "[系统消息]";
    }
    return message.body || `[${message.type || "未知消息"}]`;
  }

  function normalizeContactMap(value) {
    const map = new Map();
    for (const contact of toRecordArray(value)) {
      if (!contact || typeof contact !== "object") continue;
      const id = normalizeId(contact.id || contact.wid || contact.jid);
      if (id) map.set(id, contact);
    }
    return map;
  }

  function avatarMap(entryIndex) {
    const map = new Map();
    for (const item of entryIndex.entries) {
      const match = item.base.match(/^Avatar (.+)\.(?:jpe?g|png|webp)$/i);
      if (match) map.set(match[1], item.name);
    }
    return map;
  }

  function normalizeChat(raw, id, messages, avatars, contactPhones) {
    const contact = raw && raw.contact;
    const group = raw && raw.groupMetadata;
    const phone = resolveChatPhone(raw || {}, id, contactPhones);
    const title = String(
      (raw && raw.formattedTitle) ||
        contactName(contact) ||
        (group && (group.subject || group.name)) ||
        id ||
        "未知会话",
    ).trim();
    const sortedMessages = messages.slice().sort((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
      return left.rowId - right.rowId;
    });
    const lastMessage = sortedMessages[sortedMessages.length - 1] || null;
    const contactId = normalizeId(contact && contact.id);
    return {
      id,
      title,
      contactId: contactId || id,
      contactName: contactName(contact) || title,
      contactStatus: String((contact && (contact.status || contact.about)) || "").trim(),
      contactType: String((contact && contact.type) || "").trim(),
      contactDeactivated: Boolean(contact && contact.isDeactivated),
      phoneId: phone.phoneId,
      phoneNumber: phone.phoneNumber,
      deviceId: phone.deviceId,
      phoneSource: phone.phoneSource,
      unreadCount: Math.max(0, Number((raw && raw.unreadCount) || 0)),
      archived: Boolean(raw && raw.archive),
      muted: Number((raw && raw.muteExpiration) || 0) > 0,
      isGroup: Boolean(group) || /@g\.us$/i.test(id),
      isFavorite: sortedMessages.some((message) => message.starred),
      // The chat model timestamp is often stale. The last parsed message is
      // what the viewer actually displays, so it is authoritative for order.
      timestamp:
        (lastMessage && lastMessage.timestamp) || normalizeTimestamp(raw && raw.t),
      preview: chatPreview(lastMessage),
      avatarEntryName: avatars.get(id) || avatars.get(contactId) || "",
      messages: sortedMessages,
    };
  }

  function normalizePhoneIdentity(value) {
    const serialized = normalizeId(value).trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, "");
    if (!serialized || /@lid$/i.test(serialized)) {
      return { phoneId: "", phoneNumber: "", deviceId: "" };
    }
    const whatsappId = serialized.match(/^(\+?\d{7,15})(?:(?::|_)(\d+))?@c\.us$/i);
    if (whatsappId) {
      return {
        phoneId: serialized,
        phoneNumber: whatsappId[1].replace(/^\+/, ""),
        deviceId: whatsappId[2] || "",
      };
    }
    const directNumber = serialized.match(/^\+?(\d{7,15})$/);
    return directNumber
      ? { phoneId: "", phoneNumber: directNumber[1], deviceId: "" }
      : { phoneId: "", phoneNumber: "", deviceId: "" };
  }

  function resolvePhoneMetadata(source, sourceName) {
    const candidates = [
      source.phoneId,
      source.devicePn,
      source.devicePhoneId,
      source.pn,
      source.phoneNumber,
      source.phone,
      /@c\.us$/i.test(normalizeId(source.id)) ? source.id : "",
    ];
    let phoneId = "";
    let phoneNumber = "";
    let deviceId = "";
    for (const candidate of candidates) {
      const parsed = normalizePhoneIdentity(candidate);
      phoneId ||= parsed.phoneId;
      phoneNumber ||= parsed.phoneNumber;
      deviceId ||= parsed.deviceId;
    }
    let phoneSource = phoneNumber ? "userAccount" : "";
    if (!phoneNumber) {
      const leaf = basename(sourceName);
      const timestampedMatch = leaf.match(
        /^ZAPiXWEB_(.+)_\d{8}_\d{6}_UTC[+-]\d{4}\.zip$/i,
      );
      const legacyMatch = leaf.match(/^ZAPiXWEB_(.+)\.zip$/i);
      const parsed = normalizePhoneIdentity(
        (timestampedMatch && timestampedMatch[1]) || (legacyMatch && legacyMatch[1]),
      );
      phoneId = parsed.phoneId;
      phoneNumber = parsed.phoneNumber;
      deviceId = parsed.deviceId;
      phoneSource = phoneNumber ? "sourceName" : "";
    }
    return { phoneId, phoneNumber, deviceId, phoneSource };
  }

  function normalizeCurrentUser(raw, contacts, avatars, sourceName) {
    if (!raw || typeof raw !== "object") return null;
    const source = raw;
    const id = normalizeId(source.id || source.wid || source.jid);
    const contact = contacts.get(id);
    const phone = resolvePhoneMetadata(source, sourceName);
    return {
      id,
      name: contactName(source) || contactName(contact) || "当前用户",
      type: String(source.type || (contact && contact.type) || "").trim(),
      status: String(source.status || source.about || (contact && (contact.status || contact.about)) || "").trim(),
      isDeactivated: Boolean(source.isDeactivated || (contact && contact.isDeactivated)),
      avatarEntryName: avatars.get(id) || avatars.get(phone.phoneId) || "",
      phoneId: phone.phoneId,
      phoneNumber: phone.phoneNumber,
      deviceId: phone.deviceId,
      phoneSource: phone.phoneSource,
    };
  }

  function normalizeOptionalCount(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
  }

  function normalizeOptionalBoolean(value) {
    if (value == null || value === "") return null;
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
      return null;
    }
    return typeof value === "boolean" ? value : null;
  }

  const HISTORY_DIAGNOSTIC_KEYS = [
    "historyAccessMethod",
    "historyLoaderFallback",
    "storeLoadRounds",
    "storeReturnedMessages",
    "storeAddedMessages",
    "storeEmptyRounds",
    "storeStalledRounds",
    "openDiagnostics",
  ];

  function hasOwn(source, key) {
    return Boolean(source && Object.prototype.hasOwnProperty.call(source, key));
  }

  function normalizeDiagnosticText(value, maxLength) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return "";
    }
    const limit = Number.isFinite(maxLength) ? Math.max(1, Math.floor(maxLength)) : 240;
    return String(value)
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, limit);
  }

  function normalizeHistoryLoaderFallback(value) {
    if (typeof value === "string") {
      const error = normalizeDiagnosticText(value, 320);
      return error ? { moduleName: "", round: null, timedOut: null, error } : null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const fallback = {
      moduleName: normalizeDiagnosticText(value.moduleName, 160),
      round: normalizeOptionalCount(value.round),
      timedOut: normalizeOptionalBoolean(value.timedOut),
      error: normalizeDiagnosticText(value.error, 320),
    };
    return fallback.moduleName || fallback.round != null || fallback.timedOut != null || fallback.error
      ? fallback
      : null;
  }

  function normalizeOpenActivation(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const activation = {
      activated: normalizeOptionalBoolean(value.activated),
      target: normalizeDiagnosticText(value.target, 96),
      reason: normalizeDiagnosticText(value.reason, 240),
      matches: normalizeOptionalCount(value.matches),
      available: normalizeOptionalBoolean(value.available),
      chatIdValid: normalizeOptionalBoolean(value.chatIdValid),
      titlePresent: normalizeOptionalBoolean(value.titlePresent),
    };
    return Object.values(activation).some((item) => item !== null && item !== "") ? activation : null;
  }

  function normalizeOpenDiagnostic(value, chatId, chatTitle) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const observedChatId = normalizeDiagnosticText(value.observedChatId, 320);
    const observedTitle = normalizeDiagnosticText(value.observedTitle, 320);
    const expectedTitle = String(chatTitle || "").trim();
    return {
      phase: normalizeDiagnosticText(value.phase, 120),
      surfaceMounted: normalizeOptionalBoolean(value.surfaceMounted),
      observedChatIdPresent: Boolean(observedChatId),
      observedChatIdMatches: observedChatId && chatId ? normalizeId(observedChatId) === chatId : null,
      observedTitlePresent: Boolean(observedTitle),
      observedTitleMatches: observedTitle && expectedTitle ? observedTitle === expectedTitle : null,
      activation: normalizeOpenActivation(value.activation),
    };
  }

  function normalizeHistoryDiagnostics(report, chatId, chatTitle) {
    const hasHistoryDiagnostics = HISTORY_DIAGNOSTIC_KEYS.some((key) => hasOwn(report, key));
    const openDiagnostics = Array.isArray(report.openDiagnostics)
      ? report.openDiagnostics
        .slice(0, 200)
        .map((item) => normalizeOpenDiagnostic(item, chatId, chatTitle))
        .filter(Boolean)
      : [];
    return {
      hasHistoryDiagnostics,
      historyAccessMethod: normalizeDiagnosticText(report.historyAccessMethod, 160),
      historyLoaderFallback: normalizeHistoryLoaderFallback(report.historyLoaderFallback),
      storeLoadRounds: normalizeOptionalCount(report.storeLoadRounds),
      storeReturnedMessages: normalizeOptionalCount(report.storeReturnedMessages),
      storeAddedMessages: normalizeOptionalCount(report.storeAddedMessages),
      storeEmptyRounds: normalizeOptionalCount(report.storeEmptyRounds),
      storeStalledRounds: normalizeOptionalCount(report.storeStalledRounds),
      openDiagnostics,
    };
  }

  function normalizeExtractionManifest(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const sourceReports = Array.isArray(raw.chatReports)
      ? raw.chatReports.map((report) => ["", report])
      : raw.chatReports && typeof raw.chatReports === "object"
        ? Object.entries(raw.chatReports)
        : [];
    const chatReports = sourceReports
      .map(([fallbackId, report]) => {
        if (!report || typeof report !== "object") return null;
        const chatId = normalizeId(report.chatId || report.id || fallbackId);
        const chatTitle = String(report.chatTitle || report.title || "").trim();
        return {
          chatId,
          chatTitle,
          complete: normalizeOptionalBoolean(report.complete),
          reason: String(report.reason || "").trim(),
          messageCount: normalizeOptionalCount(report.messageCount),
          syncClicks: normalizeOptionalCount(report.syncClicks),
          ...normalizeHistoryDiagnostics(report, chatId, chatTitle),
        };
      })
      .filter(Boolean);
    return {
      extractorBuildId: normalizeDiagnosticText(raw.extractorBuildId, 120),
      startedAt: String(raw.startedAt || ""),
      finishedAt: String(raw.finishedAt || ""),
      chatCount: normalizeOptionalCount(raw.chatCount),
      totalMessages: normalizeOptionalCount(raw.totalMessages),
      completeHistoryChats: normalizeOptionalCount(raw.completeHistoryChats),
      incompleteHistoryChats: normalizeOptionalCount(raw.incompleteHistoryChats),
      syncClicks: normalizeOptionalCount(raw.syncClicks),
      totalAttachments: normalizeOptionalCount(raw.totalAttachments),
      processedAttachments: normalizeOptionalCount(raw.processedAttachments),
      downloadedMedia: normalizeOptionalCount(raw.downloadedMedia),
      previewSaved: normalizeOptionalCount(raw.previewSaved),
      vcardSaved: normalizeOptionalCount(raw.vcardSaved),
      failed: normalizeOptionalCount(raw.failed),
      chatReports,
    };
  }

  function attachIntegrity(chats, manifest, parsedMessageCount) {
    const reportsById = new Map();
    if (manifest) {
      for (const report of manifest.chatReports) {
        if (report.chatId) reportsById.set(report.chatId, report);
      }
    }

    let completeChatCount = 0;
    let incompleteChatCount = 0;
    let unknownChatCount = 0;
    let unreportedChatCount = 0;
    let messageCountMismatchChatCount = 0;
    const parsedIds = new Set(chats.map((chat) => chat.id));
    const issues = [];

    for (const chat of chats) {
      const report = reportsById.get(chat.id) || null;
      const expected = report ? report.messageCount : null;
      const matches = expected == null ? null : expected === chat.messages.length;
      if (!report) {
        if (manifest) {
          unreportedChatCount += 1;
          issues.push({ code: "CHAT_NOT_REPORTED", chatId: chat.id });
        }
      } else if (report.complete === true) {
        completeChatCount += 1;
      } else if (report.complete === false) {
        incompleteChatCount += 1;
        issues.push({ code: "CHAT_HISTORY_INCOMPLETE", chatId: chat.id, reason: report.reason });
      } else {
        unknownChatCount += 1;
        issues.push({ code: "CHAT_COMPLETENESS_UNKNOWN", chatId: chat.id });
      }
      if (matches === false) {
        messageCountMismatchChatCount += 1;
        issues.push({
          code: "CHAT_MESSAGE_COUNT_MISMATCH",
          chatId: chat.id,
          expected,
          actual: chat.messages.length,
        });
      }
      chat.historyComplete = report ? report.complete : null;
      chat.historyReason = report ? report.reason : "";
      chat.reportedMessageCount = expected;
      chat.messageCountMatches = matches;
      chat.extraction = {
        reported: Boolean(report),
        complete: report ? report.complete : null,
        reason: report ? report.reason : "",
        expectedMessageCount: expected,
        parsedMessageCount: chat.messages.length,
        messageCountMatches: matches,
        hasHistoryDiagnostics: report ? report.hasHistoryDiagnostics : false,
        historyAccessMethod: report ? report.historyAccessMethod : "",
        historyLoaderFallback: report ? report.historyLoaderFallback : null,
        storeLoadRounds: report ? report.storeLoadRounds : null,
        storeReturnedMessages: report ? report.storeReturnedMessages : null,
        storeAddedMessages: report ? report.storeAddedMessages : null,
        storeEmptyRounds: report ? report.storeEmptyRounds : null,
        storeStalledRounds: report ? report.storeStalledRounds : null,
        openDiagnostics: report ? report.openDiagnostics : [],
      };
    }

    let missingChatCount = 0;
    for (const report of reportsById.values()) {
      if (!parsedIds.has(report.chatId)) {
        missingChatCount += 1;
        issues.push({ code: "REPORTED_CHAT_MISSING", chatId: report.chatId });
      }
    }

    const expectedMessageCount = manifest ? manifest.totalMessages : null;
    const totalMessagesMatch =
      expectedMessageCount == null ? null : expectedMessageCount === parsedMessageCount;
    const expectedChatCount = manifest ? manifest.chatCount : null;
    const chatCountMatch = expectedChatCount == null ? null : expectedChatCount === chats.length;
    if (totalMessagesMatch === false) {
      issues.push({
        code: "TOTAL_MESSAGE_COUNT_MISMATCH",
        expected: expectedMessageCount,
        actual: parsedMessageCount,
      });
    }
    if (chatCountMatch === false) {
      issues.push({ code: "CHAT_COUNT_MISMATCH", expected: expectedChatCount, actual: chats.length });
    }

    const hasMismatch =
      totalMessagesMatch === false ||
      chatCountMatch === false ||
      messageCountMismatchChatCount > 0 ||
      missingChatCount > 0;
    const hasIncomplete = incompleteChatCount > 0;
    const fullyReported =
      Boolean(manifest) &&
      unreportedChatCount === 0 &&
      unknownChatCount === 0 &&
      reportsById.size > 0;
    const verified =
      fullyReported &&
      totalMessagesMatch === true &&
      chatCountMatch !== false &&
      !hasMismatch &&
      !hasIncomplete;
    const complete = !manifest ? null : hasMismatch || hasIncomplete ? false : verified ? true : null;
    const status = !manifest
      ? "no-manifest"
      : hasMismatch
        ? "mismatch"
        : hasIncomplete
          ? "incomplete"
          : verified
            ? "complete"
            : "unverified";

    return {
      manifestPresent: Boolean(manifest),
      status,
      complete,
      expectedMessageCount,
      parsedMessageCount,
      totalMessagesMatch,
      expectedChatCount,
      parsedChatCount: chats.length,
      chatCountMatch,
      reportedChatCount: reportsById.size,
      completeChatCount,
      incompleteChatCount,
      unknownChatCount,
      unreportedChatCount,
      messageCountMismatchChatCount,
      missingChatCount,
      issues,
    };
  }

  async function digestSha512(source, cryptoProvider) {
    const subtle = cryptoProvider && cryptoProvider.subtle;
    if (!subtle || typeof subtle.digest !== "function") {
      throw new ArchiveError("NO_WEB_CRYPTO", "当前浏览器无法计算 SHA-512");
    }
    let buffer;
    if (source instanceof ArrayBuffer) {
      buffer = source;
    } else if (ArrayBuffer.isView(source)) {
      buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    } else if (source && typeof source.arrayBuffer === "function") {
      buffer = await source.arrayBuffer();
    } else {
      throw new ArchiveError("INVALID_HASH_SOURCE", "无法读取用于校验的 ZIP 数据");
    }
    const digest = await subtle.digest("SHA-512", buffer);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  }

  async function parseArchive(source, JSZipCtor, options) {
    const settings = options || {};
    const onProgress = typeof settings.onProgress === "function" ? settings.onProgress : function () {};
    if (!JSZipCtor || typeof JSZipCtor.loadAsync !== "function") {
      throw new ArchiveError("NO_ZIP_LIBRARY", "ZIP 解析组件未加载");
    }

    let zip;
    try {
      onProgress({ stage: "zip", percent: 0, message: "正在读取 ZIP…" });
      zip = await JSZipCtor.loadAsync(source, { createFolders: false }, (metadata) => {
        onProgress({
          stage: "zip",
          percent: Number(metadata.percent || 0),
          message: "正在展开 ZIP 目录…",
        });
      });
    } catch (error) {
      throw new ArchiveError("INVALID_ZIP", "无法打开该 ZIP 文件", error);
    }

    const entryIndex = makeEntryIndex(zip);
    const chatsItem = entryIndex.byBase.get("chats.json");
    const contactsItem = entryIndex.byBase.get("contacts.json");
    const accountItem = entryIndex.byBase.get("useraccount.json");
    const manifestItem = entryIndex.byBase.get("extraction_manifest.json");
    const rawChats = toRecordArray(await readJson(chatsItem, "chats.json", true));
    const rawContacts = await readJson(contactsItem, "contacts.json", false);
    const userAccount = await readJson(accountItem, "userAccount.json", false);
    const rawManifest = await readJson(manifestItem, "extraction_manifest.json", false);
    const extractionManifest = normalizeExtractionManifest(rawManifest);
    if (rawManifest != null && !extractionManifest) {
      throw new ArchiveError(
        "INVALID_MANIFEST",
        "extraction_manifest.json 的结构无效",
      );
    }
    const contacts = normalizeContactMap(rawContacts);
    const contactPhones = makeContactPhoneIndex(contacts);

    const chatFiles = entryIndex.entries
      .map((item) => {
        const match = item.base.match(/^Chat (.+)\.json$/i);
        return match ? { id: match[1], item } : null;
      })
      .filter(Boolean);
    if (!chatFiles.length) {
      throw new ArchiveError("MISSING_CHATS", "ZIP 中没有找到 Chat <id>.json 消息文件");
    }

    const messagesByChat = new Map();
    const messageKeysByChat = new Map();
    for (let fileIndex = 0; fileIndex < chatFiles.length; fileIndex += 1) {
      const file = chatFiles[fileIndex];
      const rawMessages = toRecordArray(await readJson(file.item, file.item.base, true));
      const messages = rawMessages
        .filter((item) => item && typeof item === "object")
        .map((item, index) => normalizeMessage(item, file.id, index, entryIndex, contacts));
      if (!messagesByChat.has(file.id)) {
        messagesByChat.set(file.id, []);
        messageKeysByChat.set(file.id, new Set());
      }
      const merged = messagesByChat.get(file.id);
      const seen = messageKeysByChat.get(file.id);
      for (const message of messages) {
        if (seen.has(message.key)) continue;
        seen.add(message.key);
        merged.push(message);
      }
      onProgress({
        stage: "messages",
        percent: ((fileIndex + 1) / chatFiles.length) * 100,
        message: `正在整理会话 ${fileIndex + 1}/${chatFiles.length}…`,
      });
    }

    const rawChatMap = new Map();
    for (const raw of rawChats) {
      if (!raw || typeof raw !== "object") continue;
      const id = normalizeId(raw.id);
      if (id) rawChatMap.set(id, raw);
    }
    const allIds = new Set([...rawChatMap.keys(), ...messagesByChat.keys()]);
    const avatars = avatarMap(entryIndex);
    const chats = Array.from(allIds)
      .map((id) =>
        normalizeChat(rawChatMap.get(id) || {}, id, messagesByChat.get(id) || [], avatars, contactPhones),
      )
      .sort((left, right) => right.timestamp - left.timestamp || left.title.localeCompare(right.title, "zh-CN"));

    if (!chats.length) {
      throw new ArchiveError("EMPTY_ARCHIVE", "ZIP 中没有可显示的会话");
    }
    const finalMessages = chats.flatMap((chat) => chat.messages);
    const typeCounts = {};
    let attachmentCount = 0;
    let availableAttachmentCount = 0;
    for (const message of finalMessages) {
      typeCounts[message.type] = (typeCounts[message.type] || 0) + 1;
      if (!message.media) continue;
      attachmentCount += 1;
      if (!message.media.missing) availableAttachmentCount += 1;
    }
    const messageCount = finalMessages.length;
    const integrity = attachIntegrity(chats, extractionManifest, messageCount);
    onProgress({ stage: "done", percent: 100, message: "聊天记录已载入" });
    return {
      zip,
      sourceName: String(settings.sourceName || "聊天记录.zip"),
      chats,
      contacts: Array.from(contacts.values()),
      userAccount,
      currentUser: normalizeCurrentUser(userAccount, contacts, avatars, settings.sourceName),
      extractionManifest,
      integrity,
      stats: {
        chatCount: chats.length,
        messageCount,
        attachmentCount,
        availableAttachmentCount,
        missingAttachmentCount: attachmentCount - availableAttachmentCount,
        typeCounts,
      },
    };
  }

  async function readEntryAsBlob(archive, entryName, mime) {
    if (!archive || !archive.zip || !entryName) {
      throw new ArchiveError("MISSING_ATTACHMENT", "附件不存在");
    }
    const entry = archive.zip.file(entryName);
    if (!entry) throw new ArchiveError("MISSING_ATTACHMENT", "ZIP 中找不到该附件");
    const blob = await entry.async("blob");
    if (!mime || blob.type === mime) return blob;
    return new Blob([blob], { type: mime });
  }

  return {
    ArchiveError,
    MEDIA_TYPES,
    MIME_EXTENSIONS,
    parseArchive,
    readEntryAsBlob,
    digestSha512,
    safeFileName,
  };
});
