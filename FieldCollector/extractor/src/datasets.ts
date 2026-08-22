FC.recordsFromCollection = function recordsFromCollection(dataset, collection) {
  return FC.collectionValues(collection).map((model, index) => FC.genericRecord(dataset, model, index));
};

FC.recordsFromNestedCollection = function recordsFromNestedCollection(dataset, parents, keys) {
  const records = [];
  FC.collectionValues(parents).forEach(parent => {
    const parentId = FC.idString(FC.first(parent, ["id", "wid", "jid"]));
    FC.collectionValues(FC.first(parent, keys)).forEach(model => {
      const record = FC.genericRecord(dataset, model, records.length);
      if (!record.chatId) record.chatId = parentId;
      records.push(record);
    });
  });
  return records;
};

FC.groupMetadataForChat = function groupMetadataForChat(chat, env) {
  const chatId = FC.idString(FC.first(chat, ["id", "wid"]));
  const embedded = FC.first(chat, ["groupMetadata", "metadata"]);
  if (embedded) return embedded;
  try {
    if (typeof env.groupMetadata?.get === "function") {
      const exact = env.groupMetadata.get(FC.first(chat, ["id", "wid"])) || env.groupMetadata.get(chatId);
      if (exact) return exact;
    }
  } catch {}
  return FC.collectionValues(env.groupMetadata).find(item =>
    FC.idString(FC.first(item, ["id", "wid", "jid"])) === chatId
  ) || null;
};

FC.groupIdsFrom = function groupIdsFrom(value) {
  const output = [];
  const remember = candidate => {
    const id = FC.idString(FC.first(candidate, [
      "id", "wid", "jid", "groupId", "subgroupId", "communityId"
    ])) || FC.idString(candidate);
    if (id && /@g\.us$/i.test(id) && !output.includes(id)) output.push(id);
  };
  FC.collectionValues(value).forEach(remember);
  if (output.length === 0) remember(value);
  return output;
};

