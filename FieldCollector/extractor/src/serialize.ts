// This file intentionally contains JavaScript-compatible TypeScript. The build script concatenates
// the modules into one fixed MAIN-world expression without adding a runtime dependency.

FC.DATASETS = Object.freeze([
  "accounts", "contacts", "chats", "chat_lists", "participants", "messages",
  "message_events", "reactions", "receipts", "poll_votes", "group_events",
  "statuses", "calls", "channels", "channel_events", "communities",
  "community_relations", "presence_snapshots", "media_albums", "labels",
  "label_relations", "pins"
]);

FC.REPEATED_COLLECTION_KEYS = Object.freeze(["msgs", "messages", "models", "_models", "__x_models"]);

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
  const isMap = value => {
    try {
      return value instanceof Map || Object.prototype.toString.call(value) === "[object Map]";
    } catch {
      return false;
    }
  };
  if (isMap(collection)) {
    try { return Array.from(collection.values()); } catch {}
  }
  try {
    if (typeof collection.getModelsArray === "function") {
      const values = collection.getModelsArray();
      if (Array.isArray(values)) return values.slice();
    }
  } catch {}
  for (const key of ["models", "_models", "__x_models"]) {
    const values = FC.read(collection, key);
    if (Array.isArray(values)) return values.slice();
    if (isMap(values)) {
      try { return Array.from(values.values()); } catch {}
    }
  }
  // Newer WhatsApp builds keep WAWebCallCollection in a private, minified Map key.
  // Inspect only direct enumerable values; do not walk the full Store object graph.
  try {
    for (const key of Object.keys(collection)) {
      const values = FC.read(collection, key);
      if (isMap(values)) return Array.from(values.values());
    }
  } catch {}
  try {
    if (typeof collection.values === "function") {
      const values = Array.from(collection.values());
      if (values.length > 0) return values;
    }
  } catch {}
  return [];
};

FC.collectionReadable = function collectionReadable(collection) {
  if (!collection) return false;
  if (Array.isArray(collection)) return true;
  try {
    if (collection instanceof Map || Object.prototype.toString.call(collection) === "[object Map]") return true;
    if (typeof collection.getModelsArray === "function") return true;
    if (typeof collection.values === "function") return true;
    for (const key of ["models", "_models", "__x_models"]) {
      if (FC.read(collection, key) !== undefined) return true;
    }
    return Object.keys(collection).some(key => {
      const value = FC.read(collection, key);
      return value instanceof Map || Object.prototype.toString.call(value) === "[object Map]";
    });
  } catch {
    return false;
  }
};

FC.jsonSafe = function jsonSafe(value, seen = new WeakMap(), path = "$", depth = 0, options = {}) {
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
    return value.map((item, index) => FC.jsonSafe(item, seen, `${path}[${index}]`, depth + 1, options));
  }
  if (value instanceof Map) {
    return {
      __fieldCollectorType: "Map",
      entries: Array.from(value.entries(), ([key, item], index) => [
        FC.jsonSafe(key, seen, `${path}.mapKey${index}`, depth + 1, options),
        FC.jsonSafe(item, seen, `${path}.mapValue${index}`, depth + 1, options)
      ])
    };
  }
  if (value instanceof Set) {
    return {
      __fieldCollectorType: "Set",
      values: Array.from(value.values(), (item, index) =>
        FC.jsonSafe(item, seen, `${path}.setValue${index}`, depth + 1, options))
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
      const item = value[key];
      if (options.omitKeys?.has?.(key) || item === undefined || typeof item === "function" || typeof item === "symbol") {
        continue;
      }
      output[key] = FC.jsonSafe(item, seen, `${path}.${key}`, depth + 1, options);
    } catch (error) {
      output[key] = {__fieldCollectorType: "UnreadableProperty", error: String(error?.message || error)};
    }
  }
  return output;
};

FC.rawSnapshot = function rawSnapshot(model, options = {}) {
  if (model == null) return null;
  let raw = model;
  try {
    if (typeof model.toJSON === "function") raw = model.toJSON();
  } catch (error) {
    return {__fieldCollectorType: "ToJsonError", error: String(error?.message || error)};
  }
  const omitKeys = new Set(options.omitKeys || []);
  const output = FC.jsonSafe(raw, new WeakMap(), "$", 0, {omitKeys});
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const omitted = Array.from(omitKeys).filter(key => FC.read(raw, key) !== undefined);
    if (omitted.length > 0) output.__fieldCollectorOmittedKeys = omitted;
  }
  return output;
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

