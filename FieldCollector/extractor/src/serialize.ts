// This file intentionally contains JavaScript-compatible TypeScript. The build script concatenates
// the modules into one fixed MAIN-world expression without adding a runtime dependency.

FC.DATASETS = Object.freeze([
  "accounts", "contacts", "chats", "chat_lists", "participants", "messages",
  "message_events", "reactions", "receipts", "poll_votes", "group_events",
  "statuses", "calls", "channels", "channel_events", "communities",
  "community_relations", "presence_snapshots", "media_albums", "labels",
  "label_relations", "pins"
]);

FC.datasetBatches = function datasetBatches(records, maximumBytes = 768 * 1024) {
  const batches = [];
  let batch = [];
  let batchBytes = 2;
  for (const record of records) {
    let recordBytes;
    try {
      recordBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    } catch {
      recordBytes = maximumBytes;
    }
    if (batch.length > 0 && (batch.length >= 100 || batchBytes + recordBytes + 1 > maximumBytes)) {
      batches.push(batch);
      batch = [];
      batchBytes = 2;
    }
    batch.push(record);
    batchBytes += recordBytes + 1;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
};

FC.read = function read(value, key) {
  if (value == null) return undefined;
  try { return value[key]; } catch { return undefined; }
};

FC.first = function first(value, keys) {
  for (const key of keys) {
    const candidate = FC.read(value, key);
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return undefined;
};

FC.idString = function idString(value) {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  const serialized = FC.first(value, ["_serialized", "serialized", "$1"]);
  if (serialized != null) return String(serialized);
  const nested = FC.first(value, ["id", "wid", "jid"]);
  if (nested && nested !== value) return FC.idString(nested);
  try {
    const rendered = String(value);
    return rendered === "[object Object]" ? null : rendered;
  } catch {
    return null;
  }
};

FC.collectionValues = function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection.slice();
  try {
    if (typeof collection.getModelsArray === "function") {
      const values = collection.getModelsArray();
      if (Array.isArray(values)) return values.slice();
    }
  } catch {}
  for (const key of ["models", "_models", "__x_models"]) {
    const values = FC.read(collection, key);
    if (Array.isArray(values)) return values.slice();
  }
  return [];
};

FC.jsonSafe = function jsonSafe(value, seen = new WeakMap(), path = "$", depth = 0) {
  if (depth > 24) return {__fieldCollectorType: "MaximumDepth", path};
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : {__fieldCollectorType: "Number", value: String(value)};
  }
  if (typeof value === "undefined") return {__fieldCollectorType: "Undefined"};
  if (typeof value === "bigint") return {__fieldCollectorType: "BigInt", value: value.toString()};
  if (typeof value === "function" || typeof value === "symbol") {
    return {__fieldCollectorType: typeof value};
  }
  if (value instanceof Date) return {__fieldCollectorType: "Date", value: value.toISOString()};
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return {__fieldCollectorType: "Blob", mimeType: value.type || "", size: value.size};
  }
  if (value instanceof ArrayBuffer) {
    return {__fieldCollectorType: "ArrayBuffer", byteLength: value.byteLength};
  }
  if (ArrayBuffer.isView(value)) {
    return {
      __fieldCollectorType: value.constructor?.name || "TypedArray",
      byteLength: value.byteLength
    };
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return {__fieldCollectorType: "Reference", path: seen.get(value)};
  seen.set(value, path);
  if (Array.isArray(value)) {
    return value.map((item, index) => FC.jsonSafe(item, seen, `${path}[${index}]`, depth + 1));
  }
  if (value instanceof Map) {
    return {
      __fieldCollectorType: "Map",
      entries: Array.from(value.entries(), ([key, item], index) => [
        FC.jsonSafe(key, seen, `${path}.mapKey${index}`, depth + 1),
        FC.jsonSafe(item, seen, `${path}.mapValue${index}`, depth + 1)
      ])
    };
  }
  if (value instanceof Set) {
    return {
      __fieldCollectorType: "Set",
      values: Array.from(value.values(), (item, index) =>
        FC.jsonSafe(item, seen, `${path}.setValue${index}`, depth + 1))
    };
  }
  const output = {};
  const constructorName = value.constructor?.name;
  if (constructorName && constructorName !== "Object") output.__fieldCollectorConstructor = constructorName;
  let keys = [];
  try { keys = Object.keys(value); } catch (error) {
    return {__fieldCollectorType: "UnreadableObject", error: String(error?.message || error)};
  }
  for (const key of keys) {
    try {
      output[key] = FC.jsonSafe(value[key], seen, `${path}.${key}`, depth + 1);
    } catch (error) {
      output[key] = {__fieldCollectorType: "UnreadableProperty", error: String(error?.message || error)};
    }
  }
  return output;
};

FC.rawSnapshot = function rawSnapshot(model) {
  if (model == null) return null;
  let raw = model;
  try {
    if (typeof model.toJSON === "function") raw = model.toJSON();
  } catch (error) {
    return {__fieldCollectorType: "ToJsonError", error: String(error?.message || error)};
  }
  return FC.jsonSafe(raw);
};