FC.collectCommunities = function collectCommunities(env, chatMessageContexts = []) {
  const records = new Map();
  const relations = new Map();
  const communityRootIds = new Set();
  const sources = new Set();
  const chats = FC.collectionValues(env.chatCollection);
  const chatsById = new Map(chats.map(chat => [
    FC.idString(FC.first(chat, ["id", "wid"])), chat
  ]).filter(([id]) => id));
  const communityText = value => typeof value === "boolean" ? null : FC.textValue(value);
  const groupIdFrom = value => FC.groupIdsFrom(value)[0] || null;
  const rememberCommunityRoot = id => {
    if (id && /@g\.us$/i.test(id)) communityRootIds.add(id);
  };
  const rememberCommunity = (id, title, source, rawSource = null) => {
    if (!id || !/@g\.us$/i.test(id)) return;
    const chat = chatsById.get(id);
    const metadata = chat ? FC.groupMetadataForChat(chat, env) : null;
    const existing = records.get(id);
    const normalizedTitle = communityText(title)
      || existing?.title
      || communityText(FC.first(chat, ["formattedTitle", "name", "title", "subject"]))
      || id;
    const record = {
      id,
      title: normalizedTitle,
      description: communityText(FC.first(metadata, ["description", "desc", "about"]))
        ?? existing?.description
        ?? null,
      createdAt: FC.modelTimestampValue(metadata || chat || rawSource, [
        "creationTime", "createdAtTs", "createdAt", "t", "timestamp"
      ]),
      source,
      raw: FC.rawSnapshot(rawSource || metadata || chat, {omitKeys: FC.REPEATED_COLLECTION_KEYS})
    };
    records.set(id, {...existing, ...record, title: record.title || existing?.title});
    if (source) sources.add(source);
  };
  const rememberRelation = (relationKind, fromId, toId, source, rawSource = null) => {
    if (
      !fromId || !toId || fromId === toId
      || !/@g\.us$/i.test(fromId) || !/@g\.us$/i.test(toId)
    ) return;
    const id = `${fromId}:${relationKind}:${toId}`;
    if (!relations.has(id)) {
      relations.set(id, {
        id, relationKind, fromId, toId, source,
        raw: FC.rawSnapshot(rawSource, {omitKeys: FC.REPEATED_COLLECTION_KEYS})
      });
    }
    if (source) sources.add(source);
  };

  for (const model of FC.collectionValues(env.communities)) {
    const id = FC.idString(FC.first(model, ["id", "wid", "jid"]));
    rememberCommunityRoot(id);
    rememberCommunity(
      id,
      FC.first(model, ["formattedTitle", "name", "title", "subject"]),
      "WAWebCommunityCollection",
      model
    );
  }

  for (const chat of chats) {
    const chatId = FC.idString(FC.first(chat, ["id", "wid"]));
    if (!chatId || !/@g\.us$/i.test(chatId)) continue;
    const metadata = FC.groupMetadataForChat(chat, env);
    const isCommunity = [
      FC.read(metadata, "isParentGroup"),
      FC.read(metadata, "isCommunity"),
      FC.read(metadata, "isCommunityParentGroup"),
      FC.read(chat, "isCommunity"),
      FC.read(chat, "isParentGroup")
    ].some(value => FC.booleanValue(value) === true);
    if (isCommunity) {
      rememberCommunityRoot(chatId);
      rememberCommunity(
        chatId,
        FC.first(chat, ["formattedTitle", "name", "title", "subject"]),
        "WAWebGroupMetadataCollection",
        metadata || chat
      );
    }
    const parentId = groupIdFrom(FC.first(metadata, [
      "parentGroup", "parentGroupId", "linkedParent", "linkedParentGroup", "community", "communityId"
    ]));
    if (parentId) {
      rememberCommunityRoot(parentId);
      rememberCommunity(parentId, null, "WAWebGroupMetadataCollection", metadata);
      rememberRelation("community_parent", chatId, parentId, "WAWebGroupMetadataCollection", metadata);
      const isAnnouncement = [
        FC.read(metadata, "announce"),
        FC.read(metadata, "defaultSubgroup"),
        FC.read(metadata, "isDefaultSubgroup"),
        FC.read(metadata, "isAnnouncementGroup")
      ].some(value => FC.booleanValue(value) === true);
      rememberRelation(
        isAnnouncement ? "community_announcement_group" : "community_child_group",
        parentId,
        chatId,
        "WAWebGroupMetadataCollection",
        metadata
      );
    }
    const defaultId = groupIdFrom(FC.first(metadata, [
      "defaultSubgroupId", "announcementGroup", "announcementGroupId"
    ]));
    if (defaultId) {
      rememberCommunityRoot(chatId);
      rememberCommunity(chatId, null, "WAWebGroupMetadataCollection", metadata);
      rememberRelation(
        "community_announcement_group", chatId, defaultId,
        "WAWebGroupMetadataCollection", metadata
      );
    }
    for (const key of ["joinedSubgroups", "subgroups", "childGroups", "communitySubgroups", "linkedGroups"]) {
      for (const childId of FC.groupIdsFrom(FC.read(metadata, key))) {
        rememberCommunityRoot(chatId);
        rememberCommunity(chatId, null, "WAWebGroupMetadataCollection", metadata);
        rememberRelation("community_child_group", chatId, childId, "WAWebGroupMetadataCollection", metadata);
      }
    }
  }

  const announcementParents = new Map();
  const eventEntries = [];
  for (const context of chatMessageContexts) {
    const chatId = FC.idString(context?.chatId);
    for (const message of context?.messages || []) {
      const subtype = String(FC.first(message, ["subtype", "eventType"]) || "").toLowerCase();
      if (!subtype) continue;
      const groupIds = FC.groupIdsFrom(FC.first(message, ["templateParams", "params", "groupIds"]));
      eventEntries.push({chatId, message, subtype, groupIds});
      if (subtype === "community_create" && groupIds[0]) {
        const communityId = groupIds[0];
        const title = FC.textValue(FC.first(message, ["body", "subject", "name", "title"]));
        announcementParents.set(chatId, communityId);
        rememberCommunityRoot(communityId);
        rememberCommunity(communityId, title, "WAWebChatCollection.community_events", message);
        rememberRelation(
          "community_announcement_group", communityId, chatId,
          "WAWebChatCollection.community_events", message
        );
      }
    }
  }
  for (const {chatId, message, subtype, groupIds} of eventEntries) {
    if (subtype === "empty_subgroup_create" && groupIds[0]) {
      rememberCommunityRoot(groupIds[0]);
      rememberCommunity(groupIds[0], null, "WAWebChatCollection.community_events", message);
      rememberRelation(
        "community_child_group", groupIds[0], chatId,
        "WAWebChatCollection.community_events", message
      );
    } else if (subtype === "sub_group_link") {
      rememberCommunityRoot(chatId);
      rememberCommunity(chatId, null, "WAWebChatCollection.community_events", message);
      for (const childId of groupIds) {
        rememberRelation(
          "community_child_group", chatId, childId,
          "WAWebChatCollection.community_events", message
        );
      }
    } else if (subtype === "sibling_group_link") {
      const parentId = announcementParents.get(chatId);
      if (parentId) for (const childId of groupIds) {
        rememberRelation(
          "community_child_group", parentId, childId,
          "WAWebChatCollection.community_events", message
        );
      }
    }
  }

  const hasStructuredSource = FC.collectionReadable(env.communities)
    || Boolean(env.groupMetadata && env.chatCollection);
  const hasObservedEvents = eventEntries.some(entry => [
    "community_create", "empty_subgroup_create", "sub_group_link", "sibling_group_link"
  ].includes(entry.subtype));
  return {
    status: hasStructuredSource || hasObservedEvents ? "supported" : "unavailable",
    reason: hasStructuredSource ? null : hasObservedEvents ? "derived_from_community_events" : "community_sources_unavailable",
    source: Array.from(sources).join("+") || null,
    records: Array.from(records.values())
      .filter(record => communityRootIds.has(record.id))
      .sort((left, right) => left.id.localeCompare(right.id)),
    relations: Array.from(relations.values()).sort((left, right) => left.id.localeCompare(right.id))
  };
};

