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

FC.detectModules = function detectModules() {
  const found = {
    contacts: FC.safeRequire(["WAWebContactCollection"]),
    chats: FC.safeRequire(["WAWebChatCollection"]),
    msgGetters: FC.safeRequire(["WAWebMsgGetters"]),
    contactGetters: FC.safeRequire(["WAWebContactGetters"]),
    meUser: FC.safeRequire(["WAWebUserPrefsMeUser"]),
    history: FC.safeRequire(["WAWebChatLoadMessages"]),
    profilePictures: FC.safeRequire(["WAWebProfilePicThumbCollection"]),
    reactions: FC.safeRequire(["WAWebReactionsCollection", "WAWebReactionCollection"]),
    receipts: FC.safeRequire(["WAWebMsgInfoCollection", "WAWebReceiptCollection"]),
    statuses: FC.safeRequire(["WAWebStatusV3Collection", "WAWebStatusCollection"]),
    calls: FC.safeRequire(["WAWebCallCollection", "WAWebCallLogCollection"]),
    channels: FC.safeRequire(["WAWebNewsletterCollection", "WAWebNewsletterMetadataCollection"]),
    groupMetadata: FC.safeRequire(["WAWebGroupMetadataCollection"]),
    communities: FC.safeRequire(["WAWebCommunityCollection", "WAWebCommunityMetadataCollection"]),
    presence: FC.safeRequire(["WAWebPresenceCollection"]),
    labels: FC.safeRequire(["WAWebLabelCollection"]),
    labelItems: FC.safeRequire(["WAWebLabelItemCollection"]),
    pins: FC.safeRequire(["WAWebPinCollection", "WAWebMsgPinCollection"]),
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
    meUser: FC.moduleValue(found.meUser, ["UserPrefsMeUser"]),
    historyLoader: FC.moduleValue(found.history, ["ChatLoadMessages"]),
    profilePictures: FC.moduleValue(found.profilePictures, ["ProfilePicThumbCollection"]),
    reactions: FC.moduleValue(found.reactions, ["ReactionsCollection", "ReactionCollection"]),
    receipts: FC.moduleValue(found.receipts, ["MsgInfoCollection", "ReceiptCollection"]),
    statuses: FC.moduleValue(found.statuses, ["StatusV3Collection", "StatusCollection"]),
    calls: FC.moduleValue(found.calls, ["CallCollection", "CallLogCollection"]),
    channels: FC.moduleValue(found.channels, ["NewsletterCollection", "NewsletterMetadataCollection"]),
    groupMetadata: FC.moduleValue(found.groupMetadata, ["GroupMetadataCollection"]),
    communities: FC.moduleValue(found.communities, ["CommunityCollection", "CommunityMetadataCollection"]),
    presence: FC.moduleValue(found.presence, ["PresenceCollection"]),
    labels: FC.moduleValue(found.labels, ["LabelCollection"]),
    labelItems: FC.moduleValue(found.labelItems, ["LabelItemCollection"]),
    pins: FC.moduleValue(found.pins, ["PinCollection", "MsgPinCollection"]),
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
    statuses: supported(Boolean(env.statuses), found.statuses?.name),
    calls: supported(Boolean(env.calls), found.calls?.name),
    channels: supported(Boolean(env.channels), found.channels?.name),
    channel_events: supported(Boolean(env.channels), found.channels?.name),
    communities: supported(Boolean(env.communities), found.communities?.name),
    community_relations: supported(Boolean(env.communities), found.communities?.name),
    presence_snapshots: supported(Boolean(env.presence), found.presence?.name),
    media_albums: supported(Boolean(env.chatCollection), found.chats?.name),
    labels: supported(Boolean(env.labels), found.labels?.name),
    label_relations: supported(Boolean(env.labelItems), found.labelItems?.name),
    pins: supported(Boolean(env.pins), found.pins?.name)
  };
  return {
    env,
    capabilities: {
      capturedAt: new Date().toISOString(),
      whatsappBuild: String(globalThis.Debug?.VERSION || globalThis.Build?.VERSION || "unknown"),
      datasets: capabilities,
      features: {
        media_decryption: supported(Boolean(env.cryptoHkdf?.extractAndExpand), found.cryptoHkdf?.name, "media_hkdf_unavailable"),
        media_blob_cache: supported(Boolean(env.mediaBlobCache?.get), found.mediaBlobCache?.name, "media_blob_cache_unavailable")
      }
    }
  };
};