FC.timestamp = function timestamp(model) {
  const value = FC.first(model, ["t", "timestamp", "ts", "createdAt", "lastUpdatedAt"]);
  if (value == null) return null;
  if (typeof value === "number") {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  return String(value);
};

FC.chatId = function chatId(model, fallback = null) {
  const id = FC.first(model, ["chatId", "remote", "from", "to"]);
  const key = FC.first(model, ["id", "key"]);
  return FC.idString(id) || FC.idString(FC.first(key, ["remote", "chatId"])) || fallback;
};

FC.chatRecord = function chatRecord(model) {
  const id = FC.idString(FC.first(model, ["id", "wid"])) || "unknown_chat";
  return {
    id,
    title: String(FC.first(model, ["formattedTitle", "name", "title"]) || id),
    kind: String(FC.first(model, ["kind", "type"]) || (FC.read(model, "isGroup") ? "group" : "chat")),
    isGroup: Boolean(FC.read(model, "isGroup") || id.endsWith("@g.us")),
    archived: Boolean(FC.first(model, ["archive", "archived"])),
    pinned: Boolean(FC.first(model, ["pin", "pinned"])),
    unreadCount: Number(FC.first(model, ["unreadCount", "unread"]) || 0),
    lastMessageAt: FC.timestamp(FC.first(model, ["lastReceivedKey", "lastMessage", "t"]) || model),
    raw: FC.rawSnapshot(model)
  };
};

FC.contactRecord = function contactRecord(model) {
  const id = FC.idString(FC.first(model, ["id", "wid"])) || "unknown_contact";
  return {
    id,
    name: FC.first(model, ["formattedName", "pushname", "name", "shortName"]) || null,
    isMe: Boolean(FC.read(model, "isMe")),
    isMyContact: Boolean(FC.read(model, "isMyContact") || FC.read(model, "syncToAddressbook")),
    isBusiness: Boolean(FC.first(model, ["isBusiness", "isEnterprise"])),
    isVerified: Boolean(FC.first(model, ["isVerified", "isHighLevelVerified"])),
    status: FC.first(model, ["status", "about"]) || null,
    raw: FC.rawSnapshot(model)
  };
};

FC.messageRecord = function messageRecord(model, fallbackChatId = null) {
  const key = FC.first(model, ["id", "key"]);
  const id = FC.idString(key) || FC.idString(FC.first(model, ["stanzaId", "msgId"])) || `synthetic_${FC.timestamp(model)}`;
  const mediaData = FC.first(model, ["mediaData", "mediaObject", "mediaInfo"]);
  const body = FC.first(model, ["body", "caption", "text"]);
  const type = String(FC.first(model, ["type", "kind"]) || "unknown");
  const bodyLooksLikeMediaPayload = type !== "chat"
    && typeof body === "string"
    && body.length > 256
    && /^[A-Za-z0-9+/=\s]+$/.test(body);
  return {
    id,
    chatId: FC.chatId(model, fallbackChatId),
    senderId: FC.idString(FC.first(model, ["author", "from", "senderObj"])),
    recipientId: FC.idString(FC.first(model, ["to", "recipient"])),
    fromMe: Boolean(FC.first(key, ["fromMe"]) || FC.read(model, "fromMe")),
    timestamp: FC.timestamp(model),
    type,
    text: typeof body === "string" && body.length < 4_000_000 && !bodyLooksLikeMediaPayload ? body : null,
    caption: FC.first(model, ["caption"]) || null,
    quotedMessageId: FC.idString(FC.first(model, ["quotedStanzaID", "quotedMsgId", "quotedMsg"])),
    isForwarded: Boolean(FC.first(model, ["isForwarded", "forwardingScore"])),
    isStarred: Boolean(FC.read(model, "star")),
    isRevoked: Boolean(FC.first(model, ["isRevoked", "revoked"])),
    acknowledgement: FC.first(model, ["ack", "status"]) ?? null,
    hasMedia: Boolean(mediaData || FC.first(model, ["isMedia", "mimetype", "mimeType"])),
    media: {
      mimeType: FC.first(model, ["mimetype", "mimeType"]) || FC.first(mediaData, ["mimetype", "mimeType"]) || null,
      fileName: FC.first(model, ["filename", "fileName"]) || FC.first(mediaData, ["filename", "fileName"]) || null,
      size: FC.first(model, ["size", "fileSize"]) || FC.first(mediaData, ["size", "fileSize"]) || null,
      durationSeconds: FC.first(model, ["duration", "durationSeconds"]) || null
    },
    raw: FC.rawSnapshot(model)
  };
};

FC.genericRecord = function genericRecord(dataset, model, index = 0) {
  const id = FC.idString(FC.first(model, ["id", "wid", "jid", "key"])) || `${dataset}_${index}`;
  return {
    id,
    dataset,
    chatId: FC.chatId(model),
    timestamp: FC.timestamp(model),
    raw: FC.rawSnapshot(model)
  };
};

FC.sanitizeFileName = function sanitizeFileName(value, fallback = "file") {
  const cleaned = String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return (cleaned || fallback).slice(0, 140);
};