FC.pinRecord = function pinRecord(model, index = 0) {
  const chatId = FC.idString(FC.first(model, ["chatId", "chat", "remote"]));
  const parentKey = FC.first(model, ["parentMsgKey", "msgKey", "messageKey", "parentMessageKey"]);
  const messageId = FC.idString(parentKey) || FC.idString(FC.first(model, ["messageId", "parentMessageId"]));
  const nativeId = FC.idString(FC.first(model, ["id", "key"]));
  const pinType = FC.first(model, ["pinType", "type", "state"]);
  return {
    id: nativeId || `${messageId || chatId || "unknown"}:pin:${index}`,
    dataset: "pins",
    chatId: chatId || FC.chatId(model),
    messageId,
    actorId: FC.idString(FC.first(model, ["sender", "author", "participant"])),
    timestamp: FC.modelTimestampValue(model, ["senderTimestampMs", "t", "timestamp", "createdAt"]),
    state: pinType == null ? null : String(pinType),
    raw: FC.rawSnapshot(model, {omitKeys: FC.REPEATED_COLLECTION_KEYS})
  };
};

FC.pinRecords = function pinRecords(env) {
  const records = new Map();
  FC.collectionValues(env.pins).forEach((model, index) => {
    const record = FC.pinRecord(model, index);
    records.set(record.id, record);
  });
  return Array.from(records.values());
};

FC.pinRecordsForChat = function pinRecordsForChat(chatId, messages, env) {
  const records = new Map(FC.pinRecords(env)
    .filter(record => record.chatId === chatId)
    .map(record => [record.id, record]));
  for (const [index, message] of messages.entries()) {
    const nativeType = String(FC.first(message, ["type", "kind"]) || "").toLowerCase();
    const subtype = String(FC.first(message, ["subtype", "eventType"]) || "").toLowerCase();
    const explicitPinned = FC.first(message, ["isPinned", "pinned", "pinInChat"]) === true;
    const protocolMessage = FC.read(message, "protocolMessage");
    const pinPayload = FC.first(message, ["pinInChat", "pinMessage", "pin"])
      || FC.first(protocolMessage, ["pinInChat", "pinMessage", "pin", "pinnedMessage"]);
    if (!explicitPinned && !/(?:^|_)(?:un)?pin(?:_|$)|pin_in_chat/.test(`${nativeType}_${subtype}`) && !pinPayload) {
      continue;
    }
    const payload = pinPayload && typeof pinPayload === "object" ? pinPayload : message;
    const messageId = FC.idString(FC.first(payload, [
      "parentMsgKey", "msgKey", "messageKey", "parentMessageKey", "messageId"
    ])) || FC.idString(FC.first(message, ["quotedStanzaID", "quotedMsgId"]));
    const nativeId = FC.messageId(message);
    const state = /unpin/.test(`${nativeType}_${subtype}`) ? "unpin" : "pin";
    const record = {
      id: nativeId || `${messageId || chatId}:pin-event:${index}`,
      dataset: "pins", chatId, messageId,
      actorId: FC.idString(FC.first(message, ["author", "from", "sender"])),
      timestamp: FC.timestamp(message), state,
      raw: FC.rawSnapshot(message, {omitKeys: FC.REPEATED_COLLECTION_KEYS})
    };
    records.set(record.id, record);
  }
  return Array.from(records.values());
};

