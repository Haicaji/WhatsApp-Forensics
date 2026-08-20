FC.safeRequire = function safeRequire(names) {
  const candidates = Array.isArray(names) ? names : [names];
  for (const name of candidates) {
    try {
      if (typeof globalThis.require === "function") {
        const module = globalThis.require(name);
        if (module) return {name, module};
      }
    } catch {}
  }
  return null;
};

FC.moduleValue = function moduleValue(found, names) {
  if (!found?.module) return null;
  for (const name of names) {
    if (found.module[name]) return found.module[name];
  }
  return found.module.default || found.module;
};

FC.moduleFunction = function moduleFunction(found, names) {
  if (!found?.module) return null;
  const containers = [found.module, found.module.default].filter(Boolean);
  for (const container of containers) {
    for (const name of names) {
      if (typeof container[name] === "function") return container[name].bind(container);
    }
  }
  return null;
};

FC.detectModules = function detectModules() {
  const found = {
    contacts: FC.safeRequire(["WAWebContactCollection"]),
    chats: FC.safeRequire(["WAWebChatCollection"]),
    msgGetters: FC.safeRequire(["WAWebMsgGetters"]),
    contactGetters: FC.safeRequire(["WAWebContactGetters"]),
    apiContact: FC.safeRequire(["WAWebApiContact"]),
    meUser: FC.safeRequire(["WAWebUserPrefsMeUser"]),
    history: FC.safeRequire(["WAWebChatLoadMessages"]),
    profilePictures: FC.safeRequire(["WAWebProfilePicThumbCollection"]),
    reactions: FC.safeRequire(["WAWebReactionsCollection", "WAWebReactionCollection"]),
    receipts: FC.safeRequire(["WAWebMsgInfoCollection", "WAWebReceiptCollection"]),
    statuses: FC.safeRequire(["WAWebStatusCollection", "WAWebStatusV3Collection"]),
    textStatuses: FC.safeRequire(["WAWebTextStatusCollection"]),
    calls: FC.safeRequire(["WAWebCallCollection", "WAWebCallLogCollection"]),
    callLogQuery: FC.safeRequire(["WAWebDBMessageFindLocal"]),
    channels: FC.safeRequire(["WAWebNewsletterCollection"]),
    channelMetadata: FC.safeRequire(["WAWebNewsletterMetadataCollection"]),
    channelHistory: FC.safeRequire(["WAWebNewsletterLoadMessages", "WAWebNewsletterLoadMessagesJob"]),
    groupMetadata: FC.safeRequire(["WAWebGroupMetadataCollection"]),
    communities: FC.safeRequire(["WAWebCommunityCollection", "WAWebCommunityMetadataCollection"]),
    presence: FC.safeRequire(["WAWebPresenceCollection"]),
    labels: FC.safeRequire(["WAWebLabelCollection"]),
    labelItems: FC.safeRequire(["WAWebLabelItemCollection"]),
    pins: FC.safeRequire([
      "WAWebPinInChatCollection", "WAWebPinCollection", "WAWebMsgPinCollection",
      "WAWebPinnedMessageCollection"
    ]),
    chatLists: FC.safeRequire(["WAWebChatListCollection"]),
    cryptoHkdf: FC.safeRequire(["WACryptoHkdf", "WAWebCryptoHkdf"]),
    mediaBlobCache: FC.safeRequire(["WAWebMediaInMemoryBlobCache"])
  };

  const env = {
    found,
    contactCollection: FC.moduleValue(found.contacts, ["ContactCollection"]),
    chatCollection: FC.moduleValue(found.chats, ["ChatCollection"]),
    msgGetters: FC.moduleValue(found.msgGetters, ["MsgGetters"]),
    contactGetters: FC.moduleValue(found.contactGetters, ["ContactGetters"]),
    contactPhoneNumber: FC.moduleFunction(found.apiContact, ["getPhoneNumber"]),
    meUser: FC.moduleValue(found.meUser, ["UserPrefsMeUser"]),
    historyLoader: FC.moduleValue(found.history, ["ChatLoadMessages"]),
    profilePictures: FC.moduleValue(found.profilePictures, ["ProfilePicThumbCollection"]),
    reactions: FC.moduleValue(found.reactions, ["ReactionsCollection", "ReactionCollection"]),
    receipts: FC.moduleValue(found.receipts, ["MsgInfoCollection", "ReceiptCollection"]),
    statuses: FC.moduleValue(found.statuses, [
      "StatusV3CollectionImpl", "StatusV3Collection", "StatusCollectionImpl", "StatusCollection"
    ]),
    textStatuses: FC.moduleValue(found.textStatuses, ["TextStatusCollectionImpl", "TextStatusCollection"]),
    calls: FC.moduleValue(found.calls, ["CallCollectionImpl", "CallCollection", "CallLogCollection"]),
    msgFindCallLog: FC.moduleFunction(found.callLogQuery, ["msgFindCallLog"]),
    channels: FC.moduleValue(found.channels, ["NewsletterCollection", "NewsletterMetadataCollection"]),
    channelMetadata: FC.moduleValue(found.channelMetadata, [
      "NewsletterMetadataCollection", "WAWebNewsletterMetadataCollection"
    ]),
    channelHistory: FC.moduleValue(found.channelHistory, ["NewsletterLoadMessages", "NewsletterLoadMessagesJob"]),
    groupMetadata: FC.moduleValue(found.groupMetadata, [
      "GroupMetadataCollectionImpl", "GroupMetadataCollection"
    ]),
    communities: FC.moduleValue(found.communities, ["CommunityCollection", "CommunityMetadataCollection"]),
    presence: FC.moduleValue(found.presence, ["PresenceCollection"]),
    labels: FC.moduleValue(found.labels, ["LabelCollection"]),
    labelItems: FC.moduleValue(found.labelItems, ["LabelItemCollection"]),
    pins: FC.moduleValue(found.pins, [
      "PinInChatCollectionImpl", "PinInChatCollection", "PinCollection", "MsgPinCollection",
      "PinnedMessageCollection"
    ]),
    chatLists: FC.moduleValue(found.chatLists, ["ChatListCollection"]),
    cryptoHkdf: FC.moduleValue(found.cryptoHkdf, ["CryptoHkdf", "Hkdf", "HKDF"]),
    mediaBlobCache: FC.moduleValue(found.mediaBlobCache, ["InMemoryMediaBlobCache"])
  };

  const supported = (condition, source, reason = "module_unavailable") => ({
    status: condition ? "supported" : "unavailable",
    source: condition ? source : null,
    reason: condition ? null : reason
  });
  const capabilities = {
    accounts: supported(Boolean(env.contactCollection), found.contacts?.name),
    contacts: supported(Boolean(env.contactCollection), found.contacts?.name),
    chats: supported(Boolean(env.chatCollection), found.chats?.name),
    chat_lists: supported(Boolean(env.chatLists || env.labels), found.chatLists?.name || found.labels?.name),
    participants: supported(Boolean(env.groupMetadata || env.chatCollection), found.groupMetadata?.name || found.chats?.name),
    messages: supported(Boolean(env.chatCollection && env.msgGetters), `${found.chats?.name || ""}+${found.msgGetters?.name || ""}`),
    message_events: supported(Boolean(env.chatCollection), found.chats?.name),
    reactions: supported(Boolean(env.reactions || env.chatCollection), found.reactions?.name || found.chats?.name),
    receipts: supported(Boolean(env.receipts || env.chatCollection), found.receipts?.name || found.chats?.name),
    poll_votes: supported(Boolean(env.chatCollection), found.chats?.name),
    group_events: supported(Boolean(env.chatCollection), found.chats?.name),
    statuses: supported(FC.collectionReadable(env.statuses), found.statuses?.name, "status_collection_unreadable"),
    calls: supported(Boolean(env.msgFindCallLog || FC.collectionReadable(env.calls)),
      found.callLogQuery?.name || found.calls?.name, "call_log_source_unavailable"),
    channels: supported(FC.collectionReadable(env.channels),
      [found.channels?.name, found.channelMetadata?.name].filter(Boolean).join("+") || null,
      "newsletter_collection_unreadable"),
    channel_events: supported(FC.collectionReadable(env.channels), found.channels?.name, "newsletter_collection_unreadable"),
    communities: supported(
      FC.collectionReadable(env.communities) || Boolean(env.groupMetadata && env.chatCollection),
      found.communities?.name || [found.groupMetadata?.name, found.chats?.name].filter(Boolean).join("+")
    ),
    community_relations: supported(
      FC.collectionReadable(env.communities) || Boolean(env.groupMetadata && env.chatCollection),
      found.communities?.name || [found.groupMetadata?.name, found.chats?.name].filter(Boolean).join("+")
    ),
    presence_snapshots: supported(Boolean(env.presence), found.presence?.name),
    media_albums: supported(Boolean(env.chatCollection), found.chats?.name),
    labels: supported(Boolean(env.labels), found.labels?.name),
    label_relations: supported(Boolean(env.labelItems), found.labelItems?.name),
    pins: supported(FC.collectionReadable(env.pins), found.pins?.name, "pin_collection_unreadable")
  };
  return {
    env,
    capabilities: {
      capturedAt: new Date().toISOString(),
      whatsappBuild: String(globalThis.Debug?.VERSION || globalThis.Build?.VERSION || "unknown"),
      datasets: capabilities,
      features: {
        phone_resolution: supported(Boolean(env.contactPhoneNumber || env.meUser),
          [found.apiContact?.name, found.meUser?.name].filter(Boolean).join("+") || null,
          "phone_identity_modules_unavailable"),
        media_decryption: supported(Boolean(env.cryptoHkdf?.extractAndExpand), found.cryptoHkdf?.name, "media_hkdf_unavailable"),
        media_blob_cache: supported(Boolean(env.mediaBlobCache?.get), found.mediaBlobCache?.name, "media_blob_cache_unavailable")
      }
    }
  };
};
