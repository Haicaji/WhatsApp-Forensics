FC.recordsFromCollection = function recordsFromCollection(dataset, collection) {
  return FC.collectionValues(collection).map((model, index) => FC.genericRecord(dataset, model, index));
};

FC.globalDatasets = function globalDatasets(env) {
  const chatLists = env.chatLists ? FC.recordsFromCollection("chat_lists", env.chatLists) :
    FC.collectionValues(env.labels).map((model, index) => FC.genericRecord("chat_lists", model, index));
  return {
    chat_lists: chatLists,
    statuses: FC.recordsFromCollection("statuses", env.statuses),
    calls: FC.recordsFromCollection("calls", env.calls),
    channels: FC.recordsFromCollection("channels", env.channels),
    channel_events: FC.recordsFromCollection("channel_events", env.channels)
      .filter(record => record.raw?.messages || record.raw?.events),
    communities: FC.recordsFromCollection("communities", env.communities),
    community_relations: FC.recordsFromCollection("community_relations", env.communities)
      .filter(record => record.raw?.groups || record.raw?.subgroups || record.raw?.parent),
    presence_snapshots: FC.recordsFromCollection("presence_snapshots", env.presence),
    labels: FC.recordsFromCollection("labels", env.labels),
    label_relations: FC.recordsFromCollection("label_relations", env.labelItems),
    pins: FC.recordsFromCollection("pins", env.pins)
  };
};

FC.participantsForChat = function participantsForChat(chat, env) {
  const chatId = FC.idString(FC.first(chat, ["id", "wid"]));
  let metadata = FC.first(chat, ["groupMetadata", "metadata"]);
  if (!metadata) {
    metadata = FC.collectionValues(env.groupMetadata)
      .find(item => FC.idString(FC.first(item, ["id", "wid"])) === chatId);
  }
  const participants = FC.collectionValues(FC.first(metadata, ["participants", "members"]));
  return participants.map((model, index) => ({
    id: FC.idString(FC.first(model, ["id", "wid"])) || `${chatId}_participant_${index}`,
    chatId,
    role: FC.read(model, "isSuperAdmin") ? "super_admin" : FC.read(model, "isAdmin") ? "admin" : "member",
    raw: FC.rawSnapshot(model)
  }));
};

FC.flatten = function flatten(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return FC.collectionValues(value);
};

FC.chatDerivedDatasets = function chatDerivedDatasets(chat, messages, env) {
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
      receipts.push({id: `${record.id}:ack`, chatId, messageId: record.id, state: ack, raw: FC.rawSnapshot(ack)});
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
  const pins = FC.recordsFromCollection("pins", env.pins).filter(record => record.chatId === chatId);
  return {
    participants: FC.participantsForChat(chat, env),
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