FC.globalDatasets = function globalDatasets(env, overrides = {}) {
  const chatLists = env.chatLists ? FC.recordsFromCollection("chat_lists", env.chatLists) :
    FC.collectionValues(env.labels).map((model, index) => FC.genericRecord("chat_lists", model, index));
  return {
    chat_lists: chatLists,
    statuses: overrides.statuses ?? FC.recordsFromCollection("statuses", env.statuses),
    calls: overrides.calls ?? FC.recordsFromCollection("calls", env.calls),
    channels: overrides.channels ?? FC.recordsFromCollection("channels", env.channels),
    channel_events: overrides.channel_events ?? FC.recordsFromNestedCollection(
      "channel_events",
      env.channels,
      ["channelEvents", "events", "messages", "msgs"]
    ),
    communities: overrides.communities ?? FC.recordsFromCollection("communities", env.communities),
    community_relations: overrides.community_relations ?? FC.recordsFromCollection("community_relations", env.communities)
      .filter(record => record.raw?.groups || record.raw?.subgroups || record.raw?.parent),
    presence_snapshots: FC.recordsFromCollection("presence_snapshots", env.presence),
    labels: FC.recordsFromCollection("labels", env.labels),
    label_relations: FC.recordsFromCollection("label_relations", env.labelItems),
    pins: overrides.pins ?? FC.pinRecords(env)
  };
};

FC.datasetAwait = function datasetAwait(promise, timeoutMs, reason) {
  if (typeof FC.mediaAwait === "function") return FC.mediaAwait(promise, timeoutMs, reason);
  return FC.withTimeout(promise, timeoutMs);
};

FC.modelTimestampValue = function modelTimestampValue(model, keys) {
  const value = FC.first(model, keys);
  return value == null ? null : FC.timestamp({t: value});
};

FC.callRecord = function callRecord(model, index = 0) {
  const key = FC.first(model, ["id", "key"]);
  const id = FC.idString(key) || FC.idString(FC.first(model, ["callId", "stanzaId"])) || `call_${index}`;
  const outgoingValue = FC.first(model, ["outgoing", "fromMe"]);
  const peerId = FC.idString(FC.first(model, ["peerJid", "peerId", "chatId", "remote"]))
    || FC.idString(outgoingValue ? FC.first(model, ["to", "recipient"]) : FC.first(model, ["from", "author"]))
    || FC.chatId(model);
  const participantValues = FC.collectionValues(FC.first(model, [
    "groupCallParticipants", "callParticipants", "participants"
  ]));
  let state = FC.first(model, ["state", "callState", "result", "outcome"]);
  try {
    if (state == null && typeof model.getState === "function") state = model.getState();
  } catch {}
  const duration = FC.first(model, ["callDuration", "duration", "durationSeconds"]);
  return {
    id,
    peerId,
    timestamp: FC.modelTimestampValue(model, ["offerTime", "t", "timestamp", "ts", "createdAt"]),
    durationSeconds: Number.isFinite(Number(duration)) ? Number(duration) : null,
    direction: outgoingValue == null ? null : Boolean(outgoingValue) ? "outgoing" : "incoming",
    isVideo: Boolean(FC.first(model, ["isVideo", "isVideoCall", "video"])),
    isGroup: Boolean(FC.first(model, ["isGroup", "isGroupCall", "groupCall"])),
    state: state == null ? null : String(state),
    reason: FC.first(model, ["reason", "terminationReason", "callResult"]) ?? null,
    participantIds: participantValues.map(item =>
      FC.idString(FC.first(item, ["id", "wid", "jid", "participant", "userJid"])) || FC.idString(item)
    ).filter(Boolean),
    raw: FC.rawSnapshot(model, {omitKeys: FC.REPEATED_COLLECTION_KEYS})
  };
};

FC.collectCalls = async function collectCalls(env, isCancelled = () => false) {
  const models = new Map();
  const remember = model => {
    const record = FC.callRecord(model, models.size);
    const key = record.id || `${record.timestamp || "unknown"}:${models.size}`;
    models.set(key, model);
  };
  FC.collectionValues(env.calls).forEach(remember);
  let queryError = null;
  let queried = false;
  if (typeof env.msgFindCallLog === "function") {
    queried = true;
    let anchor;
    let previousAnchor = null;
    let stableRounds = 0;
    for (let page = 0; page < 200 && !isCancelled(); page += 1) {
      try {
        const params = {count: 1_000};
        if (anchor) params.anchor = anchor;
        const result = await FC.datasetAwait(
          Promise.resolve(env.msgFindCallLog(params)), 30_000, "call_log_query_timeout"
        );
        const values = FC.collectionValues(result);
        const before = models.size;
        values.forEach(remember);
        stableRounds = models.size === before ? stableRounds + 1 : 0;
        if (values.length === 0 || stableRounds >= 2) break;
        const oldest = values.reduce((candidate, item) => {
          const time = Number(FC.first(item, ["offerTime", "t", "timestamp", "ts"]) || 0);
          const candidateTime = Number(FC.first(candidate, ["offerTime", "t", "timestamp", "ts"]) || 0);
          return !candidate || time < candidateTime ? item : candidate;
        }, null);
        anchor = FC.first(oldest, ["id", "key"]);
        const anchorText = FC.idString(anchor);
        if (!anchor || anchorText === previousAnchor) break;
        previousAnchor = anchorText;
      } catch (error) {
        queryError = String(error?.message || error);
        break;
      }
    }
  }
  const records = Array.from(models.values(), FC.callRecord)
    .sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  if (!queried && !FC.collectionReadable(env.calls)) {
    return {status: "unavailable", reason: "call_log_source_unavailable", records};
  }
  if (!queried && records.length === 0) {
    return {
      status: "unavailable",
      reason: "historical_call_query_unavailable_and_call_collection_empty",
      records
    };
  }
  if (queryError && records.length === 0) {
    return {status: "error", reason: queryError, records};
  }
  return {
    status: "supported",
    reason: queryError ? `partial_call_log:${queryError}` : null,
    records,
    source: queried ? "WAWebDBMessageFindLocal.msgFindCallLog" : "WAWebCallCollection"
  };
};