FC.timestampMillis = function timestampMillis(model) {
  const value = FC.first(model, ["t", "timestamp", "ts", "createdAt", "lastUpdatedAt"]);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

FC.chatId = function chatId(model, fallback = null) {
  const id = FC.first(model, ["chatId", "remote", "from", "to"]);
  const key = FC.first(model, ["id", "key"]);
  return FC.idString(id) || FC.idString(FC.first(key, ["remote", "chatId"])) || fallback;
};

FC.textValue = function textValue(value) {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    return text || null;
  }
  const nested = FC.first(value, ["text", "body", "about", "status", "value"]);
  if (nested !== undefined && nested !== value) return FC.textValue(nested);
  return null;
};

FC.phoneMetadata = function phoneMetadata(value) {
  if (value == null) return null;
  let serialized = FC.idString(value);
  const user = FC.textValue(FC.read(value, "user"));
  const server = FC.textValue(FC.first(value, ["server", "domain"]));
  const explicitDevice = FC.textValue(FC.first(value, ["device", "deviceId"]));
  if ((!serialized || serialized === "[object Object]") && user) {
    serialized = `${user}${explicitDevice ? `:${explicitDevice}` : ""}@${server || "c.us"}`;
  }
  if (!serialized) return null;
  serialized = String(serialized).trim();
  if (/^\+?\d{7,15}$/.test(serialized)) serialized = `${serialized.replace(/^\+/, "")}@c.us`;
  const match = serialized.match(/^(\+?\d{7,15})(?:(?::|_)(\d+))?@(?:c\.us|s\.whatsapp\.net)$/i);
  if (!match) return null;
  const phoneNumber = match[1].replace(/^\+/, "");
  const deviceId = match[2] || explicitDevice || null;
  return {
    phoneId: `${phoneNumber}@c.us`,
    phoneNumber,
    formattedPhoneNumber: `+${phoneNumber}`,
    deviceId,
    devicePhoneId: deviceId ? `${phoneNumber}:${deviceId}@c.us` : null
  };
};

FC.contactDirectIdentity = function contactDirectIdentity(model) {
  const id = FC.idString(FC.first(model, ["id", "wid"])) || null;
  const lidId = id && /@lid$/i.test(id) ? id : null;
  const candidates = ["phoneId", "pn", "phoneNumber", "phone"].map(key => FC.read(model, key));
  if (id && /@(?:c\.us|s\.whatsapp\.net)$/i.test(id)) candidates.push(FC.first(model, ["id", "wid"]));
  for (const candidate of candidates) {
    const phone = FC.phoneMetadata(candidate);
    if (phone) return {...phone, lidId, phoneSource: candidate === FC.first(model, ["id", "wid"]) ? "contact_id" : "contact_field"};
  }
  return {
    lidId,
    phoneId: null,
    phoneNumber: null,
    formattedPhoneNumber: null,
    deviceId: null,
    devicePhoneId: null,
    phoneSource: null
  };
};

