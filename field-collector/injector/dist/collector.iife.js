(() => {
  "use strict";

  const PROTOCOL = "wafc-bridge/1";
  const VERSION = "0.1.0";
  const MAX_CONTROL_BYTES = 64 * 1024;
  const MAX_DATA_FRAME_BYTES = 256 * 1024;
  const MAX_RECORDS_PER_FRAME = 256;
  const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
  const ACCOUNT_BINDING_DOMAIN = "WAFC-ACCOUNT-BINDING-v1\0";
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
    pending: null,
    lastAck: null,
    nextSequence: 0n,
    datasets: null,
    datasetIndex: 0,
    streamStarted: false,
    observedAt: null,
    totals: null
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
    if (typeof value._serialized === "string") {
      return value._serialized;
    }
    if (typeof value.serialized === "string") {
      return value.serialized;
    }
    if (typeof value.user === "string" && typeof value.server === "string") {
      return `${value.user}@${value.server}`;
    }
    return null;
  }

  function observableAccount(adapter) {
    const account = adapter && adapter.contacts && adapter.contacts.getMeContact();
    const nativeId = idString(account && account.id);
    if (!account || !nativeId) {
      throw new Error("account_not_observable");
    }
    return { account, nativeId };
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

  async function liveAccountBinding() {
    if (!state.adapter || !state.accountBindingSha256) {
      throw new Error("account_identity_not_established");
    }
    const observed = await accountBindingDigest(observableAccount(state.adapter).nativeId);
    if (observed.length !== state.accountBindingSha256.length) {
      throw new Error("account_identity_changed");
    }
    let difference = 0;
    for (let index = 0; index < observed.length; index += 1) {
      difference |= observed.charCodeAt(index) ^ state.accountBindingSha256.charCodeAt(index);
    }
    if (difference !== 0) {
      throw new Error("account_identity_changed");
    }
    return observed;
  }

  function stringValue(value) {
    return typeof value === "string" ? value : null;
  }

  function numberValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function booleanValue(value) {
    return typeof value === "boolean" ? value : null;
  }

  function arrayLength(value) {
    if (Array.isArray(value)) {
      return value.length;
    }
    if (value && typeof value.getModelsArray === "function") {
      try {
        const models = value.getModelsArray();
        return Array.isArray(models) ? models.length : null;
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function collectionValues(collection) {
    if (collection && typeof collection.getModelsArray === "function") {
      const values = collection.getModelsArray();
      if (Array.isArray(values)) {
        return values.slice();
      }
    }
    if (collection && Array.isArray(collection.models)) {
      return collection.models.slice();
    }
    if (collection && Array.isArray(collection._models)) {
      return collection._models.slice();
    }
    throw new Error("collection_shape_changed");
  }

  function supportsCollection(collection) {
    return Boolean(
      collection &&
      (typeof collection.getModelsArray === "function" ||
        Array.isArray(collection.models) ||
        Array.isArray(collection._models))
    );
  }

  function fixedModule(name) {
    const moduleLoader = Reflect.get(window, "require");
    if (typeof moduleLoader !== "function") {
      throw new Error("private_module_loader_unavailable");
    }
    return moduleLoader(name);
  }

  function buildLabel() {
    const debug = window.Debug;
    const candidates = [
      debug && debug.VERSION,
      debug && debug.BUILD,
      window.WAWebVersion
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 128) {
        return candidate;
      }
    }
    return "unreported";
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
        accounts: false,
        contacts: false,
        chats: false,
        messages: false,
        media: false,
        historyLoading: false,
        networkActions: false,
        domWrites: false
      }
    };
    try {
      const contactsModule = fixedModule("WAWebContactCollection");
      const chatsModule = fixedModule("WAWebChatCollection");
      const accountModule = fixedModule("WAWebUserPrefsMeUser");
      const contacts = contactsModule && contactsModule.ContactCollection;
      const chats = chatsModule && chatsModule.ChatCollection;
      const accountReadable = Boolean(
        contacts && typeof contacts.getMeContact === "function"
      );
      if (!supportsCollection(contacts)) {
        result.reasons.push("contact_collection_signature_mismatch");
      }
      if (!supportsCollection(chats)) {
        result.reasons.push("chat_collection_signature_mismatch");
      }
      if (!accountReadable) {
        result.reasons.push("account_reader_signature_mismatch");
      }
      if (!accountModule || typeof accountModule !== "object") {
        result.reasons.push("account_module_signature_mismatch");
      }
      if (result.reasons.length === 0) {
        result.supported = true;
        result.adapterId = "wa-private-collections-v1";
        result.capabilities.passiveT0 = true;
        result.capabilities.accounts = true;
        result.capabilities.contacts = true;
        result.capabilities.chats = true;
        result.capabilities.messages = true;
        return {
          result,
          adapter: Object.freeze({ contacts, chats })
        };
      }
    } catch (_) {
      result.reasons.push("adapter_probe_failed");
    }
    if (result.reasons.length === 0) {
      result.reasons.push("unknown_build");
    }
    return { result, adapter: null };
  }

  function markProbeUnsupported(result, reason) {
    result.supported = false;
    result.adapterId = null;
    result.accountBindingSha256 = null;
    result.reasons = [reason];
    result.capabilities.passiveT0 = false;
    result.capabilities.accounts = false;
    result.capabilities.contacts = false;
    result.capabilities.chats = false;
    result.capabilities.messages = false;
  }

  function accountRecord(model) {
    return compact({
      id: idString(model && model.id),
      displayName: stringValue(model && (model.pushname || model.pushName || model.name)),
      isBusiness: booleanValue(model && model.isBusiness),
      isEnterprise: booleanValue(model && model.isEnterprise)
    });
  }

  function contactRecord(model) {
    return compact({
      id: idString(model && model.id),
      name: stringValue(model && model.name),
      pushName: stringValue(model && (model.pushname || model.pushName)),
      shortName: stringValue(model && model.shortName),
      formattedName: stringValue(model && model.formattedName),
      isUser: booleanValue(model && model.isUser),
      isGroup: booleanValue(model && model.isGroup),
      isWhatsAppContact: booleanValue(model && (model.isWAContact || model.isWhatsappContact)),
      isBusiness: booleanValue(model && model.isBusiness),
      isMyContact: booleanValue(model && model.isMyContact),
      isBlocked: booleanValue(model && model.isBlocked)
    });
  }

  function chatRecord(model) {
    const groupMetadata = model && model.groupMetadata;
    return compact({
      id: idString(model && model.id),
      name: stringValue(model && model.name),
      isGroup: booleanValue(model && model.isGroup),
      isReadOnly: booleanValue(model && model.isReadOnly),
      archived: booleanValue(model && model.archive),
      pinned: booleanValue(model && model.pin),
      unreadCount: numberValue(model && model.unreadCount),
      timestamp: numberValue(model && (model.t || model.timestamp)),
      muteExpiration: numberValue(model && model.muteExpiration),
      lastMessageId: idString(model && (model.lastReceivedKey || model.lastMessageKey)),
      participantCount: arrayLength(groupMetadata && groupMetadata.participants)
    });
  }

  function messageRecord(model, fallbackChatId) {
    const quoted = model && (model.quotedMsg || model._quotedMsgObj);
    return compact({
      id: idString(model && model.id),
      chatId: idString(model && (model.chatId || model.remote)) || fallbackChatId,
      senderId: idString(model && model.senderObj && model.senderObj.id),
      authorId: idString(model && model.author),
      recipientId: idString(model && model.to),
      timestamp: numberValue(model && (model.t || model.timestamp)),
      type: stringValue(model && model.type),
      subtype: stringValue(model && model.subtype),
      body: stringValue(model && model.body),
      caption: stringValue(model && model.caption),
      fromMe: booleanValue(model && model.id && model.id.fromMe),
      isStarred: booleanValue(model && model.star),
      isForwarded: booleanValue(model && model.isForwarded),
      isViewOnce: booleanValue(model && model.isViewOnce),
      isEdited: booleanValue(model && model.isEdited),
      isRevoked: booleanValue(model && (model.isRevoked || model.type === "revoked")),
      hasMedia: booleanValue(model && model.mediaData && model.mediaData.mediaStage !== undefined),
      acknowledgement: numberValue(model && model.ack),
      quotedMessageId: idString(quoted && quoted.id),
      mediaMimeType: stringValue(model && model.mimetype),
      mediaSize: numberValue(model && (model.size || model.fileSize))
    });
  }

  function makeSnapshot(adapter) {
    const contacts = collectionValues(adapter.contacts);
    const chats = collectionValues(adapter.chats);
    const { account } = observableAccount(adapter);
    const messages = [];
    const seen = new Set();
    for (const chat of chats) {
      const chatId = idString(chat && chat.id);
      if (!supportsCollection(chat && chat.msgs)) {
        throw new Error("message_collection_shape_changed");
      }
      const chatMessages = collectionValues(chat.msgs);
      for (const message of chatMessages) {
        const messageId = idString(message && message.id);
        const key = messageId || `anonymous-${messages.length}`;
        if (!seen.has(key)) {
          seen.add(key);
          messages.push({ model: message, chatId });
        }
      }
    }
    return [
      { dataset: "accounts", models: [account], serialize: accountRecord, cursor: 0 },
      { dataset: "contacts", models: contacts, serialize: contactRecord, cursor: 0 },
      { dataset: "chats", models: chats, serialize: chatRecord, cursor: 0 },
      {
        dataset: "messages",
        models: messages,
        serialize: (entry) => messageRecord(entry.model, entry.chatId),
        cursor: 0
      }
    ];
  }

  async function sha256Hex(bytes) {
    if (!webCrypto || !webCrypto.subtle || typeof webCrypto.subtle.digest !== "function") {
      throw new Error("crypto_unavailable");
    }
    const digest = new Uint8Array(await webCrypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  async function makeFrame(stream, kind, payloadObject, recordCount) {
    const payload = JSON.stringify(payloadObject);
    const bytes = encoder.encode(payload);
    const limit = stream === "control" ? MAX_CONTROL_BYTES : MAX_DATA_FRAME_BYTES;
    if (bytes.byteLength > limit || bytes.byteLength > MAX_QUEUE_BYTES) {
      throw new Error("frame_limit_exceeded");
    }
    const frame = {
      protocol: PROTOCOL,
      sessionId,
      sequence: state.nextSequence.toString(10),
      stream,
      kind,
      encoding: "utf8_json",
      payloadBytes: bytes.byteLength,
      payloadSha256: await sha256Hex(bytes),
      payload
    };
    if (recordCount !== undefined) {
      frame.recordCount = recordCount;
    }
    return Object.freeze(frame);
  }

  async function setPending(stream, kind, payload, recordCount) {
    if (state.pending) {
      return state.pending;
    }
    if (state.phase === "streaming") {
      await liveAccountBinding();
    }
    const frame = await makeFrame(stream, kind, payload, recordCount);
    if (state.phase === "streaming") {
      await liveAccountBinding();
    }
    state.pending = frame;
    return state.pending;
  }

  async function makeRecordBatch(dataset) {
    const records = [];
    let acceptedPayload = null;
    while (
      dataset.cursor < dataset.models.length &&
      records.length < MAX_RECORDS_PER_FRAME
    ) {
      const record = dataset.serialize(dataset.models[dataset.cursor]);
      if (!record || typeof record.id !== "string" || record.id.length === 0) {
        throw new Error(`record_id_unavailable:${dataset.dataset}`);
      }
      const candidate = records.concat([record]);
      const payload = {
        dataset: dataset.dataset,
        ...(dataset.dataset === "accounts"
          ? { accountBindingSha256: state.accountBindingSha256 }
          : {}),
        records: candidate
      };
      const size = encoder.encode(JSON.stringify(payload)).byteLength;
      if (size > MAX_DATA_FRAME_BYTES) {
        if (records.length === 0) {
          throw new Error(`record_too_large:${dataset.dataset}`);
        }
        break;
      }
      records.push(record);
      acceptedPayload = payload;
      dataset.cursor += 1;
    }
    if (!acceptedPayload || records.length === 0) {
      return null;
    }
    return setPending("record", "records", acceptedPayload, records.length);
  }

  async function produceNext() {
    if (state.pending) {
      return state.pending;
    }
    if (state.phase !== "streaming") {
      return null;
    }
    try {
      if (!state.streamStarted) {
        state.streamStarted = true;
        return setPending("control", "stream_start", {
          operation: "t0",
          observedAt: state.observedAt,
          accountBindingSha256: state.accountBindingSha256,
          datasets: state.datasets.map((dataset) => ({
            dataset: dataset.dataset,
            observedRecords: dataset.models.length
          }))
        });
      }
      while (state.datasetIndex < state.datasets.length) {
        const dataset = state.datasets[state.datasetIndex];
        if (dataset.cursor < dataset.models.length) {
          return await makeRecordBatch(dataset);
        }
        state.datasetIndex += 1;
      }
      const liveBinding = await liveAccountBinding();
      const finalFrame = await setPending("control", "stream_end", {
        operation: "t0",
        observedAt: state.observedAt,
        completedAt: new Date().toISOString(),
        accountBindingSha256: liveBinding,
        totals: state.totals,
        completeness: {
          localSnapshot: "verified",
          historyScope: "not_run",
          mediaScope: "not_requested",
          accountScope: "unverifiable",
          reasons: ["passive_t0_only"]
        }
      });
      state.phase = "done";
      return finalFrame;
    } catch (_) {
      state.phase = "done";
      return setPending("control", "error", {
        code: "snapshot_failed",
        message: "snapshot_failed"
      });
    }
  }

  async function dispatch(command) {
    if (command !== "probe" && command !== "start_t0") {
      return Object.freeze({ ok: false, code: "unsupported_command" });
    }
    if (command === "probe") {
      if (state.phase !== "idle" || state.pending) {
        return Object.freeze({ ok: false, code: "invalid_state" });
      }
      const detected = detectAdapter();
      if (detected.result.supported && detected.adapter) {
        try {
          const identity = observableAccount(detected.adapter);
          detected.result.accountBindingSha256 = await accountBindingDigest(identity.nativeId);
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
          protocol: PROTOCOL,
          controllerVersion: VERSION,
          ...detected.result
        });
      } catch (_) {
        state.phase = "done";
        return Object.freeze({ ok: false, code: "crypto_unavailable" });
      }
      return Object.freeze({ ok: true, protocol: PROTOCOL, sessionId });
    }

    if (state.phase !== "probed" || state.pending) {
      return Object.freeze({ ok: false, code: "invalid_state" });
    }
    if (!state.probe || !state.probe.supported || !state.adapter) {
      return Object.freeze({ ok: false, code: "unsupported_build" });
    }
    try {
      await liveAccountBinding();
      state.observedAt = new Date().toISOString();
      state.datasets = makeSnapshot(state.adapter);
      await liveAccountBinding();
      state.datasetIndex = 0;
      state.streamStarted = false;
      state.totals = Object.fromEntries(
        state.datasets.map((dataset) => [dataset.dataset, dataset.models.length])
      );
      state.phase = "streaming";
      return Object.freeze({ ok: true, protocol: PROTOCOL, sessionId });
    } catch (_) {
      state.phase = "done";
      return Object.freeze({
        ok: false,
        code: "snapshot_failed",
        message: "snapshot_failed"
      });
    }
  }

  async function next() {
    return produceNext();
  }

  async function checkAccountBinding() {
    if (state.pending || !["probed", "streaming", "done"].includes(state.phase)) {
      return Object.freeze({ ok: false, code: "invalid_state" });
    }
    try {
      return Object.freeze({
        ok: true,
        protocol: PROTOCOL,
        sessionId,
        accountBindingSha256: await liveAccountBinding()
      });
    } catch (_) {
      return Object.freeze({ ok: false, code: "account_identity_changed" });
    }
  }

  function ack(sequence) {
    if (typeof sequence !== "string" || !/^(0|[1-9][0-9]*)$/.test(sequence)) {
      return false;
    }
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
    accountBindingSecret.fill(0);
    state.datasets = null;
    state.pending = null;
    return true;
  }

  return Object.freeze({
    protocol: PROTOCOL,
    version: VERSION,
    sessionId,
    dispatch,
    next,
    ack,
    checkAccountBinding,
    cancel
  });
})()