FC.statusItemRecord = function statusItemRecord(model, ownerId) {
  const record = FC.messageRecord(model, ownerId);
  return {
    ...record,
    ownerId,
    expiresAt: FC.modelTimestampValue(model, ["expireTs", "expiration", "expiresAt"])
  };
};

FC.statusBundleRecord = function statusBundleRecord(model, messages, index = 0) {
  const id = FC.idString(FC.first(model, ["id", "wid", "jid"])) || `status_${index}`;
  const items = messages.map(message => FC.statusItemRecord(message, id))
    .sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  return {
    id,
    contactId: FC.idString(FC.first(model, ["contact", "sender", "author"])) || id,
    timestamp: FC.modelTimestampValue(model, ["t", "timestamp", "ts"]),
    expiresAt: FC.modelTimestampValue(model, ["expireTs", "expiration", "expiresAt"]),
    unreadCount: Number(FC.first(model, ["unreadCount"]) || 0),
    totalCount: Number(FC.first(model, ["totalCount"]) || items.length),
    readCount: Number(FC.first(model, ["readCount"]) || 0),
    hasUnread: Boolean(FC.first(model, ["hasUnread"])),
    items
  };
};

FC.collectStatuses = async function collectStatuses(env, isCancelled = () => false) {
  if (!FC.collectionReadable(env.statuses)) {
    return {status: "unavailable", reason: "status_collection_unavailable", records: []};
  }
  let syncAttempted = false;
  let syncError = null;
  for (const method of ["sync", "loadMore"]) {
    if (typeof env.statuses?.[method] !== "function" || isCancelled()) continue;
    syncAttempted = true;
    try {
      await FC.datasetAwait(Promise.resolve(env.statuses[method]()), 30_000, `status_${method}_timeout`);
    } catch (error) {
      syncError = String(error?.message || error);
    }
    if (FC.collectionValues(env.statuses).length > 0) break;
  }
  const parents = FC.collectionValues(env.statuses);
  const records = [];
  for (let index = 0; index < parents.length && !isCancelled(); index += 1) {
    const parent = parents[index];
    const messages = new Map();
    const absorb = values => FC.collectionValues(values).forEach(message => {
      const id = FC.idString(FC.first(message, ["id", "key"])) || `status_item_${messages.size}`;
      messages.set(id, message);
    });
    absorb(FC.first(parent, ["msgs", "messages"]));
    try {
      if (typeof parent.getAllMsgs === "function") absorb(parent.getAllMsgs());
    } catch {}
    let stableRounds = 0;
    if (typeof parent.loadMore === "function") {
      for (let round = 0; round < 20 && stableRounds < 2 && !isCancelled(); round += 1) {
        const before = messages.size;
        try {
          absorb(await FC.datasetAwait(Promise.resolve(parent.loadMore()), 20_000, "status_history_timeout"));
          absorb(FC.first(parent, ["msgs", "messages"]));
          if (typeof parent.getAllMsgs === "function") absorb(parent.getAllMsgs());
        } catch (error) {
          syncError ||= String(error?.message || error);
          break;
        }
        stableRounds = messages.size === before ? stableRounds + 1 : 0;
      }
    }
    records.push(FC.statusBundleRecord(parent, Array.from(messages.values()), index));
  }
  if (records.length === 0 && syncError) return {status: "error", reason: syncError, records};
  if (records.length === 0 && !syncAttempted) {
    return {status: "unavailable", reason: "status_collection_empty_and_sync_unavailable", records};
  }
  return {
    status: "supported",
    reason: syncError ? `partial_statuses:${syncError}` : null,
    records,
    source: "WAWebStatusCollection"
  };
};