FC.awaitIdentity = function awaitIdentity(value, timeoutMs = 5_000) {
  if (!value || typeof value.then !== "function") return Promise.resolve(value);
  let timer;
  return Promise.race([
    Promise.resolve(value),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("identity_resolution_timeout")), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
};

FC.resolveContactIdentity = async function resolveContactIdentity(model, env = {}, timeoutMs = 5_000) {
  const direct = FC.contactDirectIdentity(model);
  if (direct.phoneId || !direct.lidId || typeof env.contactPhoneNumber !== "function") return direct;
  try {
    const nativeId = FC.first(model, ["id", "wid"]) || direct.lidId;
    const resolved = await FC.awaitIdentity(env.contactPhoneNumber(nativeId), timeoutMs);
    const phone = FC.phoneMetadata(resolved);
    if (phone) return {...phone, lidId: direct.lidId, phoneSource: "WAWebApiContact.getPhoneNumber"};
  } catch {}
  return direct;
};

FC.contactRecord = function contactRecord(model, identity = {}, overrides = {}) {
  const id = FC.idString(FC.first(model, ["id", "wid"])) || identity.phoneId || identity.lidId || "unknown_contact";
  const profile = FC.first(model, ["businessProfile", "bizProfile", "profile"]) || {};
  const name = FC.first(model, ["formattedName", "name", "pushname", "pushName", "shortName"]);
  const about = FC.textValue(FC.first(model, ["about", "statusText", "status"]));
  return {
    id,
    lidId: identity.lidId || (/@lid$/i.test(id) ? id : null),
    phoneId: identity.phoneId || null,
    phoneNumber: identity.phoneNumber || null,
    formattedPhoneNumber: identity.formattedPhoneNumber || null,
    deviceId: identity.deviceId || null,
    devicePhoneId: identity.devicePhoneId || null,
    phoneResolution: identity.phoneId ? "resolved" : "unavailable",
    phoneSource: identity.phoneSource || null,
    name: name || null,
    displayName: FC.first(model, ["formattedName", "displayName"]) || name || null,
    savedName: FC.first(model, ["name", "savedName"]) || null,
    pushName: FC.first(model, ["pushname", "pushName"]) || null,
    shortName: FC.first(model, ["shortName"]) || null,
    verifiedName: FC.first(model, ["verifiedName", "verified_name"]) || null,
    about,
    isMe: Boolean(FC.read(model, "isMe")),
    isMyContact: Boolean(FC.read(model, "isMyContact") || FC.read(model, "syncToAddressbook")),
    isBusiness: Boolean(FC.first(model, ["isBusiness", "isEnterprise", "isContactSyncCompletedForBusiness"])),
    isVerified: Boolean(FC.first(model, ["isVerified", "isHighLevelVerified"])),
    isBlocked: Boolean(FC.first(model, ["isBlocked", "blocked"])),
    isWAContact: FC.first(model, ["isWAContact", "isUser"]) ?? null,
    canReceiveMessage: FC.first(model, ["canReceiveMessage", "canMessage"]) ?? null,
    contactType: FC.textValue(FC.first(model, ["contactType", "type", "kind"])),
    businessCategory: FC.textValue(FC.first(profile, ["category", "businessCategory"]) || FC.read(model, "businessCategory")),
    businessDescription: FC.textValue(FC.first(profile, ["description", "businessDescription"]) || FC.read(model, "businessDescription")),
    businessEmail: FC.textValue(FC.first(profile, ["email", "businessEmail"]) || FC.read(model, "businessEmail")),
    businessWebsite: FC.textValue(FC.first(profile, ["website", "websites"]) || FC.read(model, "businessWebsite")),
    ...overrides
  };
};

FC.meIdentity = async function meIdentity(env = {}) {
  const values = [];
  const meUser = env.meUser;
  for (const name of [
    "getMaybeMeDevicePn", "getMaybeMePnUser", "getMePnUser", "getMaybeMeUser",
    "getMeUser", "getMaybeMeLidUser", "getMeLidUser"
  ]) {
    try {
      const fn = FC.read(meUser, name);
      if (typeof fn === "function") values.push(await FC.awaitIdentity(fn.call(meUser), 3_000));
    } catch {}
  }
  for (const key of ["me", "meUser", "mePn", "meLid", "devicePn"]) {
    const value = FC.read(meUser, key);
    if (value) values.push(value);
  }
  const ids = [];
  let phone = null;
  let lidId = null;
  for (const value of values) {
    const id = FC.idString(value);
    if (id && !ids.includes(id)) ids.push(id);
    const candidatePhone = FC.phoneMetadata(value);
    if (!phone && candidatePhone) phone = candidatePhone;
    if (!lidId && id && /@lid$/i.test(id)) lidId = id;
  }
  return {
    ids,
    lidId,
    ...(phone || {
      phoneId: null, phoneNumber: null, formattedPhoneNumber: null,
      deviceId: null, devicePhoneId: null
    }),
    phoneSource: phone ? "WAWebUserPrefsMeUser" : null
  };
};

FC.collectContactIdentities = async function collectContactIdentities(contacts, env = {}, cancelled = () => false) {
  const models = Array.isArray(contacts) ? contacts : [];
  const records = new Array(models.length);
  let cursor = 0;
  const worker = async () => {
    while (!cancelled()) {
      const index = cursor++;
      if (index >= models.length) return;
      const identity = await FC.resolveContactIdentity(models[index], env);
      records[index] = FC.contactRecord(models[index], identity);
    }
  };
  await Promise.all(Array.from({length: Math.min(12, Math.max(1, models.length))}, worker));
  const compactRecords = records.filter(Boolean);
  const byPhone = new Map();
  for (const record of compactRecords) {
    if (!record.phoneId) continue;
    if (!byPhone.has(record.phoneId)) byPhone.set(record.phoneId, []);
    byPhone.get(record.phoneId).push(record);
  }
  // WAWebApiContact supplies the deterministic LID -> PN relation. Copy only that
  // proven relation to the sibling PN record; never infer identity from a display name.
  for (const siblings of byPhone.values()) {
    const lidId = siblings.find(record => record.lidId)?.lidId || null;
    if (lidId) siblings.forEach(record => { record.lidId ||= lidId; });
  }
  const index = new Map();
  // A record always owns its native id. Aliases are added afterwards so a
  // resolved LID cannot shadow the actual @c.us contact model.
  for (const record of compactRecords) {
    if (record.id) index.set(record.id, record);
  }
  for (const record of compactRecords) {
    for (const key of [record.lidId, record.phoneId, record.devicePhoneId]) {
      if (key && !index.has(key)) index.set(key, record);
    }
  }
  return {records: compactRecords, index};
};

FC.accountRecord = async function accountRecord(contacts, identities, env = {}) {
  const me = await FC.meIdentity(env);
  let storeMe = null;
  try { storeMe = env.contactCollection?.getMeContact?.() || null; } catch {}
  const flagged = contacts.find(contact => Boolean(FC.read(contact, "isMe"))) || null;
  const candidates = [me.phoneId, me.lidId, ...me.ids]
    .map(id => identities.index.get(id))
    .filter(Boolean);
  let base = candidates.find(record => record.phoneId === me.phoneId) || candidates[0] || null;
  const fallbackModel = storeMe || flagged;
  if (!base && fallbackModel) {
    const identity = await FC.resolveContactIdentity(fallbackModel, env);
    base = FC.contactRecord(fallbackModel, identity);
  }
  if (!base && !me.phoneId && !me.lidId) return null;
  const fallback = fallbackModel ? FC.contactRecord(fallbackModel, await FC.resolveContactIdentity(fallbackModel, env)) : {};
  const merged = {...fallback, ...(base || {})};
  for (const key of ["name", "displayName", "savedName", "pushName", "shortName", "verifiedName", "about"]) {
    if (!merged[key] && fallback[key]) merged[key] = fallback[key];
  }
  const phone = me.phoneId ? me : FC.contactDirectIdentity(merged);
  return {
    ...merged,
    id: me.phoneId || merged.id || me.lidId,
    lidId: me.lidId || merged.lidId || null,
    phoneId: phone.phoneId || merged.phoneId || null,
    phoneNumber: phone.phoneNumber || merged.phoneNumber || null,
    formattedPhoneNumber: phone.formattedPhoneNumber || merged.formattedPhoneNumber || null,
    deviceId: phone.deviceId || merged.deviceId || null,
    devicePhoneId: phone.devicePhoneId || merged.devicePhoneId || null,
    phoneResolution: phone.phoneId || merged.phoneId ? "resolved" : "unavailable",
    phoneSource: phone.phoneSource || merged.phoneSource || null,
    isMe: true,
    accountSource: me.ids.length > 0 ? "WAWebUserPrefsMeUser" : storeMe ? "ContactCollection.getMeContact" : "contact.isMe"
  };
};

FC.chatRecord = function chatRecord(model, identityIndex = new Map()) {
  const id = FC.idString(FC.first(model, ["id", "wid"])) || "unknown_chat";
  const isGroup = Boolean(FC.read(model, "isGroup") || id.endsWith("@g.us"));
  const contactId = isGroup
    ? null
    : FC.idString(FC.first(FC.first(model, ["contact", "peer", "contactModel"]), ["id", "wid"])) || id;
  const identity = contactId ? identityIndex.get(contactId) || null : null;
  return {
    id,
    title: String(FC.first(model, ["formattedTitle", "name", "title"]) || id),
    kind: String(FC.first(model, ["kind", "type"]) || (FC.read(model, "isGroup") ? "group" : "chat")),
    isGroup,
    contactId,
    contactName: identity?.displayName || identity?.name || null,
    lidId: identity?.lidId || (/@lid$/i.test(contactId || "") ? contactId : null),
    phoneId: identity?.phoneId || null,
    phoneNumber: identity?.phoneNumber || null,
    formattedPhoneNumber: identity?.formattedPhoneNumber || null,
    about: identity?.about || null,
    isBusiness: identity?.isBusiness ?? null,
    archived: Boolean(FC.first(model, ["archive", "archived"])),
    pinned: Boolean(FC.first(model, ["pin", "pinned"])),
    unreadCount: Number(FC.first(model, ["unreadCount", "unread"]) || 0),
    lastMessageAt: FC.timestamp(FC.first(model, ["lastReceivedKey", "lastMessage", "t"]) || model),
    raw: FC.rawSnapshot(model, {omitKeys: FC.REPEATED_COLLECTION_KEYS})
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
    // The caller already knows which chat collection owns this message.  In
    // WhatsApp's current models an outgoing message can expose the local
    // account through `from` before it exposes the remote chat through `to`.
    // Treating those fields as the owning chat writes the account id into
    // messages.csv, so prefer the parent chat id whenever it is available.
    chatId: FC.idString(fallbackChatId) || FC.chatId(model),
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
    }
  };
};

FC.genericRecord = function genericRecord(dataset, model, index = 0) {
  const id = FC.idString(FC.first(model, ["id", "wid", "jid", "key"])) || `${dataset}_${index}`;
  return {
    id,
    dataset,
    chatId: FC.chatId(model),
    timestamp: FC.timestamp(model),
    raw: FC.rawSnapshot(model, {omitKeys: FC.REPEATED_COLLECTION_KEYS})
  };
};

FC.sanitizeFileName = function sanitizeFileName(value, fallback = "file") {
  const cleaned = String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return (cleaned || fallback).slice(0, 140);
};
