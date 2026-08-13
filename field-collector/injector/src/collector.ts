(() => {
  "use strict";

  const PROTOCOL = "wafc-bridge/2";
  const VERSION = "0.2.5";
  const ADAPTER_ID = "wa-private-collections-v2";
  const MAX_CONTROL_BYTES = 64 * 1024;
  const MAX_DATA_FRAME_BYTES = 256 * 1024;
  const MAX_RECORDS_PER_FRAME = 256;
  const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
  const MEDIA_CHUNK_BYTES = 192 * 1024;
  const MAX_MEDIA_BYTES = 32 * 1024 * 1024 * 1024;
  const MAX_HISTORY_ROUNDS = 50;
  const HISTORY_DB_BATCH_SIZE = 100;
  // History remains a bounded Store call; keep it below the short channel
  // timeout. Media loading is fully asynchronous and does not use this value.
  const HISTORY_TIMEOUT_MS = 8_000;
  const STABLE_HISTORY_ROUNDS = 2;
  const ACCOUNT_BINDING_DOMAIN = "WAFC-ACCOUNT-BINDING-v1\0";
  const RESUME_BINDING_DOMAIN = "WAFC-RESUME-BINDING-v1\0";
  const MEDIA_PLAN_DOMAIN = "WAFC-MEDIA-PLAN-v1\0";
  const DATASETS = Object.freeze([
    "accounts", "contacts", "chats", "chat_lists", "participants", "messages",
    "message_events", "reactions", "receipts", "poll_votes", "group_events",
    "statuses", "calls", "channels", "channel_events", "communities",
    "community_relations", "presence_snapshots"
  ]);
  const encoder = new TextEncoder();
  const webCrypto = window.crypto;
  const accountBindingSecret = new Uint8Array(32);
  if (webCrypto && typeof webCrypto.getRandomValues === "function") {
    webCrypto.getRandomValues(accountBindingSecret);
  }

  const state = {
    phase: "idle",
    adapter: null,
    probe: null,
    accountBindingSha256: null,
    resumeChallengeHex: null,
    resumeBindingSha256: null,
    resumeExisting: false,
    expectedMediaPlanSha256: null,
    mediaPlanSha256: null,
    mediaStartIndex: 0,
    seededMediaTotals: null,
    pending: null,
    lastAck: null,
    nextSequence: 0n,
    operation: null,
    observedAt: null,
    datasets: null,
    datasetIndex: 0,
    streamStarted: false,
    totals: null,
    historyChats: null,
    historyIndex: 0,
    historyStats: new Map(),
    historyMessages: new Map(),
    globalMessagesByChat: new Map(),
    messageReferenceIndex: new Map(),
    omissionCounts: new Map(),
    mediaTasks: null,
    mediaPolicy: null,
    mediaQueueStopReason: null,
    mediaIndex: 0,
    activeMedia: null,
    mediaTotals: {
      requested: 0, available: 0, missing: 0, expired: 0, decryptError: 0,
      downloadTimeout: 0, noProgressTimeout: 0, tooLarge: 0,
      diskSpaceInsufficient: 0, hashMismatch: 0, transportInterrupted: 0,
      canceled: 0, unavailable: 0, notAttempted: 0
    }
  };

  function createSessionId() {
    if (webCrypto && typeof webCrypto.randomUUID === "function") {
      return webCrypto.randomUUID();
    }
    if (webCrypto && typeof webCrypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      webCrypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return "crypto-unavailable-session";
  }

  const sessionId = createSessionId();

  function read(object, key) {
    try {
      return object == null ? undefined : object[key];
    } catch (_) {
      return undefined;
    }
  }

  function first(object, keys) {
    for (const key of keys) {
      const value = read(object, key);
      if (value !== undefined && value !== null) {
        return value;
      }
    }
    return undefined;
  }

  function compact(record) {
    const output = {};
    for (const key of Object.keys(record)) {
      if (record[key] !== undefined) {
        output[key] = record[key];
      }
    }
    return output;
  }

  function idString(value) {
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
    if (!value || typeof value !== "object") {
      return null;
    }
    const serialized = first(value, ["_serialized", "serialized"]);
    if (typeof serialized === "string") {
      return serialized;
    }
    const user = read(value, "user");
    const server = read(value, "server");
    return typeof user === "string" && typeof server === "string" ? `${user}@${server}` : null;
  }

  function messageKeyString(value, fallbackChatId) {
    const serialized = idString(value);
    if (serialized) return serialized;
    if (!value || typeof value !== "object") return null;

    const nativeMessageId = first(value, ["id", "messageId", "stanzaId"]);
    if (typeof nativeMessageId !== "string" && typeof nativeMessageId !== "number") {
      return null;
    }
    const messageId = String(nativeMessageId);
    if (messageId.length === 0 || messageId.length > 512) return null;

    const remoteId = idString(first(value, ["remote", "remoteJid", "chatId"])) || fallbackChatId;
    if (typeof remoteId !== "string" || remoteId.length === 0) return null;
    const participantId = idString(first(value, ["participant", "participantId"]));
    const fromMe = booleanValue(read(value, "fromMe"));
    return [
      fromMe === null ? "unknown" : (fromMe ? "from_me" : "to_me"),
      remoteId,
      participantId || "no_participant",
      messageId
    ].join("_");
  }

  function messageModelViews(model) {
    const output = [];
    const seen = new Set();
    const queue = [{value: model, depth: 0}];
    const wrapperKeys = [
      "attributes", "__x_attributes", "data", "__x_data", "model", "msg", "message"
    ];
    while (queue.length > 0 && output.length < 24) {
      const current = queue.shift();
      const value = current && current.value;
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      output.push(value);
      if (current.depth >= 3) continue;
      for (const key of wrapperKeys) {
        const nested = read(value, key);
        if (nested && typeof nested === "object" && !seen.has(nested)) {
          queue.push({value: nested, depth: current.depth + 1});
        }
      }
    }
    return output;
  }

  function messageNativeId(model, fallbackChatId) {
    // Some WhatsApp builds return bare MsgKey/string values from the history
    // loader instead of materialising full models in chat.msgs. Preserve those
    // stable native references rather than silently dropping the whole batch.
    const direct = messageKeyString(model, fallbackChatId);
    if (direct) return direct;
    for (const view of messageModelViews(model)) {
      const viewKey = messageKeyString(view, fallbackChatId);
      if (viewKey) return viewKey;
      for (const key of ["id", "key", "msgKey", "messageKey", "__x_id", "__x_key"]) {
        const stable = messageKeyString(read(view, key), fallbackChatId);
        if (stable) return stable;
      }
    }
    return null;
  }

  function messageField(model, keys) {
    for (const view of messageModelViews(model)) {
      const value = first(view, keys);
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  }

  function messageKeyObject(model) {
    for (const view of messageModelViews(model)) {
      for (const key of ["id", "key", "msgKey", "messageKey", "__x_id", "__x_key"]) {
        const value = read(view, key);
        if (value !== undefined && value !== null) return value;
      }
    }
    return model && typeof model === "object" ? model : null;
  }

  function messageChatId(model, fallbackChatId) {
    const direct = idString(messageField(model, ["chatId", "remote", "remoteJid"]));
    if (direct) return direct;
    const chat = messageField(model, ["chat", "chatModel"]);
    const fromChat = idString(first(chat, ["id", "wid"]));
    if (fromChat) return fromChat;
    const key = messageKeyObject(model);
    return idString(first(key, ["remote", "remoteJid", "chatId"])) || fallbackChatId;
  }

  function messageHasObservableFields(model) {
    return messageField(model, [
      "type", "__x_type", "t", "timestamp", "body", "__x_body", "caption",
      "senderObj", "author", "to", "mediaData", "mediaObject", "mimetype", "mimeType"
    ]) !== undefined;
  }

  function stringValue(value) {
    return typeof value === "string" ? value : null;
  }

  function numberValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function unsignedInteger(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function booleanValue(value) {
    return typeof value === "boolean" ? value : null;
  }

  function collectionValues(collection) {
    if (Array.isArray(collection)) {
      return collection.slice();
    }
    if (collection && typeof collection.getModelsArray === "function") {
      const values = collection.getModelsArray();
      if (Array.isArray(values)) {
        return values.slice();
      }
    }
    for (const key of ["models", "_models"]) {
      const values = read(collection, key);
      if (Array.isArray(values)) {
        return values.slice();
      }
    }
    throw new Error("collection_shape_changed");
  }

  function optionalCollectionValues(collection) {
    try {
      return collectionValues(collection);
    } catch (_) {
      return [];
    }
  }

  function normalizeLoadedMessages(result) {
    if (Array.isArray(result)) {
      return {recognized: true, messages: result.slice()};
    }
    if (supportsCollection(result)) {
      return {recognized: true, messages: collectionValues(result)};
    }
    if (result && typeof result === "object") {
      const nested = first(result, ["messages", "msgs"]);
      if (Array.isArray(nested)) {
        return {recognized: true, messages: nested.slice()};
      }
      if (supportsCollection(nested)) {
        return {recognized: true, messages: collectionValues(nested)};
      }
    }
    return {recognized: false, messages: []};
  }

  function combinedCollectionValues(collections) {
    const output = [];
    const seenIds = new Set();
    const seenObjects = new Set();
    for (const collection of collections || []) {
      for (const model of optionalCollectionValues(collection)) {
        const id = idString(read(model, "id"));
        if (id) {
          if (seenIds.has(id)) continue;
          seenIds.add(id);
        } else if (model && typeof model === "object") {
          if (seenObjects.has(model)) continue;
          seenObjects.add(model);
        }
        output.push(model);
      }
    }
    return output;
  }

  function supportsCollection(collection) {
    return Boolean(
      collection &&
      (Array.isArray(collection) ||
        typeof collection.getModelsArray === "function" ||
        Array.isArray(read(collection, "models")) ||
        Array.isArray(read(collection, "_models")))
    );
  }

  function fixedModule(name) {
    const moduleLoader = Reflect.get(window, "require");
    if (typeof moduleLoader !== "function") {
      throw new Error("private_module_loader_unavailable");
    }
    return moduleLoader(name);
  }

  function optionalModule(name) {
    try {
      return fixedModule(name);
    } catch (_) {
      return null;
    }
  }

  function moduleCollection(module, names) {
    for (const name of names) {
      const value = read(module, name);
      if (supportsCollection(value)) {
        return value;
      }
    }
    return supportsCollection(module) ? module : null;
  }

  function buildLabel() {
    const debug = read(window, "Debug");
    for (const candidate of [read(debug, "VERSION"), read(debug, "BUILD"), read(window, "WAWebVersion")]) {
      if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 128) {
        return candidate;
      }
    }
    return "unreported";
  }

  function capability(dataset, result, reasonCodes = []) {
    return {dataset, result, reasonCodes};
  }

  function detectAdapter() {
    const result = {
      supported: false,
      adapterId: null,
      build: buildLabel(),
      accountBindingSha256: null,
      reasons: [],
      capabilities: {
        passiveT0: false,
        comprehensiveReadonlyV02: false,
        accounts: false,
        contacts: false,
        chats: false,
        messages: false,
        media: false,
        historyLoading: false,
        networkActions: false,
        domWrites: false,
        datasets: []
      }
    };
    try {
      if (result.build === "unreported") {
        result.reasons.push("unknown_build");
        return {result, adapter: null};
      }
      const contactsModule = fixedModule("WAWebContactCollection");
      const chatsModule = fixedModule("WAWebChatCollection");
      const accountModule = fixedModule("WAWebUserPrefsMeUser");
      const contacts = read(contactsModule, "ContactCollection");
      const chats = read(chatsModule, "ChatCollection");
      const accountReadable = Boolean(contacts && typeof contacts.getMeContact === "function");
      if (!supportsCollection(contacts)) result.reasons.push("contact_collection_signature_mismatch");
      if (!supportsCollection(chats)) result.reasons.push("chat_collection_signature_mismatch");
      if (!accountReadable) result.reasons.push("account_reader_signature_mismatch");
      if (!accountModule || typeof accountModule !== "object") {
        result.reasons.push("account_module_signature_mismatch");
      }
      if (result.reasons.length !== 0) {
        return {result, adapter: null};
      }

      const collectionsModule = optionalModule("WAWebCollections");
      const messageCollection = moduleCollection(optionalModule("WAWebMsgCollection"), [
        "MsgCollection", "MessageCollection", "default"
      ]) || moduleCollection(collectionsModule, ["Msg", "MsgCollection"]);
      const historyModule = optionalModule("WAWebChatLoadMessages");
      const historyOwner = historyModule && read(historyModule, "default") &&
        typeof read(read(historyModule, "default"), "loadEarlierMsgs") === "function"
        ? read(historyModule, "default") : historyModule;
      const historyLoader = historyOwner && read(historyOwner, "loadEarlierMsgs");
      const dbHistoryModule = optionalModule("WAWebDBMessageFindLocal");
      const dbHistoryOwner = dbHistoryModule && read(dbHistoryModule, "default") &&
        typeof read(read(dbHistoryModule, "default"), "msgFindByDirection") === "function"
        ? read(dbHistoryModule, "default") : dbHistoryModule;
      const dbHistoryLoader = dbHistoryOwner && read(dbHistoryOwner, "msgFindByDirection");
      const msgKeyModule = optionalModule("WAWebMsgKey");
      const msgKeyFactory = typeof read(msgKeyModule, "fromString") === "function"
        ? msgKeyModule : first(msgKeyModule, ["default", "MsgKey"]);
      const dbHistoryReadable = typeof dbHistoryLoader === "function"
        && typeof read(msgKeyFactory, "fromString") === "function";
      const blobCacheModule = optionalModule("WAWebMediaInMemoryBlobCache");
      const blobCache = first(blobCacheModule, [
        "InMemoryMediaBlobCache", "MediaBlobCache", "default"
      ]);
      const lruMediaModule = optionalModule("WAWebLruMediaStore");
      const lruMediaStore = first(lruMediaModule, ["LruMediaStore", "default"]);
      const profilePictures = moduleCollection(optionalModule("WAWebProfilePicThumbCollection"), [
        "ProfilePicThumbCollection", "ProfilePicThumbCollectionImpl", "default"
      ]) || moduleCollection(collectionsModule, ["ProfilePicThumb", "ProfilePicThumbCollection"]);

      const calls = moduleCollection(optionalModule("WAWebCallCollection"), [
        "CallCollection", "CallCollectionImpl", "default"
      ]);
      const statusV3Collections = [
        moduleCollection(optionalModule("WAWebStatusCollection"), [
          "StatusV3CollectionImpl", "StatusCollectionImpl", "StatusV3Collection", "StatusCollection", "default"
        ]),
        moduleCollection(collectionsModule, ["StatusV3", "StatusV3Collection"])
      ].filter(Boolean);
      const textStatuses = moduleCollection(optionalModule("WAWebTextStatusCollection"), [
        "TextStatusCollectionImpl", "TextStatusCollection", "default"
      ]);
      const channels = moduleCollection(optionalModule("WAWebNewsletterCollection"), [
        "NewsletterCollection", "NewsletterMetadataCollection", "default"
      ]) || moduleCollection(collectionsModule, ["NewsletterCollection", "NewsletterMetadata"]);
      const groupMetadataCollection = moduleCollection(optionalModule("WAWebGroupMetadataCollection"), [
        "GroupMetadataCollectionImpl", "GroupMetadataCollection", "default"
      ]) || moduleCollection(collectionsModule, ["WAWebGroupMetadataCollection", "GroupMetadata"]);
      const labels = moduleCollection(optionalModule("WAWebLabelCollection"), [
        "LabelCollectionImpl", "LabelCollection", "default"
      ]);
      const labelItems = moduleCollection(optionalModule("WAWebLabelItemCollection"), [
        "LabelItemCollectionImpl", "LabelItemCollection", "default"
      ]) || moduleCollection(collectionsModule, ["LabelItem", "LabelItemCollection"]);
      const pins = moduleCollection(optionalModule("WAWebPinInChatCollection"), [
        "PinInChatCollectionImpl", "PinInChatCollection", "default"
      ]);
      const presence = moduleCollection(optionalModule("WAWebPresenceCollection"), [
        "PresenceCollectionImpl", "PresenceCollection", "default"
      ]);
      const reactions = moduleCollection(optionalModule("WAWebReactionsCollection"), [
        "ReactionsCollectionImpl", "ReactionsCollection", "default"
      ]);
      const messageInfo = moduleCollection(optionalModule("WAWebMsgInfoCollection"), [
        "MsgInfoCollectionImpl", "MsgInfoCollection", "default"
      ]);
      const conversations = combinedCollectionValues([chats, channels]).filter((chat) =>
        supportsCollection(read(chat, "msgs")));
      const messageReaderObserved = optionalCollectionValues(messageCollection).some((message) =>
        messageModelViews(message).some((view) => typeof read(view, "downloadMedia") === "function")
        || typeof read(messageField(message, ["mediaData"]), "downloadMedia") === "function"
        || Boolean(read(messageField(message, ["mediaData"]), "mediaBlob"))
        || Boolean(read(messageField(message, ["mediaObject"]), "mediaBlob")))
        || conversations.some((chat) =>
        optionalCollectionValues(read(chat, "msgs")).some((message) =>
          messageModelViews(message).some((view) => typeof read(view, "downloadMedia") === "function")
          || typeof read(messageField(message, ["mediaData"]), "downloadMedia") === "function"
          || Boolean(read(messageField(message, ["mediaData"]), "mediaBlob"))
          || Boolean(read(messageField(message, ["mediaObject"]), "mediaBlob"))));
      const mediaReadable = Boolean(
        (blobCache && typeof read(blobCache, "get") === "function")
        || (lruMediaStore && typeof read(lruMediaStore, "get") === "function")
        || optionalCollectionValues(profilePictures).some(profilePictureHasObservableSource)
        || messageReaderObserved
      );

      const derived = (dataset, reason = "derived_from_messages") =>
        capability(dataset, "degraded", [reason]);
      result.capabilities.datasets = [
        capability("accounts", "supported"),
        capability("contacts", "supported"),
        capability("chats", "supported"),
        (labels || labelItems) ? capability("chat_lists", "degraded", ["partial_model_materialization"])
          : derived("chat_lists", "derived_from_chat_metadata"),
        groupMetadataCollection ? capability("participants", "degraded", ["partial_model_materialization"])
          : derived("participants", "derived_from_chat_metadata"),
        capability("messages", "supported"),
        pins ? capability("message_events", "degraded", ["derived_from_messages", "partial_model_materialization"])
          : derived("message_events"),
        reactions ? capability("reactions", "degraded", ["partial_model_materialization"])
          : derived("reactions"),
        messageInfo ? capability("receipts", "degraded", ["partial_model_materialization"])
          : derived("receipts"),
        derived("poll_votes"),
        derived("group_events"),
        statusV3Collections.length > 0 ? capability("statuses", "supported")
          : derived("statuses", "derived_from_messages"),
        calls ? capability("calls", "supported") : derived("calls"),
        channels ? capability("channels", "supported") : derived("channels", "derived_from_chat_metadata"),
        derived("channel_events"),
        groupMetadataCollection ? capability("communities", "degraded", ["partial_model_materialization"])
          : derived("communities", "derived_from_chat_metadata"),
        groupMetadataCollection ? capability("community_relations", "degraded", ["partial_model_materialization"])
          : derived("community_relations", "derived_from_chat_metadata"),
        presence ? capability("presence_snapshots", "supported")
          : capability("presence_snapshots", "unsupported", ["optional_collection_unavailable"])
      ];

      result.supported = true;
      result.adapterId = ADAPTER_ID;
      result.capabilities.passiveT0 = true;
      result.capabilities.accounts = true;
      result.capabilities.contacts = true;
      result.capabilities.chats = true;
      result.capabilities.messages = true;
      result.capabilities.historyLoading = typeof historyLoader === "function" || dbHistoryReadable;
      result.capabilities.media = mediaReadable;
      result.capabilities.comprehensiveReadonlyV02 =
        result.capabilities.historyLoading || result.capabilities.media;
      result.capabilities.networkActions = result.capabilities.comprehensiveReadonlyV02;
      return {
        result,
        adapter: Object.freeze({
          contacts, chats, messageCollection, historyOwner, historyLoader,
          dbHistoryOwner, dbHistoryLoader: dbHistoryReadable ? dbHistoryLoader : null,
          msgKeyFactory: dbHistoryReadable ? msgKeyFactory : null,
          blobCache, lruMediaStore, profilePictures, calls, statusV3Collections, textStatuses, channels,
          groupMetadataCollection, labels, labelItems, pins, presence, reactions, messageInfo
        })
      };
    } catch (_) {
      result.reasons = ["adapter_probe_failed"];
      return {result, adapter: null};
    }
  }

  function markProbeUnsupported(result, reason) {
    result.supported = false;
    result.adapterId = null;
    result.accountBindingSha256 = null;
    result.reasons = [reason];
    for (const key of [
      "passiveT0", "comprehensiveReadonlyV02", "accounts", "contacts", "chats", "messages",
      "media", "historyLoading", "networkActions", "domWrites"
    ]) {
      result.capabilities[key] = false;
    }
    result.capabilities.datasets = DATASETS.map((dataset) =>
      capability(dataset, "unsupported", ["collection_signature_mismatch"]));
  }

  function observableAccount(adapter) {
    const account = adapter && adapter.contacts && adapter.contacts.getMeContact();
    const nativeId = idString(read(account, "id"));
    if (!account || !nativeId) throw new Error("account_not_observable");
    return {account, nativeId};
  }

  async function sha256Hex(bytes) {
    if (!webCrypto || !webCrypto.subtle || typeof webCrypto.subtle.digest !== "function") {
      throw new Error("crypto_unavailable");
    }
    const digest = new Uint8Array(await webCrypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  async function accountBindingDigest(nativeId) {
    if (!accountBindingSecret.some((value) => value !== 0)) {
      throw new Error("account_binding_secret_unavailable");
    }
    const domain = encoder.encode(ACCOUNT_BINDING_DOMAIN);
    const identity = encoder.encode(nativeId);
    const input = new Uint8Array(domain.length + accountBindingSecret.length + identity.length);
    input.set(domain, 0);
    input.set(accountBindingSecret, domain.length);
    input.set(identity, domain.length + accountBindingSecret.length);
    return sha256Hex(input);
  }

  function decodeHex32(value) {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error("invalid_resume_challenge");
    }
    const output = new Uint8Array(32);
    for (let index = 0; index < output.length; index += 1) {
      output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return output;
  }

  async function resumeBindingDigest(challengeHex, nativeId) {
    const domain = encoder.encode(RESUME_BINDING_DOMAIN);
    const challenge = decodeHex32(challengeHex);
    const identity = encoder.encode(nativeId);
    const input = new Uint8Array(domain.length + challenge.length + identity.length);
    input.set(domain, 0);
    input.set(challenge, domain.length);
    input.set(identity, domain.length + challenge.length);
    return sha256Hex(input);
  }

  async function liveResumeBinding() {
    if (!state.adapter || !state.resumeChallengeHex || !state.resumeBindingSha256) {
      throw new Error("resume_binding_unavailable");
    }
    const observed = await resumeBindingDigest(
      state.resumeChallengeHex,
      observableAccount(state.adapter).nativeId
    );
    if (observed.length !== state.resumeBindingSha256.length) {
      throw new Error("account_identity_changed");
    }
    let difference = 0;
    for (let index = 0; index < observed.length; index += 1) {
      difference |= observed.charCodeAt(index) ^ state.resumeBindingSha256.charCodeAt(index);
    }
    if (difference !== 0) throw new Error("account_identity_changed");
    return observed;
  }

  async function mediaPlanDigest(tasks) {
    const domain = encoder.encode(MEDIA_PLAN_DOMAIN);
    const plan = encoder.encode(JSON.stringify(tasks.map((task) => ({
      assetKey: task.assetKey,
      role: task.role,
      kind: task.kind,
      declaredMime: task.declaredMime,
      originalFileName: task.originalFileName,
      expectedSize: task.expectedSize,
      width: task.width,
      height: task.height,
      durationMs: task.durationMs
    }))));
    const input = new Uint8Array(domain.length + plan.length);
    input.set(domain, 0);
    input.set(plan, domain.length);
    return sha256Hex(input);
  }

  function mediaAssetKey(sourceKind, nativeId, role) {
    return `${sourceKind}:${nativeId}:${role}`;
  }

  function messageMediaTask(model, sourceKind, nativeId, kind) {
    const seconds = numberValue(messageField(model, ["duration", "durationSeconds"]));
    return {
      model,
      assetKey: mediaAssetKey(sourceKind, nativeId, "full"),
      role: "full",
      kind,
      declaredMime: stringValue(messageField(model, ["mimetype", "mimeType"])),
      originalFileName: stringValue(messageField(model, ["filename", "fileName"])),
      expectedSize: unsignedInteger(messageField(model, ["size", "fileSize"])),
      width: unsignedInteger(messageField(model, ["width"])),
      height: unsignedInteger(messageField(model, ["height"])),
      durationMs: seconds === null ? null : Math.max(0, Math.round(seconds * 1000))
    };
  }

  function profilePictureId(model) {
    return idString(first(model, ["id", "__x_id", "wid"]));
  }

  function profilePictureIndex(collection) {
    const output = new Map();
    for (const model of optionalCollectionValues(collection)) {
      const id = profilePictureId(model);
      if (id && !output.has(id)) output.set(id, model);
    }
    return output;
  }

  function profilePictureCandidate(model) {
    return first(model, [
      "blob", "_blob", "__x_blob", "mediaBlob", "fullPreviewData", "previewData"
    ]);
  }

  function allowedProfilePictureUrl(model) {
    const value = stringValue(first(model, [
      "imgFull", "__x_imgFull", "img", "__x_img", "eurl", "__x_eurl", "url"
    ]));
    if (!value || value.length > 8192 || typeof URL !== "function") return null;
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase();
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port
          || !(host === "whatsapp.net" || host.endsWith(".whatsapp.net"))) {
        return null;
      }
      return parsed.href;
    } catch (_) {
      return null;
    }
  }

  function profilePictureHasObservableSource(model) {
    const candidate = profilePictureCandidate(model);
    return candidate instanceof Blob
      || candidate instanceof ArrayBuffer
      || ArrayBuffer.isView(candidate)
      || (typeof candidate === "string" && candidate.startsWith("data:image/"))
      || Boolean(candidate && typeof read(candidate, "forceToBlob") === "function")
      || allowedProfilePictureUrl(model) !== null;
  }

  function avatarMediaTask(model, sourceKind, nativeId) {
    return {
      model,
      assetKey: mediaAssetKey(sourceKind, nativeId, "avatar"),
      role: "avatar",
      kind: "image",
      declaredMime: stringValue(first(model, ["mimetype", "mimeType"])),
      originalFileName: null,
      expectedSize: unsignedInteger(first(model, ["size", "fileSize"])),
      width: unsignedInteger(first(model, ["width", "fullWidth"])),
      height: unsignedInteger(first(model, ["height", "fullHeight"])),
      durationMs: null
    };
  }

  async function liveAccountBinding() {
    if (!state.adapter || !state.accountBindingSha256) throw new Error("account_identity_not_established");
    const observed = await accountBindingDigest(observableAccount(state.adapter).nativeId);
    if (observed.length !== state.accountBindingSha256.length) throw new Error("account_identity_changed");
    let difference = 0;
    for (let index = 0; index < observed.length; index += 1) {
      difference |= observed.charCodeAt(index) ^ state.accountBindingSha256.charCodeAt(index);
    }
    if (difference !== 0) throw new Error("account_identity_changed");
    return observed;
  }

  function accountRecord(model, profileImageAvailable = false) {
    return compact({
      id: idString(read(model, "id")),
      displayName: stringValue(first(model, ["pushname", "pushName", "name"])),
      isBusiness: booleanValue(read(model, "isBusiness")),
      isEnterprise: booleanValue(read(model, "isEnterprise")),
      verifiedName: stringValue(first(model, ["verifiedName", "businessName"])),
      profileImageAvailable
    });
  }

  function materializedTextStatusIndex(collection) {
    const output = new Map();
    for (const statusModel of optionalCollectionValues(collection)) {
      const id = idString(read(statusModel, "id"));
      const status = stringValue(first(statusModel, ["status", "text", "about"]));
      if (id && status !== null) output.set(id, status);
    }
    return output;
  }

  function contactAbout(model, textStatusesById) {
    const materialized = read(model, "status");
    const direct = stringValue(materialized)
      || stringValue(first(materialized, ["status", "text", "about"]));
    if (direct !== null) return direct;
    const id = idString(read(model, "id"));
    return id ? (textStatusesById.get(id) ?? null) : null;
  }

  function contactRecord(model, textStatusesById, profileImageAvailable = false) {
    const verifiedName = stringValue(first(model, ["verifiedName", "businessName"]));
    return compact({
      id: idString(read(model, "id")),
      name: stringValue(read(model, "name")),
      pushName: stringValue(first(model, ["pushname", "pushName"])),
      shortName: stringValue(read(model, "shortName")),
      formattedName: stringValue(read(model, "formattedName")),
      isUser: booleanValue(read(model, "isUser")),
      isGroup: booleanValue(read(model, "isGroup")),
      isWhatsAppContact: booleanValue(first(model, ["isWAContact", "isWhatsappContact"])),
      isBusiness: booleanValue(read(model, "isBusiness")),
      isMyContact: booleanValue(read(model, "isMyContact")),
      isBlocked: booleanValue(read(model, "isBlocked")),
      about: contactAbout(model, textStatusesById),
      verifiedName,
      isVerified: booleanValue(first(model, ["isVerified", "verified"])),
      isDeactivated: booleanValue(first(model, ["isDeactivated", "deactivated"])),
      profileImageAvailable
    });
  }

  function collectionIndexById(collection) {
    const output = new Map();
    for (const model of optionalCollectionValues(collection)) {
      const id = idString(read(model, "id"));
      if (id) output.set(id, model);
    }
    return output;
  }

  function groupMetadata(model, metadataById = null) {
    const embedded = first(model, ["groupMetadata", "metadata"]);
    if (embedded && typeof embedded === "object") return embedded;
    const chatId = idString(read(model, "id"));
    return chatId && metadataById ? metadataById.get(chatId) : null;
  }

  function historyFor(chatId, messageCount) {
    return state.historyStats.get(chatId) || {
      initial: messageCount, final: messageCount, scope: "not_run", rounds: 0,
      returned: 0, added: 0, empty: 0, stagnant: 0, reason: "history_not_requested"
    };
  }

  function idsFromCollection(value) {
    return optionalCollectionValues(value).map((item) => idString(first(item, ["id", "wid"])) || idString(item))
      .filter((item) => typeof item === "string");
  }

  function chatRecord(model, metadata) {
    const chatId = idString(read(model, "id"));
    const messageCount = optionalCollectionValues(read(model, "msgs")).length;
    const observedHistory = historyFor(chatId, messageCount);
    const separateMessageDataset = isChannelId(chatId) || chatId === "status@broadcast";
    const history = separateMessageDataset ? {
      initial: 0, final: 0,
      scope: state.operation === "t0" ? "not_run" : "terminal_observed",
      rounds: observedHistory.rounds, returned: observedHistory.returned, added: 0,
      empty: observedHistory.empty, stagnant: observedHistory.stagnant,
      reason: isChannelId(chatId) ? "channel_events_recorded_separately" : "statuses_recorded_separately"
    } : observedHistory;
    const joinedSubgroups = first(metadata, ["joinedSubgroups", "subgroups"]);
    return compact({
      id: chatId,
      name: stringValue(read(model, "name")),
      isGroup: booleanValue(read(model, "isGroup")),
      isReadOnly: booleanValue(read(model, "isReadOnly")),
      archived: booleanValue(first(model, ["archive", "archived"])),
      pinned: booleanValue(first(model, ["pin", "pinned"])),
      unreadCount: numberValue(read(model, "unreadCount")),
      timestamp: numberValue(first(model, ["t", "timestamp"])),
      muteExpiration: numberValue(read(model, "muteExpiration")),
      lastMessageId: idString(first(model, ["lastReceivedKey", "lastMessageKey"])),
      participantCount: optionalCollectionValues(read(metadata, "participants")).length,
      ephemeralDurationSeconds: unsignedInteger(first(metadata, ["ephemeralDuration", "ephemeralDurationSeconds"])),
      isCommunity: booleanValue(first(metadata, ["isParentGroup", "isCommunity"])),
      parentGroupId: idString(first(metadata, ["parentGroup", "parentGroupId"])),
      defaultSubgroupId: idString(first(metadata, ["defaultSubgroup", "defaultSubgroupId"])),
      joinedSubgroupIds: idsFromCollection(joinedSubgroups),
      initialMessageCount: history.initial,
      finalMessageCount: history.final,
      historyScope: history.scope,
      historyRounds: history.rounds,
      historyReturnedCount: history.returned,
      historyNewCount: history.added,
      historyEmptyRounds: history.empty,
      historyStagnantRounds: history.stagnant,
      historyReasonCode: history.reason
    });
  }

  function participantRole(model) {
    if (read(model, "isSuperAdmin") === true || read(model, "isOwner") === true) return "owner";
    if (read(model, "isAdmin") === true || read(model, "admin") === "admin") return "admin";
    return "member";
  }

  function participantRecord(model, containerId, index, membershipState = null) {
    const subjectId = idString(first(model, ["id", "wid", "contact"]));
    return compact({
      id: `${containerId}:participant:${subjectId || index}`,
      containerId,
      subjectId,
      role: participantRole(model),
      membershipState: membershipState || (read(model, "isRemoved") === true ? "removed" : "active"),
      joinedTimestamp: numberValue(first(model, ["joinTime", "joinedAt", "createdAt"])),
      leftTimestamp: numberValue(first(model, ["leaveTime", "leftAt", "removedAt"]))
    });
  }

  function materializedChatLists(labels, labelItems, chats, favoriteChatIds) {
    const output = [];
    if (favoriteChatIds.length > 0) {
      output.push({
        id: "derived:favorites", listKind: "favorites", name: "Favorites", order: 0,
        chatIds: [...new Set(favoriteChatIds)]
      });
    }
    const observedChatIds = new Set(chats.map((chat) => idString(read(chat, "id"))).filter(Boolean));
    const chatIdsByLabel = new Map();
    const appendAssignment = (labelId, chatId) => {
      if (!labelId || !chatId || !observedChatIds.has(chatId)) return;
      if (!chatIdsByLabel.has(labelId)) chatIdsByLabel.set(labelId, []);
      chatIdsByLabel.get(labelId).push(chatId);
    };
    for (const chat of chats) {
      const chatId = idString(read(chat, "id"));
      if (!chatId) continue;
      for (const labelId of idsFromCollection(read(chat, "labels"))) {
        appendAssignment(labelId, chatId);
      }
    }
    for (const item of optionalCollectionValues(labelItems)) {
      const labelId = idString(first(item, ["labelId", "label"]));
      const chatId = idString(first(item, ["parentId", "chatId", "parent"]));
      appendAssignment(labelId, chatId);
    }
    for (const label of optionalCollectionValues(labels)) {
      const labelId = idString(read(label, "id"));
      const name = stringValue(read(label, "name"));
      if (!labelId || !name) {
        noteOmission("chat_lists_record_without_id_omitted");
        continue;
      }
      output.push({
        id: `label:${labelId}`,
        listKind: "custom",
        name,
        order: output.length,
        chatIds: [...new Set(chatIdsByLabel.get(labelId) || [])]
      });
    }
    return output;
  }

  function normalizeMentions(model) {
    const raw = messageField(model, ["mentionedJidList", "mentionedIds", "mentions"]);
    if (!Array.isArray(raw)) return [];
    return raw.map((value) => idString(first(value, ["id", "wid"])) || idString(value))
      .filter((value) => typeof value === "string");
  }

  function pollOptions(model) {
    const options = messageField(model, ["pollOptions", "options"]);
    if (!Array.isArray(options)) return [];
    return options.map((option) => stringValue(first(option, ["name", "optionName", "text"])) || stringValue(option))
      .filter((value) => typeof value === "string");
  }

  function hasPrefix(bytes, prefix, offset = 0) {
    return bytes.length >= offset + prefix.length
      && prefix.every((value, index) => bytes[offset + index] === value);
  }

  function looksLikeInlineMediaPreview(value) {
    if (typeof value !== "string" || value.length < 32) return false;
    if (/^data:(?:image|video|audio)\/[a-z0-9.+-]+;base64,/i.test(value)
        || /^data:application\/pdf;base64,/i.test(value)) {
      return true;
    }
    const compactPrefix = value.slice(0, 256).replace(/[\t\n\r ]/g, "");
    const encodedLength = compactPrefix.length - (compactPrefix.length % 4);
    if (encodedLength < 16
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(compactPrefix.slice(0, encodedLength))) {
      return false;
    }
    try {
      const decoded = atob(compactPrefix.slice(0, encodedLength));
      const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
      return hasPrefix(bytes, [0xff, 0xd8, 0xff])
        || hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        || hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38])
        || hasPrefix(bytes, [0x1a, 0x45, 0xdf, 0xa3])
        || hasPrefix(bytes, [0x4f, 0x67, 0x67, 0x53])
        || hasPrefix(bytes, [0x49, 0x44, 0x33])
        || hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46])
        || hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04])
        || (hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46])
          && (hasPrefix(bytes, [0x57, 0x45, 0x42, 0x50], 8)
            || hasPrefix(bytes, [0x57, 0x41, 0x56, 0x45], 8)))
        || hasPrefix(bytes, [0x66, 0x74, 0x79, 0x70], 4);
    } catch (_) {
      return false;
    }
  }

  function messageBodyObservation(model) {
    const body = stringValue(messageField(model, ["body", "__x_body", "text"]));
    if (body !== null && mediaKind(model) && looksLikeInlineMediaPreview(body)) {
      noteOmission("media_inline_preview_omitted");
      return {body: null, reasonCodes: ["media_inline_preview_omitted"]};
    }
    return {body, reasonCodes: []};
  }

  function messageStanzaId(model) {
    const key = messageKeyObject(model);
    const value = first(key, ["id", "messageId", "stanzaId"]);
    let stanza = null;
    if (typeof value === "string" || typeof value === "number") {
      stanza = String(value);
    } else {
      const serialized = idString(key);
      const match = typeof serialized === "string"
        ? /^(?:true|false)_[^_]+_(.+)$/.exec(serialized) : null;
      if (match) stanza = match[1];
    }
    if (stanza === null) return null;
    return stanza.length > 0 && stanza.length <= 512 ? stanza : null;
  }

  function messageReferenceLookupKey(chatId, stanzaId) {
    return `${chatId}\u0000${stanzaId}`;
  }

  function buildMessageReferenceIndex(entries) {
    const index = new Map();
    for (const {model, chatId} of entries) {
      const stanzaId = messageStanzaId(model);
      const nativeId = messageNativeId(model, chatId);
      if (stanzaId && nativeId) {
        index.set(messageReferenceLookupKey(chatId, stanzaId), nativeId);
      }
    }
    return index;
  }

  function quotedMessageNativeId(model, fallbackChatId) {
    const materialized = messageField(model, [
      "quotedMsg", "_quotedMsgObj", "quotedMessage", "quotedMsgId", "quotedMsgKey"
    ]);
    const materializedId = messageNativeId(materialized, fallbackChatId);
    if (materializedId) return materializedId;
    const stanzaValue = messageField(model, ["quotedStanzaID", "quotedStanzaId"]);
    if (typeof stanzaValue !== "string" && typeof stanzaValue !== "number") return null;
    const stanzaId = String(stanzaValue);
    if (stanzaId.length === 0 || stanzaId.length > 480) {
      noteOmission("message_quote_reference_unavailable_omitted");
      return null;
    }
    const remoteId = idString(messageField(model, ["quotedRemoteJid", "quotedRemote", "quotedChatId"]))
      || fallbackChatId;
    if (!remoteId) return null;
    const resolved = state.messageReferenceIndex.get(messageReferenceLookupKey(remoteId, stanzaId));
    if (resolved) return resolved;
    return `unresolved_quote:${stanzaId}`;
  }

  function messageRecord(model, fallbackChatId) {
    const location = messageField(model, ["location", "loc"]);
    const poll = messageField(model, ["pollCreation", "poll"]);
    const event = messageField(model, ["event", "eventData"]);
    const mediaData = messageField(model, ["mediaData"]);
    const mediaObject = messageField(model, ["mediaObject"]);
    const sender = messageField(model, ["senderObj", "sender"]);
    const key = messageKeyObject(model);
    const fromMe = booleanValue(messageField(model, ["isSentByMe", "fromMe"]))
      ?? booleanValue(read(key, "fromMe"));
    const observableFields = messageHasObservableFields(model);
    const edited = messageField(model, ["isEdited", "edited"]);
    const revoked = messageField(model, ["isRevoked", "revoked"]);
    const nativeType = messageField(model, ["type", "__x_type"]);
    const bodyObservation = messageBodyObservation(model);
    const unsupportedReasonCodes = observableFields ? [] : ["message_model_fields_unavailable"];
    unsupportedReasonCodes.push(...bodyObservation.reasonCodes);
    return compact({
      id: messageNativeId(model, fallbackChatId),
      chatId: messageChatId(model, fallbackChatId),
      senderId: idString(first(sender, ["id", "wid"])) || idString(sender)
        || idString(messageField(model, ["from"])),
      authorId: idString(messageField(model, ["author", "participant"])),
      recipientId: idString(messageField(model, ["to", "recipient", "recipientId"])),
      timestamp: numberValue(messageField(model, ["t", "timestamp", "__x_t"])),
      type: stringValue(messageField(model, ["type", "__x_type"])),
      subtype: stringValue(messageField(model, ["subtype", "__x_subtype"])),
      body: bodyObservation.body,
      caption: stringValue(messageField(model, ["caption", "__x_caption"])),
      fromMe,
      isStarred: booleanValue(messageField(model, ["star", "isStarred"])),
      isForwarded: booleanValue(messageField(model, ["isForwarded", "forwarded"])),
      isViewOnce: booleanValue(messageField(model, ["isViewOnce", "viewOnce"])),
      isEdited: booleanValue(edited) ?? booleanValue(Boolean(
        messageField(model, ["latestEditMsgKey", "latestEditMessageKey"])
      )),
      isRevoked: booleanValue(
        revoked === true || nativeType === "revoked"
        || Boolean(messageField(model, ["asRevoked"]))
      ),
      hasMedia: booleanValue(Boolean(mediaData || mediaObject || mediaKind(model))),
      acknowledgement: numberValue(messageField(model, ["ack", "acknowledgement"])),
      quotedMessageId: quotedMessageNativeId(model, fallbackChatId),
      mediaMimeType: stringValue(messageField(model, ["mimetype", "mimeType"])),
      mediaSize: numberValue(messageField(model, ["size", "fileSize"])),
      mediaFileName: stringValue(messageField(model, ["filename", "fileName"])),
      mediaWidth: numberValue(messageField(model, ["width"])),
      mediaHeight: numberValue(messageField(model, ["height"])),
      mediaDurationSeconds: numberValue(messageField(model, ["duration", "durationSeconds"])),
      mentionIds: normalizeMentions(model),
      isEphemeral: booleanValue(messageField(model, ["isEphemeral", "ephemeral"])),
      latitude: numberValue(first(location, ["lat", "latitude"]))
        ?? numberValue(messageField(model, ["lat", "latitude"])),
      longitude: numberValue(first(location, ["lng", "longitude"]))
        ?? numberValue(messageField(model, ["lng", "longitude"])),
      locationName: stringValue(first(location, ["name", "description"]))
        || stringValue(location),
      locationAddress: stringValue(read(location, "address")),
      pollName: stringValue(first(poll, ["name", "pollName"]))
        || stringValue(messageField(model, ["pollName"])),
      pollOptions: pollOptions(poll || model),
      pollSelectableCount: unsignedInteger(first(poll, [
        "selectableOptionsCount", "selectableCount", "pollSelectableOptionsCount"
      ])) ?? unsignedInteger(messageField(model, ["pollSelectableOptionsCount"])),
      pollClosed: booleanValue(first(poll, ["closed", "isClosed"])),
      eventName: stringValue(first(event, ["name", "title"])),
      eventDescription: stringValue(read(event, "description")),
      eventStartTimestamp: numberValue(first(event, ["startTime", "startsAt", "timestamp"])),
      eventCanceled: booleanValue(first(event, ["canceled", "isCanceled"])),
      unsupportedReasonCodes
    });
  }

  function eventRecord(id, eventKind, nativeType, subjectIds, actorIds, timestamp, extras = {}) {
    return compact({id, eventKind, nativeType, subjectIds, actorIds, timestamp, ...extras});
  }

  function entityRecord(model, kind, explicitMetadata = null) {
    const id = idString(read(model, "id"));
    const metadata = explicitMetadata || first(model, ["newsletterMetadata", "metadata"]);
    const metadataValue = (keys) => first(metadata, keys) ?? first(model, keys);
    const newsletterName = read(read(metadata, "newsletterNameMetadataMixin"), "nameElementValue");
    const newsletterDescription = read(
      read(read(metadata, "newsletterDescriptionMetadataMixin"), "descriptionQueryDescriptionResponseMixin"),
      "elementValue"
    );
    const newsletterState = read(read(metadata, "newsletterStateMetadataMixin"), "stateType");
    const newsletterCreation = read(read(metadata, "newsletterCreationTimeMetadataMixin"), "creationTimeValue");
    const nestedName = first(read(metadata, "name"), ["text", "value"]);
    const nestedDescription = first(read(metadata, "description"), ["text", "value"]);
    return compact({
      id,
      entityKind: kind,
      displayName: stringValue(metadataValue(["name", "subject", "title"]))
        || stringValue(nestedName) || stringValue(newsletterName),
      description: stringValue(metadataValue(["description", "desc", "about"]))
        || stringValue(nestedDescription) || stringValue(newsletterDescription),
      membershipState: stringValue(metadataValue(["membershipState", "subscribedState", "state"]))
        || stringValue(newsletterState),
      verified: booleanValue(metadataValue(["isVerified", "verified"])),
      readOnly: booleanValue(read(model, "isReadOnly")),
      unreadCount: numberValue(read(model, "unreadCount")),
      creationTimestamp: numberValue(metadataValue(["creation", "createdAt", "timestamp"]))
        ?? numberValue(newsletterCreation)
    });
  }

  function callState(call) {
    const direct = first(call, ["state", "callState"]);
    if (typeof direct === "string" || typeof direct === "number") return String(direct);
    const getState = read(call, "getState");
    if (typeof getState !== "function") return "call";
    try {
      const observed = getState.call(call);
      return typeof observed === "string" || typeof observed === "number"
        ? String(observed) : "call";
    } catch (_) {
      return "call";
    }
  }

  function callParticipantIds(call) {
    return [...new Set(optionalCollectionValues(first(call, ["groupCallParticipants", "participants"]))
      .map((participant) => idString(first(participant, ["id", "wid", "jid", "participant"]))
        || idString(participant))
      .filter((id) => typeof id === "string"))];
  }

  function materializedPresenceRecords(collection) {
    const output = [];
    const observedAt = Date.now();
    for (const presence of optionalCollectionValues(collection)) {
      const subject = idString(first(presence, ["id", "wid", "chatId"]));
      if (!subject) {
        noteOmission("presence_snapshots_record_without_id_omitted");
        continue;
      }
      const directState = stringValue(first(presence, ["state", "presence", "type"]));
      const online = booleanValue(read(presence, "isOnline"));
      output.push(eventRecord(`${subject}:presence:${observedAt}`, "presence_snapshot", "presence",
        [subject], [], observedAt, {state: directState || (online === null ? null : (online ? "online" : "offline"))}));
      optionalCollectionValues(first(presence, ["chatstates", "chatStates"])).forEach((chatstate, index) => {
        const chatstateSubject = idString(first(chatstate, ["id", "wid", "contact"])) || subject;
        const stateValue = first(chatstate, ["type", "state", "presence"]);
        const stateText = typeof stateValue === "string" || typeof stateValue === "number"
          ? String(stateValue) : null;
        const timestamp = numberValue(first(chatstate, ["t", "timestamp", "updateTime"]));
        output.push(eventRecord(
          `${chatstateSubject}:chatstate:${stateText || "unknown"}:${timestamp ?? index}`,
          "presence_snapshot", "chatstate", [chatstateSubject], [], timestamp ?? observedAt,
          {state: stateText}
        ));
      });
    }
    return output;
  }

  function isChannelId(id) {
    return typeof id === "string" && id.endsWith("@newsletter");
  }

  function isStatusMessage(model, chatId) {
    return messageField(model, ["isStatusV3", "isStatus"]) === true
      || chatId === "status@broadcast";
  }

  function mediaKind(model) {
    const type = stringValue(messageField(model, ["type", "__x_type"])) || "";
    if (type === "image") return "image";
    if (type === "video" || type === "gif") return "video";
    if (type === "ptt") return "voice";
    if (type === "audio") return "audio";
    if (type === "document") return "document";
    if (type === "sticker") return "sticker";
    if (type === "vcard" || type === "multi_vcard") return "contact_card";
    return messageField(model, ["mediaData", "mediaObject"]) ? "other" : null;
  }

  function messageQueryKey(model, fallbackChatId) {
    for (const view of messageModelViews(model)) {
      const directSerialized = idString(view);
      if (typeof directSerialized === "string"
          && /^(?:true|false)_.+_.+$/.test(directSerialized)) {
        return directSerialized;
      }
      for (const key of ["id", "key", "msgKey", "messageKey", "__x_id", "__x_key"]) {
        const value = read(view, key);
        const serialized = idString(value);
        if (typeof serialized === "string" && /^(?:true|false)_.+_.+$/.test(serialized)) {
          return serialized;
        }
        if (!value || typeof value !== "object") continue;
        const nativeId = first(value, ["id", "messageId", "stanzaId"]);
        const remote = idString(first(value, ["remote", "remoteJid", "chatId"])) || fallbackChatId;
        const fromMe = booleanValue(read(value, "fromMe"));
        if ((typeof nativeId === "string" || typeof nativeId === "number")
            && typeof remote === "string" && fromMe !== null) {
          return `${fromMe ? "true" : "false"}_${remote}_${String(nativeId)}`;
        }
      }
    }
    return null;
  }

  function chatLastMessageKey(chat) {
    const chatId = idString(read(chat, "id"));
    for (const candidate of [
      first(chat, ["lastReceivedKey", "lastMessageKey"]),
      first(read(chat, "lastMessage"), ["id", "key", "msgKey"]),
      read(chat, "lastMessage")
    ]) {
      const serialized = idString(candidate);
      if (serialized) return serialized;
      const fromModel = messageQueryKey(candidate, chatId);
      if (fromModel) return fromModel;
    }
    return null;
  }

  function chatExpectsMessages(chat) {
    return chatLastMessageKey(chat) !== null;
  }

  function buildGlobalMessageIndex(adapter) {
    const index = new Map();
    for (const message of optionalCollectionValues(adapter.messageCollection)) {
      const chatId = messageChatId(message, null);
      if (!chatId) continue;
      if (!index.has(chatId)) index.set(chatId, new Map());
      mergeMessageModels(index.get(chatId), [message], chatId);
    }
    return index;
  }

  function mergeGlobalMessages(target, chatId) {
    const indexed = state.globalMessagesByChat.get(chatId);
    if (!indexed) return 0;
    return mergeMessageModels(target, indexed.values(), chatId);
  }

  function oldestHistoryAnchor(chat, messageMap) {
    const chatId = idString(read(chat, "id"));
    let selected = null;
    let selectedTimestamp = Number.POSITIVE_INFINITY;
    for (const message of messageMap.values()) {
      const queryKey = messageQueryKey(message, chatId);
      if (!queryKey) continue;
      const timestamp = numberValue(messageField(message, ["t", "timestamp", "__x_t"]));
      if (selected === null || (timestamp !== null && timestamp < selectedTimestamp)) {
        selected = queryKey;
        selectedTimestamp = timestamp === null ? selectedTimestamp : timestamp;
      }
    }
    return selected || chatLastMessageKey(chat);
  }

  async function loadEarlierFromLocalDb(chat, messageMap) {
    const adapter = state.adapter;
    if (!adapter || typeof adapter.dbHistoryLoader !== "function"
        || typeof read(adapter.msgKeyFactory, "fromString") !== "function") {
      return {available: false, recognized: false, messages: []};
    }
    const anchorString = oldestHistoryAnchor(chat, messageMap);
    if (!anchorString) {
      return {available: true, recognized: false, messages: []};
    }
    const anchor = adapter.msgKeyFactory.fromString(anchorString);
    const result = await withTimeout(adapter.dbHistoryLoader.call(adapter.dbHistoryOwner, {
      anchor, count: HISTORY_DB_BATCH_SIZE, direction: "before"
    }), HISTORY_TIMEOUT_MS);
    const normalized = normalizeLoadedMessages(result);
    return {available: true, recognized: normalized.recognized, messages: normalized.messages};
  }

  function mergeMessageModels(target, messages, fallbackChatId) {
    let added = 0;
    for (const message of messages) {
      const id = messageNativeId(message, fallbackChatId);
      if (!id) {
        noteOmission("message_native_id_unavailable_omitted");
        continue;
      }
      if (!target.has(id)) added += 1;
      target.set(id, message);
    }
    return added;
  }

  function noteOmission(reasonCode) {
    state.omissionCounts.set(reasonCode, (state.omissionCounts.get(reasonCode) || 0) + 1);
  }

  function recordsWithStableIds(dataset, records) {
    return records.filter((record) => {
      if (record && typeof record.id === "string" && record.id.length > 0) return true;
      noteOmission(`${dataset}_record_without_id_omitted`);
      return false;
    });
  }

  function conversationMessageMap(chat) {
    const chatId = idString(read(chat, "id"));
    if (!chatId) throw new Error("chat_id_unavailable");
    const observed = state.historyMessages.get(chatId);
    if (observed) {
      mergeMessageModels(observed, optionalCollectionValues(read(chat, "msgs")), chatId);
      mergeGlobalMessages(observed, chatId);
      return observed;
    }
    const created = new Map();
    mergeMessageModels(created, optionalCollectionValues(read(chat, "msgs")), chatId);
    mergeGlobalMessages(created, chatId);
    return created;
  }

  function observableConversations(adapter) {
    return combinedCollectionValues([adapter.chats, adapter.channels]).filter((chat) => {
      const chatId = idString(read(chat, "id"));
      return Boolean(chatId && (
        supportsCollection(read(chat, "msgs"))
        || state.globalMessagesByChat.has(chatId)
        || typeof adapter.historyLoader === "function"
        || typeof adapter.dbHistoryLoader === "function"
      ));
    });
  }

  function messageEntries(chats) {
    const entries = [];
    const seen = new Set();
    for (const chat of chats) {
      const chatId = idString(read(chat, "id"));
      // Some WhatsApp builds materialise messages only in the global message
      // collection while the corresponding Chat model has no `msgs` member.
      // `observableConversations()` already treats that as an observable
      // conversation, so do not discard it again here. The helper below
      // safely merges an absent chat collection with the global/history maps.
      for (const message of conversationMessageMap(chat).values()) {
        const id = messageNativeId(message, chatId);
        if (!id) {
          noteOmission("message_native_id_unavailable_omitted");
          continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        entries.push({model: message, chatId});
      }
    }
    return entries;
  }

  function appendGlobalSpecialMessageEntries(entries) {
    const seen = new Set(entries.map(({model, chatId}) => messageNativeId(model, chatId)).filter(Boolean));
    const processedContainers = new Set(entries.map(({chatId}) => chatId));
    for (const [chatId, messages] of state.globalMessagesByChat) {
      const special = chatId === "status@broadcast" || isChannelId(chatId);
      if (!special) {
        if (!processedContainers.has(chatId) && messages.size > 0) {
          noteOmission("global_message_container_unobservable_omitted");
        }
        continue;
      }
      for (const model of messages.values()) {
        const id = messageNativeId(model, chatId);
        if (!id) {
          noteOmission("message_native_id_unavailable_omitted");
          continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        entries.push({model, chatId});
      }
    }
  }

  function derivedEvents(entries) {
    const output = {
      message_events: [], reactions: [], receipts: [], poll_votes: [], group_events: [], calls: []
    };
    for (const {model, chatId} of entries) {
      const id = messageNativeId(model, chatId);
      const timestamp = numberValue(messageField(model, ["t", "timestamp", "__x_t"]));
      const sender = messageField(model, ["senderObj", "sender"]);
      const actor = idString(messageField(model, ["author", "participant"]))
        || idString(first(sender, ["id", "wid"])) || idString(sender)
        || idString(messageField(model, ["from"]));
      const type = stringValue(messageField(model, ["type", "__x_type"])) || "unknown";
      if (isStatusMessage(model, chatId) || isChannelId(chatId)) {
        continue;
      }
      if (messageField(model, ["isEdited", "edited"]) === true
          || messageField(model, ["latestEditMsgKey", "latestEditMessageKey"])) {
        output.message_events.push(eventRecord(`${id}:edited`, "message_edited", type, [id], actor ? [actor] : [], timestamp));
      }
      if (messageField(model, ["isRevoked", "revoked"]) === true || type === "revoked"
          || messageField(model, ["asRevoked"])) {
        output.message_events.push(eventRecord(`${id}:revoked`, "message_revoked", type, [id], actor ? [actor] : [], timestamp));
      }
      if (["protocol", "gp2"].includes(type)) {
        output.message_events.push(eventRecord(`${id}:protocol`, "protocol_event", type, [id], actor ? [actor] : [], timestamp));
        output.group_events.push(eventRecord(`${id}:group`, "group_event", type, [chatId], actor ? [actor] : [], timestamp, {
          state: stringValue(messageField(model, ["subtype", "__x_subtype"]))
        }));
      }
      const acknowledgement = numberValue(messageField(model, ["ack", "acknowledgement"]));
      if (acknowledgement !== null) {
        output.receipts.push(eventRecord(`${id}:ack:${acknowledgement}`, "message_receipt", "ack", [id], [], timestamp, {
          numericValue: acknowledgement
        }));
      }
      const reactions = optionalCollectionValues(messageField(model, ["reactions", "reactionCollection"]));
      reactions.forEach((reaction, index) => {
        const reactionId = idString(read(reaction, "id")) || `${id}:reaction:${index}`;
        const reactionActor = idString(first(reaction, ["senderUserJid", "sender", "author"]));
        output.reactions.push(eventRecord(reactionId, "reaction", "reaction", [id], reactionActor ? [reactionActor] : [],
          numberValue(first(reaction, ["timestamp", "t"])), {marker: stringValue(first(reaction, ["text", "emoji"]))}));
      });
      if (type === "poll_update") {
        const pollParentId = messageNativeId(messageField(model, [
          "parentMsgKey", "pollCreationMessageKey", "pollUpdateParentKey"
        ]), chatId);
        output.poll_votes.push(eventRecord(`${id}:vote`, "poll_vote", type,
          pollParentId ? [pollParentId] : [],
          actor ? [actor] : [], timestamp, {
            option: stringValue(messageField(model, ["selectedOption", "optionName"]))
          }));
      }
      if (type === "call_log") {
        output.calls.push(eventRecord(`${id}:call`, "call", type, [chatId], actor ? [actor] : [], timestamp, {
          isVideo: booleanValue(messageField(model, ["isVideo"])),
          isGroup: booleanValue(messageField(model, ["isGroup"])),
          outgoing: booleanValue(read(messageKeyObject(model), "fromMe")),
          state: stringValue(messageField(model, ["callResult", "subtype"]))
        }));
      }
    }
    return output;
  }

  function appendMaterializedReactions(output, collection) {
    const seen = new Set(output.map((record) => record.id));
    let fallbackIndex = 0;
    const appendSender = (sender, aggregateMarker) => {
      if (!sender || typeof sender !== "object") return;
      const parentId = messageNativeId(first(sender, [
        "parentMsgKey", "reactionParentKey", "parentMessageKey"
      ]), null);
      if (!parentId) {
        noteOmission("reactions_record_without_id_omitted");
        return;
      }
      const actorId = idString(first(sender, ["senderUserJid", "sender", "author"]));
      const timestamp = numberValue(first(sender, ["timestamp", "t"]));
      const marker = stringValue(first(sender, ["reactionText", "text", "emoji"]))
        || aggregateMarker;
      const nativeReactionId = messageNativeId(first(sender, ["msgKey", "id"]), null);
      const eventId = nativeReactionId
        || `${parentId}:reaction:${actorId || "unknown"}:${timestamp ?? fallbackIndex}`;
      fallbackIndex += 1;
      if (seen.has(eventId)) return;
      seen.add(eventId);
      output.push(eventRecord(eventId, "reaction", "reaction", [parentId],
        actorId ? [actorId] : [], timestamp, {marker}));
    };

    for (const root of optionalCollectionValues(collection)) {
      if (first(root, ["parentMsgKey", "reactionParentKey", "parentMessageKey"])) {
        appendSender(root, null);
      }
      const reactionByMe = read(root, "reactionByMe");
      if (reactionByMe) appendSender(reactionByMe, null);
      for (const aggregate of optionalCollectionValues(read(root, "reactions"))) {
        const aggregateMarker = stringValue(first(aggregate, [
          "aggregateEmoji", "reactionText", "text", "emoji"
        ]));
        const senders = optionalCollectionValues(first(aggregate, ["senders", "reactions"]));
        if (senders.length === 0) appendSender(aggregate, aggregateMarker);
        else senders.forEach((sender) => appendSender(sender, aggregateMarker));
      }
    }
  }

  function appendMaterializedReceipts(output, collection) {
    const seen = new Set(output.map((record) => record.id));
    for (const info of optionalCollectionValues(collection)) {
      const messageId = messageNativeId(read(info, "id"), null);
      if (!messageId) {
        noteOmission("receipts_record_without_id_omitted");
        continue;
      }
      for (const [field, stateName] of [
        ["delivery", "delivered"], ["read", "read"], ["played", "played"]
      ]) {
        optionalCollectionValues(read(info, field)).forEach((participant, index) => {
          const actorId = idString(first(participant, ["id", "wid", "contact"]));
          const timestamp = numberValue(first(participant, ["t", "timestamp"]));
          const eventId = `${messageId}:receipt:${stateName}:${actorId || index}:${timestamp ?? 0}`;
          if (seen.has(eventId)) return;
          seen.add(eventId);
          output.push(eventRecord(eventId, "message_receipt", stateName, [messageId],
            actorId ? [actorId] : [], timestamp, {state: stateName}));
        });
      }
    }
  }

  function appendMaterializedPins(output, collection, observableMessageIds) {
    const seen = new Set(output.map((record) => record.id));
    for (const pin of optionalCollectionValues(collection)) {
      const chatId = idString(read(pin, "chatId"));
      const parentId = messageNativeId(first(pin, ["parentMsgKey", "msgKey"]), chatId);
      if (!parentId || !observableMessageIds.has(parentId)) {
        noteOmission("message_pin_parent_unobservable_omitted");
        continue;
      }
      const nativeId = messageNativeId(read(pin, "id"), chatId);
      const timestamp = numberValue(first(pin, ["senderTimestampMs", "t", "timestamp"]));
      const eventId = nativeId || `${parentId}:pin:${timestamp ?? 0}`;
      if (seen.has(eventId)) continue;
      seen.add(eventId);
      const actorId = idString(first(pin, ["sender", "author", "participant"]));
      const nativePinType = first(pin, ["pinType", "type"]);
      output.push(eventRecord(eventId, "message_pin_observed", "pin_in_chat", [parentId],
        actorId ? [actorId] : [], timestamp, {
          state: typeof nativePinType === "string" || typeof nativePinType === "number"
            ? String(nativePinType) : null
        }));
    }
  }

  function makeSnapshot(adapter) {
    const contacts = collectionValues(adapter.contacts);
    const chats = collectionValues(adapter.chats).filter((chat) => {
      if (idString(read(chat, "id"))) return true;
      noteOmission("chats_record_without_id_omitted");
      return false;
    });
    const conversations = state.historyChats || observableConversations(adapter);
    const metadataById = collectionIndexById(adapter.groupMetadataCollection);
    const textStatusesById = materializedTextStatusIndex(adapter.textStatuses);
    const profilePicturesById = profilePictureIndex(adapter.profilePictures);
    const {account} = observableAccount(adapter);
    const accountId = idString(read(account, "id"));
    const accountProfilePicture = accountId ? profilePicturesById.get(accountId) : null;
    const entries = messageEntries(conversations);
    appendGlobalSpecialMessageEntries(entries);
    state.messageReferenceIndex = buildMessageReferenceIndex(entries);
    for (const chat of chats) {
      const chatId = idString(read(chat, "id"));
      if (!chatId || chatId === "status@broadcast" || isChannelId(chatId)) continue;
      if (chatExpectsMessages(chat) && conversationMessageMap(chat).size === 0) {
        noteOmission("chat_expected_messages_unobservable_omitted");
      }
    }
    const ordinaryMessages = [];
    const statuses = [];
    const channelEvents = [];
    const mediaTasks = new Map();
    for (const entry of entries) {
      const record = messageRecord(entry.model, entry.chatId);
      let sourceKind = "message";
      if (isStatusMessage(entry.model, entry.chatId)) {
        statuses.push(record);
        sourceKind = "status";
      } else if (isChannelId(entry.chatId)) {
        channelEvents.push(record);
        sourceKind = "channel_event";
      } else {
        ordinaryMessages.push(record);
      }
      const kind = mediaKind(entry.model);
      if (kind) {
        const task = messageMediaTask(entry.model, sourceKind, record.id, kind);
        mediaTasks.set(task.assetKey, task);
      }
    }

    const participantRecords = new Map();
    const communities = [];
    const relations = [];
    const channelEntities = new Map();
    const favoriteChatIds = [];
    chats.forEach((chat, chatIndex) => {
      const chatId = idString(read(chat, "id"));
      if (read(chat, "isFavorite") === true || read(chat, "favorite") === true) favoriteChatIds.push(chatId);
      const metadata = groupMetadata(chat, metadataById);
      optionalCollectionValues(read(metadata, "participants")).forEach((participant, index) => {
        const record = participantRecord(participant, chatId, index);
        if (record.subjectId) participantRecords.set(record.id, record);
      });
      optionalCollectionValues(read(metadata, "pastParticipants")).forEach((participant, index) => {
        const record = participantRecord(participant, chatId, index, "removed");
        if (record.subjectId && !participantRecords.has(record.id)) {
          participantRecords.set(record.id, record);
        }
      });
      if (isChannelId(chatId)) channelEntities.set(chatId, entityRecord(chat, "channel"));
      if (read(metadata, "isParentGroup") === true || read(chat, "isCommunity") === true) {
        communities.push(entityRecord(chat, "community", metadata));
      }
      const parentId = idString(first(metadata, ["parentGroup", "parentGroupId"]));
      if (parentId) {
        relations.push({id: `${chatId}:parent:${parentId}`, relationKind: "community_parent", fromId: chatId, toId: parentId});
      }
      const defaultId = idString(first(metadata, ["defaultSubgroup", "defaultSubgroupId"]));
      if (defaultId) {
        relations.push({id: `${chatId}:announcement:${defaultId}`, relationKind: "community_announcement_group", fromId: chatId, toId: defaultId});
      }
      idsFromCollection(first(metadata, ["joinedSubgroups", "subgroups"])).forEach((childId) => {
        relations.push({id: `${chatId}:child:${childId}`, relationKind: "community_child_group", fromId: chatId, toId: childId});
      });
      void chatIndex;
    });

    optionalCollectionValues(adapter.channels).forEach((channel) => {
      const record = entityRecord(channel, "channel");
      if (record.id) channelEntities.set(record.id, record);
    });
    channelEvents.forEach((record) => {
      const channelId = record.chatId;
      if (channelId && !channelEntities.has(channelId)) {
        channelEntities.set(channelId, entityRecord({id: channelId}, "channel"));
      }
    });
    const derived = derivedEvents(entries);
    appendMaterializedReactions(derived.reactions, adapter.reactions);
    appendMaterializedReceipts(derived.receipts, adapter.messageInfo);
    appendMaterializedPins(derived.message_events, adapter.pins,
      new Set(entries.map(({model, chatId}) => messageNativeId(model, chatId)).filter(Boolean)));
    optionalCollectionValues(adapter.calls).forEach((call, index) => {
      const id = idString(read(call, "id")) || `call:${index}`;
      const peer = idString(first(call, ["peerJid", "peer", "chatId"]));
      const observedState = callState(call);
      const callInfo = read(call, "callInfo");
      derived.calls.push(eventRecord(id, "call", observedState,
        peer ? [peer] : [], callParticipantIds(call),
        numberValue(first(call, ["offerTime", "timestamp", "t"])), {
          state: observedState, isVideo: booleanValue(read(call, "isVideo")),
          isGroup: booleanValue(read(call, "isGroup")), outgoing: booleanValue(read(call, "outgoing")),
          numericValue: numberValue(first(call, ["duration", "durationSeconds"]))
            ?? numberValue(first(callInfo, ["duration", "durationSeconds"]))
        }));
    });
    const statusRecords = new Map(statuses.map((record) => [record.id, record]));
    combinedCollectionValues(adapter.statusV3Collections).forEach((status) => {
      const messages = optionalCollectionValues(first(status, ["msgs", "messages"]));
      messages.forEach((message) => {
        const record = messageRecord(message, "status@broadcast");
        if (!record.id) {
          noteOmission("status_message_native_id_unavailable_omitted");
          return;
        }
        statusRecords.set(record.id, record);
        const kind = mediaKind(message);
        if (kind) {
          const task = messageMediaTask(message, "status", record.id, kind);
          mediaTasks.set(task.assetKey, task);
        }
      });
    });
    if (accountProfilePicture && accountId) {
      const task = avatarMediaTask(accountProfilePicture, "account", accountId);
      mediaTasks.set(task.assetKey, task);
    }
    const contactRecords = contacts.map((contact) => {
      const contactId = idString(read(contact, "id"));
      const profilePicture = contactId && contactId !== accountId
        ? profilePicturesById.get(contactId) : null;
      if (profilePicture && contactId) {
        const task = avatarMediaTask(profilePicture, "contact", contactId);
        mediaTasks.set(task.assetKey, task);
      }
      return contactRecord(contact, textStatusesById, Boolean(profilePicture));
    });
    const presenceRecords = materializedPresenceRecords(adapter.presence);
    const chatLists = materializedChatLists(adapter.labels, adapter.labelItems, chats, favoriteChatIds);
    const chatRecords = chats.map((chat) => chatRecord(chat, groupMetadata(chat, metadataById)));
    if (statusRecords.size > 0 && !chatRecords.some((record) => record.id === "status@broadcast")) {
      chatRecords.push({
        id: "status@broadcast", name: "Status", isGroup: false, isReadOnly: true,
        archived: false, pinned: false, unreadCount: 0, timestamp: null, muteExpiration: null,
        lastMessageId: null, participantCount: 0, ephemeralDurationSeconds: null,
        isCommunity: false, parentGroupId: null, defaultSubgroupId: null, joinedSubgroupIds: [],
        initialMessageCount: 0, finalMessageCount: 0,
        historyScope: state.operation === "t0" ? "not_run" : "terminal_observed",
        historyRounds: 0, historyReturnedCount: 0, historyNewCount: 0,
        historyEmptyRounds: 0, historyStagnantRounds: 0,
        historyReasonCode: "statuses_recorded_separately"
      });
    }
    const datasets = [
      {dataset: "accounts", records: [accountRecord(account, Boolean(accountProfilePicture))], cursor: 0},
      {dataset: "contacts", records: contactRecords, cursor: 0},
      {dataset: "chats", records: chatRecords, cursor: 0},
      {dataset: "chat_lists", records: chatLists, cursor: 0},
      {dataset: "participants", records: [...participantRecords.values()], cursor: 0},
      {dataset: "messages", records: ordinaryMessages, cursor: 0},
      {dataset: "message_events", records: derived.message_events, cursor: 0},
      {dataset: "reactions", records: derived.reactions, cursor: 0},
      {dataset: "receipts", records: derived.receipts, cursor: 0},
      {dataset: "poll_votes", records: derived.poll_votes, cursor: 0},
      {dataset: "group_events", records: derived.group_events, cursor: 0},
      {dataset: "statuses", records: [...statusRecords.values()], cursor: 0},
      {dataset: "calls", records: derived.calls, cursor: 0},
      {dataset: "channels", records: [...channelEntities.values()], cursor: 0},
      {dataset: "channel_events", records: channelEvents, cursor: 0},
      {dataset: "communities", records: communities, cursor: 0},
      {dataset: "community_relations", records: relations, cursor: 0},
      {dataset: "presence_snapshots", records: presenceRecords, cursor: 0}
    ].map((dataset) => ({
      ...dataset,
      records: recordsWithStableIds(dataset.dataset, dataset.records)
    }));
    return {
      datasets,
      mediaTasks: [...mediaTasks.values()].sort((left, right) =>
        left.assetKey.localeCompare(right.assetKey))
    };
  }

  const MEDIA_TOTAL_KEYS = Object.freeze([
    "requested", "available", "missing", "expired", "decryptError",
    "downloadTimeout", "noProgressTimeout", "tooLarge", "diskSpaceInsufficient",
    "hashMismatch", "transportInterrupted", "canceled", "unavailable", "notAttempted"
  ]);

  async function applySnapshot(snapshot) {
    const planSha256 = await mediaPlanDigest(snapshot.mediaTasks);
    if (state.resumeExisting) {
      if (planSha256 !== state.expectedMediaPlanSha256
          || state.seededMediaTotals.requested !== snapshot.mediaTasks.length
          || state.mediaStartIndex > snapshot.mediaTasks.length) {
        throw new Error("resume_media_plan_mismatch");
      }
    }
    state.datasets = snapshot.datasets;
    state.mediaTasks = snapshot.mediaTasks;
    state.mediaPlanSha256 = planSha256;
    state.mediaTotals = state.resumeExisting
      ? {...state.seededMediaTotals, requested: snapshot.mediaTasks.length}
      : {
        requested: snapshot.mediaTasks.length, available: 0, missing: 0, expired: 0,
        decryptError: 0, downloadTimeout: 0, noProgressTimeout: 0, tooLarge: 0,
        diskSpaceInsufficient: 0, hashMismatch: 0, transportInterrupted: 0,
        canceled: 0, unavailable: 0, notAttempted: 0
      };
    state.totals = Object.fromEntries(snapshot.datasets.map((item) => [item.dataset, item.records.length]));
    state.datasetIndex = state.resumeExisting ? snapshot.datasets.length : 0;
    state.mediaIndex = state.mediaStartIndex;
    state.streamStarted = false;
  }

  function messageCount(chat) {
    return conversationMessageMap(chat).size;
  }

  function historyTerminalObserved(chat) {
    const messages = read(chat, "msgs");
    const loadState = first(messages, ["msgLoadState", "loadState"]);
    return read(loadState, "noEarlierMsgs") === true || read(messages, "noEarlierMsgs") === true;
  }

  function withTimeout(promise, milliseconds) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("timeout"));
      }, milliseconds);
      Promise.resolve(promise).then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function initializeHistory(chats, runHistory) {
    state.historyChats = [];
    state.historyIndex = 0;
    state.historyStats = new Map();
    state.historyMessages = new Map();
    for (const chat of chats) {
      const id = idString(read(chat, "id"));
      if (!id) {
        noteOmission("chats_record_without_id_omitted");
        continue;
      }
      const messages = new Map();
      mergeMessageModels(messages, optionalCollectionValues(read(chat, "msgs")), id);
      mergeGlobalMessages(messages, id);
      state.historyChats.push(chat);
      state.historyMessages.set(id, messages);
      const initial = messages.size;
      state.historyStats.set(id, {
        initial, final: initial, scope: runHistory ? null : "not_run", rounds: 0,
        returned: 0, added: 0, empty: 0, stagnant: 0,
        localDbUsed: false,
        reason: runHistory ? null : "history_not_requested"
      });
    }
  }

  async function advanceHistory() {
    const chats = state.historyChats;
    if (!chats || state.historyIndex >= chats.length) {
      const snapshot = makeSnapshot(state.adapter);
      await applySnapshot(snapshot);
      state.phase = "streaming";
      return setPending("control", "progress", {
        phase: "snapshot", completed: 1, total: 1, statusCode: "snapshot_ready"
      });
    }
    const chat = chats[state.historyIndex];
    const chatId = idString(read(chat, "id"));
    const stats = state.historyStats.get(chatId);
    const finish = (scope, reason) => {
      stats.scope = scope;
      stats.reason = reason;
      stats.final = messageCount(chat);
      state.historyIndex += 1;
      return setPending("control", "progress", {
        phase: "history", completed: state.historyIndex, total: chats.length,
        statusCode: "history_chat_complete"
      });
    };
    const storeLoaderAvailable = typeof state.adapter.historyLoader === "function";
    const dbLoaderAvailable = typeof state.adapter.dbHistoryLoader === "function";
    if (!storeLoaderAvailable && !dbLoaderAvailable) {
      return finish("loader_error", "history_loader_unavailable");
    }
    if (historyTerminalObserved(chat)) {
      return messageCount(chat) === 0 && chatExpectsMessages(chat)
        ? finish("loader_error", "expected_messages_unobservable")
        : finish("terminal_observed", stats.localDbUsed
          ? "store_terminal_observed_after_local_database_fallback"
          : "store_terminal_observed");
    }
    if (stats.rounds >= MAX_HISTORY_ROUNDS) {
      return finish("limit_reached", stats.localDbUsed
        ? "history_round_limit_reached_after_local_database_fallback"
        : "history_round_limit_reached");
    }
    try {
      const messageMap = conversationMessageMap(chat);
      const beforeCount = messageMap.size;
      let recognized = false;
      let providerResponded = false;
      const returned = [];
      if (storeLoaderAvailable) {
        try {
          const returnedValue = await withTimeout(
            state.adapter.historyLoader.call(state.adapter.historyOwner, {chat}),
            HISTORY_TIMEOUT_MS
          );
          providerResponded = true;
          const normalized = normalizeLoadedMessages(returnedValue);
          recognized = normalized.recognized;
          returned.push(...normalized.messages);
        } catch (_) {
          // The fixed local DB reader below remains an independent read-only
          // fallback for builds where the Store loader rejects or times out.
        }
      }
      mergeMessageModels(messageMap, returned, chatId);
      mergeMessageModels(messageMap, optionalCollectionValues(read(chat, "msgs")), chatId);
      mergeGlobalMessages(messageMap, chatId);
      if (messageMap.size === beforeCount && dbLoaderAvailable) {
        try {
          const dbResult = await loadEarlierFromLocalDb(chat, messageMap);
          if (dbResult.available && dbResult.recognized) {
            providerResponded = true;
            stats.localDbUsed = true;
          }
          recognized = recognized || dbResult.recognized;
          returned.push(...dbResult.messages);
          mergeMessageModels(messageMap, dbResult.messages, chatId);
        } catch (_) {
          // Provider errors are converted to a bounded loader_error below.
        }
      }
      mergeMessageModels(messageMap, optionalCollectionValues(read(chat, "msgs")), chatId);
      mergeGlobalMessages(messageMap, chatId);
      const resolvableReturned = returned.reduce((count, message) =>
        count + (messageNativeId(message, chatId) ? 1 : 0), 0);
      const added = messageMap.size - beforeCount;
      stats.rounds += 1;
      stats.returned += returned.length;
      stats.added += added;
      if (returned.length === 0) stats.empty += 1;
      if (added === 0) stats.stagnant += 1;
      else stats.stagnant = 0;
      stats.final = messageMap.size;
      if (historyTerminalObserved(chat)) {
        return messageMap.size === 0 && chatExpectsMessages(chat)
          ? finish("loader_error", "expected_messages_unobservable")
          : finish("terminal_observed", stats.localDbUsed
            ? "store_terminal_observed_after_local_database_fallback"
            : "store_terminal_observed");
      }
      if (!providerResponded && added === 0) {
        return finish("loader_error", stats.localDbUsed
          ? "history_loader_error_after_local_database_fallback"
          : "history_loader_error");
      }
      if (!recognized && added === 0) return finish("loader_error", "history_result_shape_unrecognized");
      if (returned.length > 0 && resolvableReturned === 0) {
        return finish("loader_error", "history_returned_records_unresolved");
      }
      if (stats.stagnant >= STABLE_HISTORY_ROUNDS) {
        return messageMap.size === 0 && chatExpectsMessages(chat)
          ? finish("loader_error", "expected_messages_unobservable")
          : finish("stable_no_growth", stats.localDbUsed
            ? "stable_no_growth_after_local_database_fallback"
            : "stable_no_growth");
      }
      return setPending("control", "progress", {
        phase: "history", completed: state.historyIndex, total: chats.length,
        statusCode: "history_round_complete"
      });
    } catch (_) {
      return finish("loader_error", "history_loader_error");
    }
  }

  async function makeJsonFrame(stream, kind, payloadObject, recordCount) {
    const payload = JSON.stringify(payloadObject);
    const bytes = encoder.encode(payload);
    const limit = stream === "control" ? MAX_CONTROL_BYTES : MAX_DATA_FRAME_BYTES;
    if (bytes.byteLength > limit || bytes.byteLength > MAX_QUEUE_BYTES) throw new Error("frame_limit_exceeded");
    const frame = {
      protocol: PROTOCOL, sessionId, sequence: state.nextSequence.toString(10), stream, kind,
      encoding: "utf8_json", payloadBytes: bytes.byteLength, payloadSha256: await sha256Hex(bytes), payload
    };
    if (recordCount !== undefined) frame.recordCount = recordCount;
    return Object.freeze(frame);
  }

  function base64(bytes) {
    let binary = "";
    const step = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += step) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + step)));
    }
    return btoa(binary);
  }

  async function makeMediaFrame(bytes) {
    return Object.freeze({
      protocol: PROTOCOL, sessionId, sequence: state.nextSequence.toString(10),
      stream: "media", kind: "media_chunk", encoding: "base64",
      payloadBytes: bytes.byteLength, payloadSha256: await sha256Hex(bytes), payload: base64(bytes)
    });
  }

  async function setPending(stream, kind, payload, recordCount) {
    if (state.pending) return state.pending;
    if (["history", "streaming"].includes(state.phase)) await liveAccountBinding();
    const frame = await makeJsonFrame(stream, kind, payload, recordCount);
    if (["history", "streaming"].includes(state.phase)) await liveAccountBinding();
    state.pending = frame;
    return frame;
  }

  async function makeRecordBatch(dataset) {
    const records = [];
    let acceptedPayload = null;
    while (dataset.cursor < dataset.records.length && records.length < MAX_RECORDS_PER_FRAME) {
      const record = dataset.records[dataset.cursor];
      if (!record || typeof record.id !== "string" || record.id.length === 0) {
        throw new Error("record_id_unavailable");
      }
      const candidate = records.concat([record]);
      const payload = {
        dataset: dataset.dataset,
        ...(dataset.dataset === "accounts" ? {accountBindingSha256: state.accountBindingSha256} : {}),
        records: candidate
      };
      if (encoder.encode(JSON.stringify(payload)).byteLength > MAX_DATA_FRAME_BYTES) {
        if (records.length === 0) throw new Error("record_too_large");
        break;
      }
      records.push(record);
      acceptedPayload = payload;
      dataset.cursor += 1;
    }
    return acceptedPayload ? setPending("record", "records", acceptedPayload, records.length) : null;
  }

  async function blobFromCandidate(candidate, declaredMime = null) {
    if (candidate instanceof Blob) return candidate;
    if (candidate && typeof read(candidate, "forceToBlob") === "function") {
      const blob = await Promise.resolve(candidate.forceToBlob());
      if (blob instanceof Blob) return blob;
    }
    if (candidate instanceof ArrayBuffer) {
      return new Blob([candidate], {type: declaredMime || "application/octet-stream"});
    }
    if (ArrayBuffer.isView(candidate)) {
      return new Blob([
        candidate.buffer.slice(candidate.byteOffset, candidate.byteOffset + candidate.byteLength)
      ], {type: declaredMime || "application/octet-stream"});
    }
    if (typeof candidate === "string" && candidate.startsWith("data:image/")
        && candidate.length <= 16 * 1024 * 1024) {
      const match = /^data:(image\/[a-z0-9.+-]{1,80});base64,([a-z0-9+/=]+)$/i.exec(candidate);
      if (!match) return null;
      try {
        const decoded = atob(match[2]);
        const bytes = new Uint8Array(decoded.length);
        for (let index = 0; index < decoded.length; index += 1) {
          bytes[index] = decoded.charCodeAt(index);
        }
        return new Blob([bytes], {type: match[1].toLowerCase()});
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  async function cachedMessageBlob(model) {
    const mediaData = messageField(model, ["mediaData"]);
    const mediaObject = messageField(model, ["mediaObject"]);
    for (const mediaBlob of [read(mediaData, "mediaBlob"), read(mediaObject, "mediaBlob")]) {
      if (mediaBlob instanceof Blob) return mediaBlob;
      if (mediaBlob && typeof read(mediaBlob, "forceToBlob") === "function") {
        const blob = mediaBlob.forceToBlob();
        if (blob instanceof Blob) return blob;
      }
    }
    const fileHash = first(mediaData, ["filehash", "fileHash"])
      || first(mediaObject, ["filehash", "fileHash"]);
    if (fileHash && state.adapter.blobCache) {
      const cached = await Promise.resolve(state.adapter.blobCache.get(fileHash));
      if (cached instanceof Blob) return cached;
      if (cached && typeof read(cached, "forceToBlob") === "function") {
        const blob = cached.forceToBlob();
        if (blob instanceof Blob) return blob;
      }
    }
    if (fileHash && state.adapter.lruMediaStore) {
      const cached = await Promise.resolve(state.adapter.lruMediaStore.get(fileHash));
      if (cached instanceof Blob) return cached;
      if (cached instanceof ArrayBuffer) {
        return new Blob([cached], {
          type: stringValue(messageField(model, ["mimetype", "mimeType"])) || "application/octet-stream"
        });
      }
      if (ArrayBuffer.isView(cached)) {
        return new Blob([cached.buffer.slice(cached.byteOffset, cached.byteOffset + cached.byteLength)], {
          type: stringValue(messageField(model, ["mimetype", "mimeType"])) || "application/octet-stream"
        });
      }
    }
    return null;
  }

  async function cachedProfilePictureBlob(job) {
    if (job.downloadedBlob instanceof Blob) return job.downloadedBlob;
    return blobFromCandidate(profilePictureCandidate(job.model), job.declaredMime);
  }

  async function cachedBlobForTask(job) {
    return job.role === "avatar" ? cachedProfilePictureBlob(job) : cachedMessageBlob(job.model);
  }

  async function downloadProfilePicture(job) {
    const url = allowedProfilePictureUrl(job.model);
    if (!url || typeof window.fetch !== "function") throw new Error("profile_picture_unavailable");
    const response = await window.fetch(url, {
      method: "GET",
      credentials: "omit",
      cache: "default",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    if (!response || response.status === 404 || response.status === 410) {
      job.profileFailure = "media_expired";
      throw new Error("profile_picture_expired");
    }
    if (!response.ok) throw new Error("profile_picture_unavailable");
    const contentLength = Number.parseInt(response.headers?.get?.("content-length") || "", 10);
    if (Number.isSafeInteger(contentLength)
        && contentLength > Math.min(MAX_MEDIA_BYTES, state.mediaPolicy.maxAssetBytes)) {
      job.profileFailure = "media_too_large";
      throw new Error("profile_picture_too_large");
    }
    const blob = await response.blob();
    if (!(blob instanceof Blob)) throw new Error("profile_picture_unavailable");
    job.downloadedBlob = blob;
  }

  function mediaFailureCode(model, fallback) {
    const stage = String(first(messageField(model, ["mediaData"]), ["mediaStage", "stage"]) || "").toUpperCase();
    if (stage.includes("EXPIRED") || stage.includes("404") || stage.includes("410")) return "media_expired";
    if (stage.includes("DECRYPT") || stage.includes("MAC_MISMATCH")) return "media_decrypt_failed";
    return fallback;
  }

  function mediaFailureCodeForTask(job, fallback) {
    return job.role === "avatar" ? (job.profileFailure || fallback)
      : mediaFailureCode(job.model, fallback);
  }

  function downloaderFor(model) {
    for (const view of messageModelViews(model)) {
      const download = read(view, "downloadMedia");
      if (typeof download === "function") return {owner: view, function: download};
    }
    const mediaData = messageField(model, ["mediaData"]);
    if (typeof read(mediaData, "downloadMedia") === "function") {
      return {owner: mediaData, function: read(mediaData, "downloadMedia")};
    }
    return null;
  }

  function terminalStatusForError(errorCode) {
    if (errorCode === "media_expired") return "expired";
    if (errorCode === "media_decrypt_failed") return "decrypt_error";
    if (errorCode === "media_download_timeout") return "download_timeout";
    if (errorCode === "media_no_progress_timeout") return "no_progress_timeout";
    if (errorCode === "media_too_large") return "too_large";
    if (errorCode === "media_disk_space_insufficient") return "disk_space_insufficient";
    if (errorCode === "media_hash_mismatch") return "hash_mismatch";
    if (errorCode === "media_transport_interrupted") return "transport_interrupted";
    if (errorCode === "media_canceled") return "canceled";
    if ([
      "media_not_attempted", "media_policy_metadata_only",
      "media_cache_miss_network_disallowed", "media_total_limit_reached",
      "media_policy_stop_after_failure"
    ].includes(errorCode)) return "not_attempted";
    if (errorCode === "media_missing") return "missing";
    return "unavailable";
  }

  function settleMediaJob(job, blob, errorCode) {
    if (state.activeMedia !== job || job.settled) return;
    job.blob = blob instanceof Blob ? blob : null;
    job.failure = errorCode;
    if (job.blob && job.blob.size > Math.min(MAX_MEDIA_BYTES, state.mediaPolicy.maxAssetBytes)) {
      job.blob = null;
      job.failure = "media_too_large";
    }
    job.phase = job.blob ? "blob_ready" : "terminal";
    job.lastProgressAtMs = Date.now();
    job.settled = true;
  }

  function forceMediaTerminal(job, errorCode) {
    if (state.activeMedia !== job) return false;
    job.generation += 1;
    job.blob = null;
    job.failure = errorCode;
    job.phase = "terminal";
    job.settled = true;
    job.stage = "end";
    job.lastProgressAtMs = Date.now();
    return true;
  }

  function jobIsCurrent(job, generation) {
    return state.activeMedia === job && job.generation === generation && !job.settled;
  }

  function beginDownloadAttempt(job) {
    if (state.activeMedia !== job || job.settled) return;
    const downloader = job.role === "avatar" ? null : downloaderFor(job.model);
    if (job.role !== "avatar" && !downloader) {
      settleMediaJob(job, null, "media_unavailable");
      return;
    }
    if (job.attempts >= state.mediaPolicy.maxAttempts) {
      settleMediaJob(job, null, "media_unavailable");
      return;
    }
    job.generation += 1;
    const generation = job.generation;
    job.attempts += 1;
    job.networkActionAttempted = true;
    job.phase = "requesting_download";
    job.lastProgressAtMs = Date.now();
    Promise.resolve().then(() => {
      if (!jobIsCurrent(job, generation)) return null;
      job.phase = "waiting_download";
      job.lastProgressAtMs = Date.now();
      return job.role === "avatar" ? downloadProfilePicture(job)
        : downloader.function.call(downloader.owner, {
          downloadEvenIfExpensive: true, rmrReason: 1, isUserInitiated: true
        });
    }).then(async () => {
      if (!jobIsCurrent(job, generation)) return;
      const blob = await cachedBlobForTask(job);
      if (!jobIsCurrent(job, generation)) return;
      if (blob instanceof Blob) {
        settleMediaJob(job, blob, null);
        return;
      }
      const failure = mediaFailureCodeForTask(job, "media_unavailable");
      if (["media_expired", "media_decrypt_failed"].includes(failure)) {
        settleMediaJob(job, null, failure);
      } else if (job.attempts < state.mediaPolicy.maxAttempts) {
        job.phase = "retry_pending";
        job.lastProgressAtMs = Date.now();
      } else {
        settleMediaJob(job, null, "media_unavailable");
      }
    }).catch(() => {
      if (!jobIsCurrent(job, generation)) return;
      const failure = mediaFailureCodeForTask(job, "media_unavailable");
      if (["media_expired", "media_decrypt_failed"].includes(failure)) {
        settleMediaJob(job, null, failure);
      } else if (job.attempts < state.mediaPolicy.maxAttempts) {
        job.phase = "retry_pending";
        job.lastProgressAtMs = Date.now();
      } else {
        settleMediaJob(job, null, "media_unavailable");
      }
    });
  }

  function beginCacheLookup(job) {
    job.generation += 1;
    const generation = job.generation;
    job.phase = "checking_cache";
    job.lastProgressAtMs = Date.now();
    Promise.resolve().then(() => cachedBlobForTask(job)).then((blob) => {
      if (!jobIsCurrent(job, generation)) return;
      if (blob instanceof Blob) {
        settleMediaJob(job, blob, null);
      } else if (state.mediaPolicy.mode === "cached_only") {
        settleMediaJob(job, null, "media_cache_miss_network_disallowed");
      } else {
        job.phase = "cache_miss";
        job.lastProgressAtMs = Date.now();
      }
    }).catch(() => {
      if (!jobIsCurrent(job, generation)) return;
      if (state.mediaPolicy.mode === "network_best_effort") {
        job.phase = "cache_miss";
        job.lastProgressAtMs = Date.now();
      }
      else settleMediaJob(job, null, "media_cache_miss_network_disallowed");
    });
  }

  function startMediaJob(task) {
    const now = Date.now();
    const job = {
      ...task, blob: null, attempts: 0, networkActionAttempted: false,
      downloadedBlob: null, profileFailure: null,
      failure: null, offset: 0, emitted: 0, stage: "start",
      phase: "queued", startedAtMs: now, lastProgressAtMs: now,
      settled: false, generation: 0
    };
    state.activeMedia = job;
    if (state.mediaQueueStopReason) {
      settleMediaJob(job, null, state.mediaQueueStopReason);
    } else if (state.mediaPolicy.mode === "metadata_only") {
      settleMediaJob(job, null, "media_policy_metadata_only");
    } else {
      beginCacheLookup(job);
    }
    return job;
  }

  function mediaStartPayload(active) {
    return {
      assetKey: active.assetKey,
      role: active.role,
      kind: active.kind,
      declaredMime: active.declaredMime,
      originalFileName: active.originalFileName,
      expectedSize: unsignedInteger(
        active.blob ? active.blob.size : active.expectedSize
      ),
      width: active.width,
      height: active.height,
      durationMs: active.durationMs,
      method: active.networkActionAttempted ? "media_download"
        : (state.mediaPolicy.mode === "metadata_only" ? "not_attempted" : "cache_lookup"),
      attempts: active.attempts,
      networkActionAttempted: active.networkActionAttempted
    };
  }

  function mediaProgressPayload(active, statusCode) {
    return {
      phase: "media",
      completed: state.mediaIndex,
      total: state.mediaTasks.length,
      statusCode,
      mediaIndex: state.mediaIndex + 1,
      mediaTotal: state.mediaTasks.length,
      retryAfterMs: 1000,
      attempt: active.attempts,
      bytesObserved: active.emitted,
      elapsedMs: Math.max(0, Date.now() - active.startedAtMs)
    };
  }

  async function advanceMedia() {
    if (!state.activeMedia) {
      if (state.mediaIndex >= state.mediaTasks.length) return null;
      startMediaJob(state.mediaTasks[state.mediaIndex]);
    }
    const active = state.activeMedia;
    if (active.stage === "start") {
      active.stage = "waiting";
      return setPending("control", "media_start", mediaStartPayload(active));
    }
    if (active.stage === "waiting") {
      if (!active.settled) {
        const status = active.phase === "checking_cache" ? "media_checking_cache"
          : active.phase === "cache_miss" ? "media_cache_miss"
          : active.phase === "requesting_download" ? "media_requesting_download"
            : active.phase === "retry_pending" ? "media_retrying" : "media_waiting_download";
        return setPending("control", "progress", mediaProgressPayload(active, status));
      }
      if (active.blob) {
        active.stage = "chunks";
        return setPending("control", "progress", mediaProgressPayload(active, "media_blob_ready"));
      }
      active.stage = "end";
    }
    if (active.stage === "chunks" && active.offset < active.blob.size) {
      const end = Math.min(active.blob.size, active.offset + MEDIA_CHUNK_BYTES);
      const bytes = new Uint8Array(await active.blob.slice(active.offset, end).arrayBuffer());
      active.offset = end;
      active.emitted += bytes.byteLength;
      state.pending = await makeMediaFrame(bytes);
      return state.pending;
    }
    active.stage = "end";
    const available = Boolean(active.blob && !active.failure);
    const status = available ? "available" : terminalStatusForError(active.failure);
    const countKey = {
      available: "available", missing: "missing", expired: "expired",
      decrypt_error: "decryptError", download_timeout: "downloadTimeout",
      no_progress_timeout: "noProgressTimeout", too_large: "tooLarge",
      disk_space_insufficient: "diskSpaceInsufficient", hash_mismatch: "hashMismatch",
      transport_interrupted: "transportInterrupted", canceled: "canceled",
      unavailable: "unavailable", not_attempted: "notAttempted"
    }[status];
    state.mediaTotals[countKey] += 1;
    const payload = {
      assetKey: active.assetKey,
      status,
      totalBytes: available ? active.emitted : 0,
      errorCode: available ? null : active.failure,
      capturedAtUtc: available ? new Date().toISOString() : null,
      method: active.networkActionAttempted ? "media_download"
        : (available ? "blob_observed" : "not_attempted"),
      attempts: active.attempts,
      networkActionAttempted: active.networkActionAttempted
    };
    state.activeMedia = null;
    state.mediaIndex += 1;
    return setPending("control", "media_end", payload);
  }

  function controlMedia(command) {
    if (!command || typeof command !== "object" || Array.isArray(command)
        || typeof command.action !== "string") return false;
    const keys = Object.keys(command).sort().join(",");
    const active = state.activeMedia;
    if (command.action === "begin_download" && keys === "action" && active && !active.settled) {
      beginDownloadAttempt(active);
      return true;
    }
    if (command.action === "retry_current" && keys === "action" && active && !active.settled
        && active.attempts < state.mediaPolicy.maxAttempts) {
      beginDownloadAttempt(active);
      return true;
    }
    if (command.action === "terminate_current" && keys === "action,reason" && active
        && [
          "media_download_timeout", "media_no_progress_timeout", "media_too_large",
          "media_disk_space_insufficient", "media_hash_mismatch",
          "media_transport_interrupted", "media_canceled", "media_not_attempted",
          "media_total_limit_reached", "media_cache_miss_network_disallowed",
          "media_policy_stop_after_failure"
        ].includes(command.reason)) {
      return forceMediaTerminal(active, command.reason);
    }
    if (command.action === "stop_media_queue" && keys === "action,reason"
        && [
          "media_total_limit_reached", "media_disk_space_insufficient", "media_canceled",
          "media_policy_stop_after_failure"
        ].includes(command.reason)) {
      state.mediaQueueStopReason = command.reason;
      if (active) forceMediaTerminal(active, command.reason);
      return true;
    }
    return false;
  }

  function aggregateHistoryScope() {
    const scopes = [...state.historyStats.values()].map((value) => value.scope);
    if (state.operation === "t0") return "not_run";
    if (scopes.includes("loader_error")) return "loader_error";
    if (scopes.includes("limit_reached")) return "limit_reached";
    if (scopes.includes("stable_no_growth")) return "stable_no_growth";
    return "terminal_observed";
  }

  function aggregateMediaScope() {
    if (state.operation === "t0") return "not_requested";
    if (state.mediaPolicy.mode === "metadata_only") return "not_requested";
    return Object.entries(state.mediaTotals)
      .filter(([name]) => !["requested", "available"].includes(name))
      .every(([, value]) => value === 0) ? "complete" : "partial";
  }

  function completenessReasons() {
    const reasons = state.operation === "t0"
      ? ["passive_t0_only"]
      : ["account_scope_unverifiable", "store_only_no_ui_fallback"];
    if (state.operation !== "t0" && aggregateHistoryScope() !== "terminal_observed") {
      reasons.push(`history_${aggregateHistoryScope()}`);
    }
    if (state.operation !== "t0" && aggregateMediaScope() === "partial") reasons.push("media_partial");
    reasons.push(...[...state.omissionCounts.keys()].sort());
    return reasons;
  }

  function datasetTotalsPayload(totals) {
    return {
      accounts: totals.accounts,
      contacts: totals.contacts,
      chats: totals.chats,
      chatLists: totals.chat_lists,
      participants: totals.participants,
      messages: totals.messages,
      messageEvents: totals.message_events,
      reactions: totals.reactions,
      receipts: totals.receipts,
      pollVotes: totals.poll_votes,
      groupEvents: totals.group_events,
      statuses: totals.statuses,
      calls: totals.calls,
      channels: totals.channels,
      channelEvents: totals.channel_events,
      communities: totals.communities,
      communityRelations: totals.community_relations,
      presenceSnapshots: totals.presence_snapshots
    };
  }

  async function produceNext() {
    if (state.pending) return state.pending;
    try {
      if (state.phase === "history") return await advanceHistory();
      if (state.phase !== "streaming") return null;
      if (!state.streamStarted) {
        state.streamStarted = true;
        return await setPending("control", "stream_start", {
          operation: state.operation === "t0" ? "t0" : "comprehensive_readonly_v02",
          observedAt: state.observedAt,
          accountBindingSha256: state.accountBindingSha256,
          resumeBindingSha256: state.resumeBindingSha256,
          mediaPlanSha256: state.mediaPlanSha256,
          mediaStartIndex: state.mediaStartIndex,
          datasets: state.datasets.map((dataset) => ({
            dataset: dataset.dataset, observedRecords: dataset.records.length
          }))
        });
      }
      while (state.datasetIndex < state.datasets.length) {
        const dataset = state.datasets[state.datasetIndex];
        if (dataset.cursor < dataset.records.length) return await makeRecordBatch(dataset);
        state.datasetIndex += 1;
      }
      if (state.operation !== "t0") {
        const mediaFrame = await advanceMedia();
        if (mediaFrame) return mediaFrame;
      }
      const liveBinding = await liveAccountBinding();
      const finalFrame = await setPending("control", "stream_end", {
        operation: state.operation === "t0" ? "t0" : "comprehensive_readonly_v02",
        observedAt: state.observedAt,
        completedAt: new Date().toISOString(),
        accountBindingSha256: liveBinding,
        resumeBindingSha256: await liveResumeBinding(),
        mediaPlanSha256: state.mediaPlanSha256,
        mediaStartIndex: state.mediaStartIndex,
        totals: datasetTotalsPayload(state.totals),
        media: state.mediaTotals,
        completeness: {
          localSnapshot: state.omissionCounts.size === 0 ? "verified" : "partial",
          historyScope: aggregateHistoryScope(),
          mediaScope: aggregateMediaScope(),
          accountScope: "unverifiable",
          reasons: completenessReasons()
        }
      });
      state.phase = "done";
      return finalFrame;
    } catch (_) {
      state.phase = "done";
      return setPending("control", "error", {code: "snapshot_failed", message: "snapshot_failed"});
    }
  }

  async function dispatch(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)
        || typeof request.command !== "string") {
      return Object.freeze({ok: false, code: "unsupported_command"});
    }
    const command = request.command;
    if (request.protocol !== PROTOCOL || request.controllerVersion !== VERSION) {
      return Object.freeze({ok: false, code: "protocol_mismatch"});
    }
    const requestKeys = Object.keys(request).sort().join(",");
    // The MV3 relay is the trusted command-validation boundary. It validates
    // every nested policy and recovery field before forwarding this fixed CDP
    // call. Repeating that validation in the untrusted page realm previously
    // caused a valid Workstation-issued command to be rejected after a
    // successful probe. The controller still binds the exact top-level shape,
    // protocol and version and never exposes itself on `window`.
    const shapeValid = command === "start_comprehensive"
      ? requestKeys === "command,controllerVersion,mediaPolicy,protocol,resume"
      : (command === "start_t0"
        ? requestKeys === "command,controllerVersion,protocol,resume"
        : requestKeys === "command,controllerVersion,protocol");
    if (!["probe", "start_t0", "start_comprehensive"].includes(command) || !shapeValid) {
      return Object.freeze({ok: false, code: "unsupported_command"});
    }
    if (command === "probe") {
      if (state.phase !== "idle" || state.pending) return Object.freeze({ok: false, code: "invalid_state"});
      const detected = detectAdapter();
      if (detected.result.supported && detected.adapter) {
        try {
          detected.result.accountBindingSha256 = await accountBindingDigest(observableAccount(detected.adapter).nativeId);
          state.accountBindingSha256 = detected.result.accountBindingSha256;
        } catch (_) {
          markProbeUnsupported(detected.result, "account_reader_signature_mismatch");
          detected.adapter = null;
          state.accountBindingSha256 = null;
        }
      }
      try {
        state.probe = detected.result;
        state.adapter = detected.adapter;
        state.phase = "probed";
        await setPending("control", "probe_result", {
          protocol: PROTOCOL, controllerVersion: VERSION, ...detected.result
        });
      } catch (_) {
        state.phase = "done";
        return Object.freeze({ok: false, code: "crypto_unavailable"});
      }
      return Object.freeze({ok: true, protocol: PROTOCOL, sessionId});
    }

    if (state.phase !== "probed" || state.pending) return Object.freeze({ok: false, code: "invalid_state"});
    if (!state.probe || !state.probe.supported || !state.adapter) {
      return Object.freeze({ok: false, code: "unsupported_build"});
    }
    const comprehensive = command === "start_comprehensive";
    if (comprehensive && !state.probe.capabilities.comprehensiveReadonlyV02) {
      return Object.freeze({ok: false, code: "unsupported_build"});
    }
    if (!comprehensive && request.resume.existing) {
      return Object.freeze({ok: false, code: "unsupported_command"});
    }
    let failureCode = "account_binding_failed";
    try {
      state.omissionCounts.clear();
      await liveAccountBinding();
      state.resumeChallengeHex = request.resume.challengeHex;
      state.resumeBindingSha256 = await resumeBindingDigest(
        state.resumeChallengeHex,
        observableAccount(state.adapter).nativeId
      );
      state.resumeExisting = request.resume.existing;
      state.expectedMediaPlanSha256 = request.resume.mediaPlanSha256;
      state.mediaPlanSha256 = null;
      state.mediaStartIndex = request.resume.mediaStartIndex;
      state.seededMediaTotals = Object.freeze({...request.resume.mediaTotals});
      state.observedAt = new Date().toISOString();
      state.operation = comprehensive ? "comprehensive_readonly_v02" : "t0";
      state.mediaPolicy = comprehensive ? Object.freeze({...request.mediaPolicy}) : Object.freeze({
        mode: "metadata_only", maxAssetBytes: 1, maxTotalBytes: 1,
        cacheLookupTimeoutSeconds: 1, noProgressTimeoutSeconds: 5,
        attemptTimeoutSeconds: 5, maxAssetDurationSeconds: 5,
        maxAttempts: 1, continueOnFailure: true
      });
      failureCode = "conversation_discovery_failed";
      state.globalMessagesByChat = buildGlobalMessageIndex(state.adapter);
      const chats = observableConversations(state.adapter);
      failureCode = "history_initialization_failed";
      initializeHistory(chats, comprehensive);
      state.mediaTotals = {...state.seededMediaTotals};
      state.mediaQueueStopReason = null;
      state.mediaIndex = state.mediaStartIndex;
      state.activeMedia = null;
      if (comprehensive) {
        state.phase = "history";
      } else {
        failureCode = "snapshot_preparation_failed";
        const snapshot = makeSnapshot(state.adapter);
        await applySnapshot(snapshot);
        state.mediaTotals.notAttempted = snapshot.mediaTasks.length;
        state.mediaIndex = snapshot.mediaTasks.length;
        state.phase = "streaming";
      }
      failureCode = "account_binding_failed";
      await liveAccountBinding();
      return Object.freeze({
        ok: true, protocol: PROTOCOL, sessionId,
        resumeBindingSha256: state.resumeBindingSha256
      });
    } catch (_) {
      state.phase = "done";
      return Object.freeze({ok: false, code: failureCode});
    }
  }

  async function next() {
    return produceNext();
  }

  async function checkAccountBinding() {
    if (state.pending || !["probed", "history", "streaming", "done"].includes(state.phase)) {
      return Object.freeze({ok: false, code: "invalid_state"});
    }
    try {
      return Object.freeze({
        ok: true, protocol: PROTOCOL, sessionId,
        accountBindingSha256: await liveAccountBinding()
      });
    } catch (_) {
      return Object.freeze({ok: false, code: "account_identity_changed"});
    }
  }

  function ack(sequence) {
    if (typeof sequence !== "string" || !/^(0|[1-9][0-9]*)$/.test(sequence)) return false;
    if (state.pending && state.pending.sequence === sequence) {
      state.pending = null;
      state.lastAck = sequence;
      state.nextSequence += 1n;
      return true;
    }
    return state.lastAck === sequence;
  }

  function cancel() {
    state.phase = "cancelled";
    state.adapter = null;
    state.accountBindingSha256 = null;
    state.resumeChallengeHex = null;
    state.resumeBindingSha256 = null;
    state.resumeExisting = false;
    state.expectedMediaPlanSha256 = null;
    state.mediaPlanSha256 = null;
    state.mediaStartIndex = 0;
    state.seededMediaTotals = null;
    accountBindingSecret.fill(0);
    state.datasets = null;
    state.historyChats = null;
    state.historyStats.clear();
    state.historyMessages.clear();
    state.omissionCounts.clear();
    state.mediaTasks = null;
    state.mediaPolicy = null;
    state.mediaQueueStopReason = null;
    state.activeMedia = null;
    state.pending = null;
    return true;
  }

  return Object.freeze({
    protocol: PROTOCOL, version: VERSION, sessionId, dispatch, next, ack,
    checkAccountBinding, controlMedia, cancel
  });
})()