FC.channelRecord = function channelRecord(model, index = 0, metadataOverride = null) {
  const id = FC.idString(FC.first(model, ["id", "wid", "jid"])) || `channel_${index}`;
  const metadata = metadataOverride || FC.first(model, ["newsletterMetadata", "channelMetadata", "metadata"]);
  const membershipType = FC.first(metadata, ["membershipType", "viewerRole", "role"])
    ?? FC.first(model, ["membershipType", "viewerRole", "role"])
    ?? null;
  const membership = membershipType == null ? null : String(membershipType);
  const joined = membership == null ? null : !["guest", "none", "not_subscribed"].includes(membership.toLowerCase());
  const mute = FC.first(model, ["mute", "newsletterMute"]);
  return {
    id,
    title: FC.first(model, ["formattedTitle", "name", "title"]) || FC.first(metadata, ["name", "title"]) || id,
    description: FC.first(metadata, ["description", "descriptionText", "about"]) ?? FC.first(model, ["description", "about"]) ?? null,
    membershipType: membership,
    isJoined: joined,
    joinedEvidence: membership == null ? "present_in_newsletter_collection" : "newsletter_metadata_membership",
    subscribersCount: FC.first(metadata, ["subscribersCount", "subscriberCount", "followersCount"]) ?? null,
    verificationState: FC.first(metadata, ["verificationState", "verified", "isVerified"]) ?? null,
    createdAt: FC.modelTimestampValue(metadata || model, ["creationTime", "createdAtTs", "createdAt"]),
    unreadCount: Number(FC.first(model, ["unreadCount", "unread"]) || 0),
    isMuted: Boolean(FC.first(model, ["isMuted"]) || (mute && FC.first(mute, ["expiration"]) !== 0)),
    raw: FC.rawSnapshot(model, {omitKeys: FC.REPEATED_COLLECTION_KEYS})
  };
};

FC.liveChannelModels = function liveChannelModels(channel, env = {}) {
  const id = FC.idString(FC.first(channel, ["id", "wid", "jid"]));
  const output = [];
  const add = candidate => {
    if (!candidate || FC.idString(FC.first(candidate, ["id", "wid", "jid"])) !== id || output.includes(candidate)) return;
    output.push(candidate);
  };
  const addFromCollection = collection => {
    try { if (typeof collection?.get === "function") add(collection.get(FC.first(channel, ["id", "wid", "jid"]))); } catch {}
    try { if (typeof collection?.get === "function") add(collection.get(id)); } catch {}
    FC.collectionValues(collection).forEach(add);
  };
  add(channel);
  addFromCollection(env.channels);
  // Current WhatsApp Web builds expose joined newsletters as chat-like models.
  // WAWebChatLoadMessages may update this collection instead of the newsletter collection.
  addFromCollection(env.chatCollection);
  return output;
};

FC.channelMessageModels = function channelMessageModels(channel, env = {}) {
  return FC.liveChannelModels(channel, env).flatMap(model =>
    FC.collectionValues(FC.first(model, ["channelEvents", "events", "messages", "msgs"]))
  );
};

FC.channelHistoryLoader = function channelHistoryLoader(channel, env) {
  const liveModels = FC.liveChannelModels(channel, env);
  for (const model of liveModels) {
    const method = ["loadEarlierMsgs", "loadEarlierMessages", "loadMore"]
      .find(name => typeof FC.read(model, name) === "function");
    if (method) {
      return {method: `channel_model.${method}`, load: () => model[method]()};
    }
  }

  const channelModule = env.channelHistory?.default || env.channelHistory;
  const channelMethod = ["loadEarlierMsgs", "loadEarlierMessages", "loadMore"]
    .find(name => typeof FC.read(channelModule, name) === "function");
  if (channelMethod) {
    const live = liveModels.at(-1) || channel;
    return {method: `newsletter_history.${channelMethod}`, load: () => channelModule[channelMethod](live)};
  }

  // Newsletter models in current builds share the normal chat history pipeline.
  // This fallback is also the only history loader present in some builds.
  const chatLoader = FC.historyLoader(env);
  if (chatLoader) {
    const live = liveModels.at(-1) || channel;
    return {
      method: "WAWebChatLoadMessages.loadEarlierMsgs",
      load: () => chatLoader.loadEarlierMsgs({chat: live})
    };
  }
  return null;
};

FC.loadChannelWindow = async function loadChannelWindow(channel, env, cutoffMs, isCancelled = () => false) {
  const messages = new Map();
  const absorb = values => {
    let added = 0;
    for (const message of values) {
      const id = FC.messageId(message);
      if (!id) continue;
      if (!messages.has(id)) added += 1;
      messages.set(id, message);
    }
    return added;
  };
  absorb(FC.channelMessageModels(channel, env));
  let rounds = 0;
  let stableRounds = 0;
  let reason = "window_already_materialized";
  let complete = false;
  let method = null;
  while (!isCancelled() && rounds < 40) {
    const dated = Array.from(messages.values())
      .map(FC.timestampMillis)
      .filter(value => value !== null);
    const oldest = dated.length > 0 ? Math.min(...dated) : null;
    if (oldest !== null && oldest <= cutoffMs) {
      complete = true;
      reason = "window_start_reached";
      break;
    }
    const loader = FC.channelHistoryLoader(channel, env);
    if (!loader) {
      reason = messages.size > 0 ? "channel_history_loader_unavailable" : "channel_messages_unavailable";
      break;
    }
    method = loader.method;
    rounds += 1;
    const before = messages.size;
    try {
      const result = await FC.datasetAwait(
        Promise.resolve(loader.load()), 120_000, "channel_history_timeout"
      );
      absorb(FC.collectionValues(result));
      absorb(FC.channelMessageModels(channel, env));
    } catch (error) {
      reason = `channel_history_error:${String(error?.message || error)}`;
      break;
    }
    stableRounds = messages.size === before ? stableRounds + 1 : 0;
    if (stableRounds >= 2) {
      complete = true;
      reason = "channel_history_end_confirmed";
      break;
    }
  }
  if (rounds >= 40 && !complete) reason = "channel_history_round_limit";
  return {
    messages: Array.from(messages.values()).filter(message => {
      const timestamp = FC.timestampMillis(message);
      return timestamp === null || timestamp >= cutoffMs;
    }),
    report: {complete, reason, method, rounds, cutoff: new Date(cutoffMs).toISOString()}
  };
};

FC.collectChannels = async function collectChannels(env, isCancelled = () => false, options = {}) {
  if (!FC.collectionReadable(env.channels)) {
    return {status: "unavailable", reason: "newsletter_collection_unavailable", records: [], events: []};
  }
  const models = FC.collectionValues(env.channels);
  const selectedModels = [];
  const records = [];
  let metadataError = null;
  const days = Math.min(3650, Math.max(1, Number(options.days) || 15));
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const metadataFor = channel => {
    const channelId = FC.idString(FC.first(channel, ["id", "wid", "jid"]));
    const embedded = FC.first(channel, ["newsletterMetadata", "channelMetadata", "metadata"]);
    if (embedded) return embedded;
    try {
      if (typeof env.channelMetadata?.get === "function") {
        const exact = env.channelMetadata.get(FC.first(channel, ["id", "wid", "jid"]));
        if (exact) return exact;
      }
    } catch {}
    return FC.collectionValues(env.channelMetadata).find(item =>
      FC.idString(FC.first(item, ["id", "wid", "jid", "newsletterId"])) === channelId
    ) || null;
  };
  for (let index = 0; index < models.length && !isCancelled(); index += 1) {
    const channel = models[index];
    let metadata = metadataFor(channel);
    if (!metadata && typeof env.channelMetadata?.update === "function") {
      try {
        const id = FC.first(channel, ["id", "wid", "jid"]);
        const updated = await FC.datasetAwait(
          Promise.resolve(env.channelMetadata.update(id)), 15_000, "channel_metadata_timeout"
        );
        metadata = updated || metadataFor(channel);
      } catch (error) {
        metadataError ||= String(error?.message || error);
      }
    }
    const record = FC.channelRecord(channel, index, metadata);
    // A guest is an observed/discovered channel, not one joined by this account.
    if (record.isJoined === false) continue;
    selectedModels.push(channel);
    records.push(record);
  }
  const events = [];
  const mediaMessages = [];
  for (const channel of selectedModels) {
    if (isCancelled()) break;
    const channelId = FC.idString(FC.first(channel, ["id", "wid", "jid"]));
    const window = await FC.loadChannelWindow(channel, env, cutoffMs, isCancelled);
    const record = records.find(item => item.id === channelId);
    if (record) {
      record.windowDays = days;
      record.windowStart = new Date(cutoffMs).toISOString();
      record.historyComplete = window.report.complete;
      record.historyReason = window.report.reason;
      record.historyMethod = window.report.method;
    }
    for (const message of window.messages) {
      events.push({...FC.messageRecord(message, channelId), channelId});
      if (FC.isMediaMessage(message, env)) mediaMessages.push({channelId, message});
    }
  }
  events.sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  return {
    status: "supported",
    reason: metadataError ? `partial_channel_metadata:${metadataError}` : null,
    records, events, mediaMessages,
    source: "WAWebNewsletterCollection"
  };
};

FC.participantsForChat = function participantsForChat(chat, env, identityIndex = new Map()) {
  const chatId = FC.idString(FC.first(chat, ["id", "wid"]));
  const metadata = FC.groupMetadataForChat(chat, env);
  const participants = FC.collectionValues(FC.first(metadata, ["participants", "members"]));
  return participants.map((model, index) => {
    const id = FC.idString(FC.first(model, ["id", "wid"])) || `${chatId}_participant_${index}`;
    const identity = identityIndex.get(id) || null;
    return {
      id,
      chatId,
      role: FC.read(model, "isSuperAdmin") ? "super_admin" : FC.read(model, "isAdmin") ? "admin" : "member",
      name: identity?.displayName || identity?.name || null,
      lidId: identity?.lidId || (/@lid$/i.test(id) ? id : null),
      phoneId: identity?.phoneId || null,
      phoneNumber: identity?.phoneNumber || null,
      formattedPhoneNumber: identity?.formattedPhoneNumber || null
    };
  });
};

FC.flatten = function flatten(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return FC.collectionValues(value);
};

FC.chatDerivedDatasets = function chatDerivedDatasets(chat, messages, env, identityIndex = new Map()) {
  const chatId = FC.idString(FC.first(chat, ["id", "wid"]));
  const messageRecords = messages.map(message => FC.messageRecord(message, chatId));
  const messageEvents = [];
  const reactions = [];
  const receipts = [];
  const pollVotes = [];
  const groupEvents = [];
  const albumMembers = new Map();

  messages.forEach((message, index) => {
    const record = messageRecords[index];
    const nativeType = String(FC.first(message, ["type", "kind"]) || "unknown");
    if (record.isRevoked || FC.first(message, ["edit", "edited", "protocolMessage"])) {
      messageEvents.push({
        id: `${record.id}:event`, chatId, messageId: record.id,
        eventType: record.isRevoked ? "revoked" : "edited_or_protocol",
        timestamp: record.timestamp, raw: FC.rawSnapshot(message)
      });
    }
    for (const [reactionIndex, reaction] of FC.flatten(FC.first(message, ["reactions", "reactionModels"])).entries()) {
      reactions.push({
        id: FC.idString(FC.first(reaction, ["id", "key"])) || `${record.id}:reaction:${reactionIndex}`,
        chatId, messageId: record.id,
        actorId: FC.idString(FC.first(reaction, ["sender", "author", "from"])),
        emoji: FC.first(reaction, ["text", "emoji", "reactionText"]) || null,
        timestamp: FC.timestamp(reaction), raw: FC.rawSnapshot(reaction)
      });
    }
    const ack = FC.first(message, ["ack", "status"]);
    if (ack !== undefined && ack !== null) {
      receipts.push({id: `${record.id}:ack`, chatId, messageId: record.id, state: ack});
    }
    for (const [voteIndex, vote] of FC.flatten(FC.first(message, ["pollVotes", "votes", "selectedOptions"])).entries()) {
      pollVotes.push({
        id: FC.idString(FC.first(vote, ["id", "key"])) || `${record.id}:vote:${voteIndex}`,
        chatId, messageId: record.id, raw: FC.rawSnapshot(vote)
      });
    }
    if (/^(gp2|notification|protocol|group_notification)/i.test(nativeType)) {
      groupEvents.push({
        id: `${record.id}:group-event`, chatId, messageId: record.id,
        nativeType, timestamp: record.timestamp, raw: FC.rawSnapshot(message)
      });
    }
    const albumId = FC.idString(FC.first(message, ["albumId", "mediaAlbumId", "parentMsgKey"]));
    if (albumId) {
      if (!albumMembers.has(albumId)) albumMembers.set(albumId, []);
      albumMembers.get(albumId).push(record.id);
    }
  });

  const appendOptional = (target, dataset, collection) => {
    FC.collectionValues(collection).forEach((model, index) => {
      if (FC.chatId(model) === chatId) target.push(FC.genericRecord(dataset, model, index));
    });
  };
  appendOptional(reactions, "reactions", env.reactions);
  appendOptional(receipts, "receipts", env.receipts);

  const mediaAlbums = Array.from(albumMembers.entries(), ([id, messageIds]) => ({id, chatId, messageIds}));
  const pins = FC.pinRecordsForChat(chatId, messages, env);
  return {
    participants: FC.participantsForChat(chat, env, identityIndex),
    messages: messageRecords,
    message_events: messageEvents,
    reactions,
    receipts,
    poll_votes: pollVotes,
    group_events: groupEvents,
    media_albums: mediaAlbums,
    pins
  };
};

FC.absorbChats = function absorbChats(queue, byId, env) {
  let added = 0;
  for (const chat of FC.collectionValues(env.chatCollection)) {
    const id = FC.idString(FC.first(chat, ["id", "wid"]));
    if (!id) continue;
    if (byId.has(id)) queue[byId.get(id)] = chat;
    else {
      byId.set(id, queue.length);
      queue.push(chat);
      added += 1;
    }
  }
  return added;
};
