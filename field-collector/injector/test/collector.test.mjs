import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("../dist/collector.iife.js", import.meta.url),
  "utf8"
);

const NETWORK_MEDIA_POLICY = Object.freeze({
  mode: "network_best_effort",
  maxAssetBytes: 2 * 1024 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024 * 1024,
  cacheLookupTimeoutSeconds: 10,
  noProgressTimeoutSeconds: 120,
  attemptTimeoutSeconds: 600,
  maxAssetDurationSeconds: 1_200,
  maxAttempts: 2,
  continueOnFailure: true,
});

const EMPTY_MEDIA_TOTALS = Object.freeze({
  requested: 0, available: 0, missing: 0, expired: 0, decryptError: 0,
  downloadTimeout: 0, noProgressTimeout: 0, tooLarge: 0,
  diskSpaceInsufficient: 0, hashMismatch: 0, transportInterrupted: 0,
  canceled: 0, unavailable: 0, notAttempted: 0,
});

const FRESH_RESUME = Object.freeze({
  challengeHex: "11".repeat(32),
  existing: false,
  mediaPlanSha256: null,
  mediaStartIndex: 0,
  mediaTotals: EMPTY_MEDIA_TOTALS,
});

const COMMAND_CONTRACT = Object.freeze({
  protocol: "wafc-bridge/2",
  controllerVersion: "0.2.5",
});

const request = (command) => command === "start_comprehensive"
  ? {...COMMAND_CONTRACT, command, mediaPolicy: NETWORK_MEDIA_POLICY, resume: FRESH_RESUME}
  : (command === "start_t0"
    ? {...COMMAND_CONTRACT, command, resume: FRESH_RESUME}
    : {...COMMAND_CONTRACT, command});

function collection(models) {
  return Object.freeze({
    getModelsArray() {
      return models;
    }
  });
}

function fixtureWindow(
  supported,
  poisonSnapshot = false,
  accountObservable = true,
  comprehensiveMedia = false,
  historyReturnedOnly = false,
  includeIdlessPlaceholder = false,
  structuredMessageKey = false,
  deferredMedia = false,
  twoMediaFirstFailure = false,
  historyReturnsBareKey = false,
  wrappedMessage = false,
  unresolvedHistoryReturn = false,
  firstMediaRetrySucceeds = false,
  adapterVariants = {},
) {
  const {
    globalMessageOnly = false,
    historyResultEnvelope = false,
    dbHistoryFallback = false,
    expectedButUnobservable = false,
    materializedEvents = false,
    quotedByStanza = false,
    modernMessageFields = false,
    extendedCollections = false,
    binaryMediaBody = false,
    profileAvatars = false,
    chatMessagesCollectionAbsent = false,
    historyCapability = true,
    mediaCapability = true,
    globalSpecialOnly = false,
  } = adapterVariants;
  const account = Object.freeze({
    id: Object.freeze({ _serialized: "100000000000001@c.us" }),
    pushname: "Synthetic Account",
    ...(extendedCollections ? {verifiedName: "Synthetic Verified Account"} : {}),
  });
  const alternateAccount = Object.freeze({
    id: Object.freeze({ _serialized: "100000000000099@c.us" }),
    pushname: "Alternate Synthetic Account"
  });
  let currentAccount = account;
  const contact = Object.freeze({
    id: Object.freeze({ _serialized: "100000000000002@c.us" }),
    name: "Synthetic Contact",
    isUser: true,
    isWAContact: true,
    ...(extendedCollections ? {
      verifiedName: "Synthetic Verified Contact",
      isVerified: true,
      isDeactivated: false,
    } : {}),
  });
  const pastContact = Object.freeze({
    id: Object.freeze({_serialized: "100000000000004@c.us"}),
    name: "Synthetic Former Member",
    isUser: true,
    isWAContact: true,
  });
  const avatarBlob = new Blob([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ], {type: "image/png"});
  const profilePictures = collection(profileAvatars ? Object.freeze([
    Object.freeze({
      __x_id: account.id,
      _blob: avatarBlob,
      mimetype: "image/png",
      imgFull: "https://pps.whatsapp.net/v/synthetic-account-avatar",
    }),
    Object.freeze({
      __x_id: contact.id,
      _blob: avatarBlob,
      mimetype: "image/png",
      imgFull: "https://pps.whatsapp.net/v/synthetic-contact-avatar",
    }),
  ]) : Object.freeze([]));
  const messageRecord = {
    id: structuredMessageKey
      ? Object.freeze({
        id: "TEST",
        remote: Object.freeze({ _serialized: "100000000000002@c.us" }),
        fromMe: false,
      })
      : Object.freeze({ _serialized: "false_100000000000002@c.us_TEST" }),
    chatId: Object.freeze({ _serialized: "100000000000002@c.us" }),
    t: 1_700_000_000,
    type: comprehensiveMedia ? "image" : "chat",
    body: binaryMediaBody ? `/9j/${"A".repeat(256)}` : "synthetic message",
    ...(binaryMediaBody ? {caption: "Synthetic media caption"} : {}),
  };
  let resolveMediaDownload = null;
  let mediaDownloadAttempts = 0;
  if (comprehensiveMedia) {
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], {
      type: "image/png",
    });
    messageRecord.mimetype = "image/png";
    messageRecord.filename = "synthetic.png";
    const mediaObject = {
      filehash: "synthetic-file-hash",
    };
    if (!deferredMedia && !twoMediaFirstFailure && !firstMediaRetrySucceeds) {
      mediaObject.mediaBlob = { forceToBlob: () => blob };
    }
    messageRecord.mediaObject = mediaObject;
    messageRecord.downloadMedia = twoMediaFirstFailure
      ? async () => {
        mediaDownloadAttempts += 1;
        throw new Error("synthetic fixed failure");
      }
      : firstMediaRetrySucceeds
      ? async () => {
        mediaDownloadAttempts += 1;
        if (mediaDownloadAttempts === 1) {
          throw new Error("synthetic retryable failure");
        }
        mediaObject.mediaBlob = { forceToBlob: () => blob };
      }
      : deferredMedia
      ? () => new Promise((resolve) => {
        mediaDownloadAttempts += 1;
        resolveMediaDownload = () => {
          mediaObject.mediaBlob = { forceToBlob: () => blob };
          resolve();
        };
      })
      : async () => {
        mediaDownloadAttempts += 1;
      };
  }
  if (quotedByStanza) {
    messageRecord.quotedStanzaID = "HISTORY_ONLY";
    messageRecord.quotedRemoteJid = contact.id;
  }
  if (modernMessageFields) {
    messageRecord.type = "image";
    messageRecord.from = contact.id;
    messageRecord.latestEditMsgKey = Object.freeze({_serialized: "true_100000000000002@c.us_EDIT"});
    messageRecord.lat = 30.25;
    messageRecord.lng = 120.5;
    messageRecord.loc = "Synthetic Location";
    messageRecord.pollName = "Synthetic Poll";
    messageRecord.pollSelectableOptionsCount = 2;
  }
  if (poisonSnapshot) {
    Object.defineProperty(messageRecord, "body", {
      get() {
        throw new Error("SECRET-JID-100000000000001@c.us");
      }
    });
  }
  const completeMessage = Object.freeze(messageRecord);
  const message = wrappedMessage
    ? Object.freeze({data: Object.freeze({message: completeMessage})})
    : completeMessage;
  const messages = [message];
  if (twoMediaFirstFailure) {
    messages.push(Object.freeze({
      id: Object.freeze({ _serialized: "false_100000000000002@c.us_TEST_2" }),
      chatId: Object.freeze({ _serialized: "100000000000002@c.us" }),
      t: 1_700_000_001,
      type: "image",
      body: "synthetic second media",
      mimetype: "image/png",
      filename: "synthetic-second.png",
      mediaObject: Object.freeze({
        filehash: "synthetic-second-file-hash",
        mediaBlob: Object.freeze({
          forceToBlob: () => new Blob([
            new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          ], {type: "image/png"}),
        }),
      }),
    }));
  }
  if (includeIdlessPlaceholder) {
    messages.push(Object.freeze({
      chatId: Object.freeze({ _serialized: "100000000000002@c.us" }),
      t: 1_700_000_001,
      type: "placeholder",
      body: "synthetic idless placeholder",
    }));
  }
  if (modernMessageFields) {
    messages.push(Object.freeze({
      id: Object.freeze({_serialized: "false_100000000000002@c.us_POLL_UPDATE"}),
      chatId: Object.freeze({_serialized: "100000000000002@c.us"}),
      from: contact.id,
      t: 1_700_000_006,
      type: "poll_update",
      pollUpdateParentKey: completeMessage.id,
      selectedOption: "Option A",
    }));
  }
  const globalMessages = globalSpecialOnly ? [
    ...messages,
    Object.freeze({
      id: Object.freeze({_serialized: "false_status@broadcast_GLOBAL_STATUS"}),
      chatId: Object.freeze({_serialized: "status@broadcast"}),
      from: contact.id,
      t: 1_700_000_011,
      type: "chat",
      body: "synthetic global-only status",
      isStatusV3: true,
    }),
    Object.freeze({
      id: Object.freeze({_serialized: "false_120363000000009@newsletter_GLOBAL_CHANNEL"}),
      chatId: Object.freeze({_serialized: "120363000000009@newsletter"}),
      from: contact.id,
      t: 1_700_000_012,
      type: "chat",
      body: "synthetic global-only channel event",
    }),
  ] : messages;
  const historicalMessage = Object.freeze({
    id: Object.freeze({ _serialized: "false_100000000000002@c.us_HISTORY_ONLY" }),
    chatId: Object.freeze({ _serialized: "100000000000002@c.us" }),
    t: 1_600_000_000,
    type: "chat",
    body: "synthetic returned-only history",
  });
  let historyCalls = 0;
  let dbHistoryCalls = 0;
  const visibleChatMessages = (globalMessageOnly || expectedButUnobservable) ? [] : messages;
  const chat = Object.freeze({
    id: Object.freeze({ _serialized: "100000000000002@c.us" }),
    name: "Synthetic Chat",
    isGroup: false,
    ...(chatMessagesCollectionAbsent ? {} : {msgs: collection(visibleChatMessages)}),
    ...(extendedCollections ? {labels: ["label-1"], isFavorite: true} : {}),
    ...((expectedButUnobservable || dbHistoryFallback) ? {
      lastReceivedKey: completeMessage.id,
    } : {}),
  });
  const contacts = Object.freeze({
    ...collection(Object.freeze(extendedCollections ? [account, contact, pastContact] : [account, contact])),
    getMeContact() {
      return accountObservable ? currentAccount : null;
    }
  });
  const groupChatId = Object.freeze({_serialized: "100000000000003@g.us"});
  const groupChat = Object.freeze({
    id: groupChatId,
    name: "Synthetic Community",
    isGroup: true,
    msgs: collection([]),
  });
  const groupMetadataModel = Object.freeze({
    id: groupChatId,
    subject: "Synthetic Community",
    desc: "Synthetic Community Description",
    creation: 1_640_000_000,
    isParentGroup: true,
    participants: collection([Object.freeze({
      id: contact.id,
      isAdmin: true,
      joinTime: 1_650_000_000,
    })]),
    pastParticipants: collection([Object.freeze({
      id: pastContact.id,
      leaveTime: 1_660_000_000,
    })]),
  });
  const chats = collection(Object.freeze(extendedCollections ? [chat, groupChat] : [chat]));
  const channel = Object.freeze({
    id: Object.freeze({_serialized: "120363000000001@newsletter"}),
    isReadOnly: true,
    unreadCount: 3,
    msgs: collection([]),
    newsletterMetadata: Object.freeze({
      newsletterNameMetadataMixin: Object.freeze({nameElementValue: "Synthetic Channel"}),
      newsletterDescriptionMetadataMixin: Object.freeze({
        descriptionQueryDescriptionResponseMixin: Object.freeze({
          elementValue: "Synthetic Channel Description",
        }),
      }),
      newsletterStateMetadataMixin: Object.freeze({stateType: "active"}),
      newsletterCreationTimeMetadataMixin: Object.freeze({creationTimeValue: 1_630_000_000}),
    }),
  });
  const statusMessage = Object.freeze({
    id: Object.freeze({_serialized: "false_status@broadcast_STATUS_1"}),
    chatId: Object.freeze({_serialized: "status@broadcast"}),
    from: contact.id,
    t: 1_700_000_007,
    type: "chat",
    body: "synthetic visible status",
    isStatusV3: true,
  });
  const statusThread = Object.freeze({
    id: contact.id,
    msgs: collection([statusMessage]),
  });
  const materializedPin = Object.freeze({
    id: Object.freeze({_serialized: "false_100000000000002@c.us_PIN_1"}),
    parentMsgKey: completeMessage.id,
    chatId: contact.id,
    sender: account.id,
    senderTimestampMs: 1_700_000_008_000,
    pinType: 1,
  });
  const materializedReaction = Object.freeze({
    msgKey: Object.freeze({_serialized: "false_100000000000002@c.us_REACTION_1"}),
    parentMsgKey: completeMessage.id,
    reactionText: "👍",
    senderUserJid: contact.id,
    timestamp: 1_700_000_002,
  });
  const reactionCollection = collection(materializedEvents ? [Object.freeze({
    id: contact.id,
    reactions: collection([Object.freeze({
      aggregateEmoji: "👍",
      senders: collection([materializedReaction]),
    })]),
  })] : []);
  const messageInfoCollection = collection(materializedEvents ? [Object.freeze({
    id: completeMessage.id,
    delivery: collection([Object.freeze({id: contact.id, t: 1_700_000_003})]),
    read: collection([Object.freeze({id: contact.id, t: 1_700_000_004})]),
    played: collection([Object.freeze({id: contact.id, t: 1_700_000_005})]),
  })] : []);
  const moduleCalls = [];
  const page = {
    crypto: webcrypto,
    Debug: Object.freeze({ VERSION: "synthetic-test-build" })
  };
  if (supported) {
    page.require = (name) => {
      moduleCalls.push(name);
      const modules = {
        WAWebContactCollection: Object.freeze({ ContactCollection: contacts }),
        WAWebChatCollection: Object.freeze({ ChatCollection: chats }),
        WAWebUserPrefsMeUser: Object.freeze({ getMaybeMe: () => account }),
        WAWebCollections: Object.freeze({
          ...((globalMessageOnly || globalSpecialOnly) ? {Msg: collection(globalMessages)} : {}),
        }),
        ...((globalMessageOnly || globalSpecialOnly) ? {
          WAWebMsgCollection: Object.freeze({MsgCollection: collection(globalMessages)}),
        } : {}),
        ...(historyCapability ? {WAWebChatLoadMessages: Object.freeze({
          async loadEarlierMsgs() {
            historyCalls += 1;
            if (!historyReturnedOnly || historyCalls !== 1) return [];
            if (unresolvedHistoryReturn) return [Object.freeze({unexpected: true})];
            const loaded = [historyReturnsBareKey ? historicalMessage.id : historicalMessage];
            return historyResultEnvelope ? {messages: loaded, status: 200} : loaded;
          },
        })} : {}),
        ...(dbHistoryFallback ? {
          WAWebDBMessageFindLocal: Object.freeze({
            async msgFindByDirection() {
              dbHistoryCalls += 1;
              return {
                messages: dbHistoryCalls === 1 ? [historicalMessage] : [],
                status: 200,
              };
            },
          }),
          WAWebMsgKey: Object.freeze({
            fromString(value) {
              return Object.freeze({_serialized: value});
            },
          }),
        } : {}),
        ...(mediaCapability ? {WAWebMediaInMemoryBlobCache: Object.freeze({
          InMemoryMediaBlobCache: Object.freeze({ get: () => null }),
        })} : {}),
        ...(profileAvatars ? {
          WAWebProfilePicThumbCollection: Object.freeze({
            ProfilePicThumbCollection: profilePictures,
          }),
        } : {}),
        WAWebCallCollection: Object.freeze({ CallCollection: collection(extendedCollections ? [Object.freeze({
          id: "synthetic-call-1", peerJid: contact.id, offerTime: 1_700_000_009,
          state: "ended", isVideo: true, isGroup: true, outgoing: false,
          durationSeconds: 42,
          groupCallParticipants: collection([Object.freeze({id: contact.id})]),
        })] : []) }),
        ...(globalSpecialOnly ? {} : {
          WAWebStatusCollection: Object.freeze({ StatusCollection: collection(extendedCollections ? [statusThread] : []) }),
        }),
        WAWebTextStatusCollection: Object.freeze({ TextStatusCollection: collection(extendedCollections ? [Object.freeze({
          id: contact.id, status: "Synthetic About",
        })] : []) }),
        ...(globalSpecialOnly ? {} : {
          WAWebNewsletterCollection: Object.freeze({
            NewsletterCollection: collection(extendedCollections ? [channel] : []),
          }),
        }),
        WAWebGroupMetadataCollection: Object.freeze({
          GroupMetadataCollection: collection(extendedCollections ? [groupMetadataModel] : []),
        }),
        WAWebLabelCollection: Object.freeze({ LabelCollection: collection(extendedCollections ? [Object.freeze({
          id: "label-1", name: "Synthetic Label",
        }), Object.freeze({id: "label-2", name: "Synthetic Item Label"})] : []) }),
        WAWebLabelItemCollection: Object.freeze({
          LabelItemCollection: collection(extendedCollections ? [Object.freeze({
            id: "label-item-1", parentType: "chat", parentId: contact.id, labelId: "label-2",
          })] : []),
        }),
        WAWebPinInChatCollection: Object.freeze({
          PinInChatCollection: collection(extendedCollections ? [materializedPin] : []),
        }),
        WAWebPresenceCollection: Object.freeze({
          PresenceCollection: collection(extendedCollections ? [Object.freeze({
            id: contact.id,
            isOnline: true,
            chatstates: collection([Object.freeze({
              id: contact.id, type: "composing", t: 1_700_000_010,
            })]),
          })] : []),
        }),
        WAWebReactionsCollection: Object.freeze({ ReactionsCollection: reactionCollection }),
        WAWebMsgInfoCollection: Object.freeze({ MsgInfoCollection: messageInfoCollection }),
      };
      if (!Object.hasOwn(modules, name)) {
        throw new Error("unexpected module");
      }
      return modules[name];
    };
  }
  return {
    page,
    moduleCalls,
    historyCallCount() {
      return historyCalls;
    },
    dbHistoryCallCount() {
      return dbHistoryCalls;
    },
    switchAccount() {
      currentAccount = alternateAccount;
    },
    resolveMediaDownload() {
      assert.equal(typeof resolveMediaDownload, "function");
      resolveMediaDownload();
    },
    mediaDownloadAttemptCount() {
      return mediaDownloadAttempts;
    }
  };
}

{
  const fixture = fixtureWindow(true, false, true, false, true);
  const { page } = fixture;
  const controller = evaluate(page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch(request("start_comprehensive"))).ok, true);
  const frames = [];
  for (;;) {
    const frame = await controller.next();
    assert.ok(frame);
    checkFrame(frame);
    frames.push(frame);
    assert.equal(controller.ack(frame.sequence), true);
    if (frame.kind === "stream_end" || frame.kind === "error") break;
  }
  assert.equal(frames.at(-1).kind, "stream_end");
  const end = JSON.parse(frames.at(-1).payload);
  assert.deepEqual(Object.keys(end.totals).sort(), [
    "accounts", "calls", "channelEvents", "channels", "chatLists", "chats",
    "communities", "communityRelations", "contacts", "groupEvents", "messageEvents",
    "messages", "participants", "pollVotes", "presenceSnapshots", "reactions",
    "receipts", "statuses",
  ].sort());
  assert.equal("chat_lists" in end.totals, false);
  assert.equal("message_events" in end.totals, false);
  assert.equal(fixture.historyCallCount(), 3, JSON.stringify(end));
  const messageRecords = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload))
    .filter((batch) => batch.dataset === "messages")
    .flatMap((batch) => batch.records);
  assert.deepEqual(
    messageRecords.map((record) => record.id).sort(),
    ["false_100000000000002@c.us_HISTORY_ONLY", "false_100000000000002@c.us_TEST"],
    "history loader return values must be merged even when the live collection is not mutated",
  );
  assert.equal(end.totals.messages, 2);
  assert.equal(end.completeness.historyScope, "stable_no_growth");
}

{
  const fixture = fixtureWithAdapterVariants({historyResultEnvelope: true}, true);
  const frames = await collectOperationFrames(fixture, "start_comprehensive");
  const end = JSON.parse(frames.at(-1).payload);
  const messages = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload))
    .filter((batch) => batch.dataset === "messages")
    .flatMap((batch) => batch.records);
  assert.equal(end.totals.messages, 2);
  assert.ok(messages.some((record) => record.body === "synthetic returned-only history"));
}

{
  const fixture = fixtureWithAdapterVariants({quotedByStanza: true}, true);
  const frames = await collectOperationFrames(fixture, "start_comprehensive");
  const messages = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload))
    .filter((batch) => batch.dataset === "messages")
    .flatMap((batch) => batch.records);
  const quoting = messages.find((record) => record.body === "synthetic message");
  assert.equal(
    quoting.quotedMessageId,
    "false_100000000000002@c.us_HISTORY_ONLY",
  );
}

{
  const fixture = fixtureWithAdapterVariants({quotedByStanza: true});
  const frames = await collectOperationFrames(fixture, "start_t0");
  const messages = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload))
    .filter((batch) => batch.dataset === "messages")
    .flatMap((batch) => batch.records);
  assert.match(messages[0].quotedMessageId, /^unresolved_quote:/);
}

{
  const fixture = fixtureWithAdapterVariants({globalMessageOnly: true});
  const frames = await collectOperationFrames(fixture, "start_t0");
  const end = JSON.parse(frames.at(-1).payload);
  const messages = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload))
    .filter((batch) => batch.dataset === "messages")
    .flatMap((batch) => batch.records);
  assert.equal(end.totals.messages, 1);
  assert.equal(messages[0].body, "synthetic message");
}

{
  const fixture = fixtureWithAdapterVariants({
    globalMessageOnly: true,
    chatMessagesCollectionAbsent: true,
  });
  const frames = await collectOperationFrames(fixture, "start_t0");
  const end = JSON.parse(frames.at(-1).payload);
  const messages = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload))
    .filter((batch) => batch.dataset === "messages")
    .flatMap((batch) => batch.records);
  assert.equal(end.totals.messages, 1);
  assert.equal(messages[0].body, "synthetic message");
}

{
  const fixture = fixtureWithAdapterVariants({
    globalMessageOnly: true,
    chatMessagesCollectionAbsent: true,
    globalSpecialOnly: true,
  });
  const frames = await collectOperationFrames(fixture, "start_t0");
  const batches = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload));
  const records = (dataset) => batches
    .filter((batch) => batch.dataset === dataset)
    .flatMap((batch) => batch.records);
  assert.equal(records("messages").length, 1);
  assert.equal(records("statuses").length, 1);
  assert.equal(records("statuses")[0].body, "synthetic global-only status");
  assert.equal(records("channel_events").length, 1);
  assert.equal(
    records("channel_events")[0].body,
    "synthetic global-only channel event",
  );
  assert.equal(records("channels").length, 1);
  assert.equal(records("channels")[0].id, "120363000000009@newsletter");
}

{
  const fixture = fixtureWithAdapterVariants({mediaCapability: false});
  const frames = await collectOperationFrames(fixture, "start_comprehensive");
  const end = JSON.parse(frames.at(-1).payload);
  assert.equal(end.completeness.historyScope, "stable_no_growth");
  assert.equal(end.media.requested, 0);
}

{
  const fixture = fixtureWithAdapterVariants({historyCapability: false}, false, true);
  const frames = await collectOperationFrames(fixture, "start_comprehensive");
  const end = JSON.parse(frames.at(-1).payload);
  assert.equal(end.completeness.historyScope, "loader_error");
  assert.equal(end.media.requested, 1);
  assert.equal(end.media.available, 1);
}

{
  const fixture = fixtureWithAdapterVariants({materializedEvents: true});
  const frames = await collectOperationFrames(fixture, "start_t0");
  const batches = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload));
  const reactions = batches
    .filter((batch) => batch.dataset === "reactions")
    .flatMap((batch) => batch.records);
  const receipts = batches
    .filter((batch) => batch.dataset === "receipts")
    .flatMap((batch) => batch.records);
  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].marker, "👍");
  assert.equal(reactions[0].subjectIds[0], "false_100000000000002@c.us_TEST");
  assert.deepEqual(receipts.map((record) => record.state).sort(), [
    "delivered", "played", "read",
  ]);
}

{
  const fixture = fixtureWithAdapterVariants({modernMessageFields: true});
  const frames = await collectOperationFrames(fixture, "start_t0");
  const batches = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload));
  const messages = batches
    .filter((batch) => batch.dataset === "messages")
    .flatMap((batch) => batch.records);
  const events = batches
    .filter((batch) => batch.dataset === "message_events")
    .flatMap((batch) => batch.records);
  const pollVotes = batches
    .filter((batch) => batch.dataset === "poll_votes")
    .flatMap((batch) => batch.records);
  const modern = messages.find((record) => record.body === "synthetic message");
  assert.equal(modern.senderId, "100000000000002@c.us");
  assert.equal(modern.hasMedia, true, "native media type is evidence even before mediaData materializes");
  assert.equal(modern.isEdited, true);
  assert.equal(modern.latitude, 30.25);
  assert.equal(modern.longitude, 120.5);
  assert.equal(modern.locationName, "Synthetic Location");
  assert.equal(modern.pollName, "Synthetic Poll");
  assert.equal(modern.pollSelectableCount, 2);
  assert.ok(events.some((event) => event.eventKind === "message_edited"
    && event.subjectIds[0] === modern.id));
  assert.equal(pollVotes.length, 1);
  assert.equal(pollVotes[0].subjectIds[0], modern.id);
  assert.equal(pollVotes[0].actorIds[0], "100000000000002@c.us");
}

{
  const fixture = fixtureWithAdapterVariants({
    modernMessageFields: true,
    binaryMediaBody: true,
  });
  const frames = await collectOperationFrames(fixture, "start_t0");
  const messages = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload))
    .filter((batch) => batch.dataset === "messages")
    .flatMap((batch) => batch.records);
  assert.equal(messages.length, 2);
  const media = messages.find((record) => record.type === "image");
  assert.equal(media.body, null, "an encoded preview must not become chat text");
  assert.equal(media.caption, "Synthetic media caption");
  assert.deepEqual(media.unsupportedReasonCodes, ["media_inline_preview_omitted"]);
  const end = JSON.parse(frames.at(-1).payload);
  assert.ok(end.completeness.reasons.includes("media_inline_preview_omitted"));
}

{
  const fixture = fixtureWithAdapterVariants({extendedCollections: true});
  const frames = await collectOperationFrames(fixture, "start_t0");
  const batches = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload));
  const records = (dataset) => batches
    .filter((batch) => batch.dataset === dataset)
    .flatMap((batch) => batch.records);

  assert.equal(records("accounts")[0].verifiedName, "Synthetic Verified Account");
  const contactRecord = records("contacts")
    .find((record) => record.id === "100000000000002@c.us");
  assert.equal(contactRecord.about, "Synthetic About");
  assert.equal(contactRecord.verifiedName, "Synthetic Verified Contact");
  assert.equal(contactRecord.isVerified, true);
  assert.equal(contactRecord.isDeactivated, false);

  const groupRecord = records("chats")
    .find((record) => record.id === "100000000000003@g.us");
  assert.equal(groupRecord.participantCount, 1);
  assert.equal(groupRecord.isCommunity, true,
    "standalone GroupMetadataCollection must enrich an otherwise sparse chat model");
  assert.equal(records("participants").length, 2);
  assert.equal(records("participants")
    .find((record) => record.subjectId === "100000000000002@c.us").role, "admin");
  const formerMember = records("participants")
    .find((record) => record.subjectId === "100000000000004@c.us");
  assert.equal(formerMember.membershipState, "removed");
  assert.equal(formerMember.leftTimestamp, 1_660_000_000);
  assert.equal(records("communities").length, 1);
  assert.equal(records("communities")[0].description, "Synthetic Community Description");
  assert.equal(records("communities")[0].creationTimestamp, 1_640_000_000);

  const chatLists = records("chat_lists");
  assert.deepEqual(chatLists.map((record) => record.listKind).sort(), ["custom", "custom", "favorites"]);
  assert.equal(chatLists.find((record) => record.listKind === "custom").name, "Synthetic Label");
  assert.deepEqual(chatLists.find((record) => record.listKind === "custom").chatIds,
    ["100000000000002@c.us"]);
  assert.deepEqual(chatLists.find((record) => record.name === "Synthetic Item Label").chatIds,
    ["100000000000002@c.us"]);

  const pin = records("message_events")
    .find((record) => record.eventKind === "message_pin_observed");
  assert.equal(pin.subjectIds[0], "false_100000000000002@c.us_TEST");
  assert.equal(pin.actorIds[0], "100000000000001@c.us");
  assert.equal(pin.state, "1", "unknown native pin type must be preserved without guessing semantics");
  assert.equal(records("statuses")[0].body, "synthetic visible status");
  assert.equal(records("calls")[0].nativeType, "ended");
  assert.deepEqual(records("calls")[0].actorIds, ["100000000000002@c.us"]);
  assert.equal(records("calls")[0].numericValue, 42);
  const channel = records("channels")[0];
  assert.equal(channel.displayName, "Synthetic Channel");
  assert.equal(channel.description, "Synthetic Channel Description");
  assert.equal(channel.membershipState, "active");
  assert.equal(channel.creationTimestamp, 1_630_000_000);
  const presence = records("presence_snapshots");
  assert.equal(presence.length, 2);
  assert.ok(presence.some((record) => record.nativeType === "presence" && record.state === "online"));
  assert.ok(presence.some((record) => record.nativeType === "chatstate" && record.state === "composing"));
}

{
  const fixture = fixtureWithAdapterVariants({dbHistoryFallback: true});
  const frames = await collectOperationFrames(fixture, "start_comprehensive");
  const end = JSON.parse(frames.at(-1).payload);
  const chatRecords = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload))
    .filter((batch) => batch.dataset === "chats")
    .flatMap((batch) => batch.records);
  assert.equal(end.totals.messages, 2);
  assert.equal(end.completeness.historyScope, "stable_no_growth");
  assert.ok(fixture.dbHistoryCallCount() >= 2);
  assert.equal(
    chatRecords[0].historyReasonCode,
    "stable_no_growth_after_local_database_fallback",
  );
}

{
  const fixture = fixtureWithAdapterVariants({expectedButUnobservable: true});
  const frames = await collectOperationFrames(fixture, "start_comprehensive");
  const end = JSON.parse(frames.at(-1).payload);
  assert.equal(end.totals.messages, 0);
  assert.equal(end.completeness.localSnapshot, "partial");
  assert.equal(end.completeness.historyScope, "loader_error");
  assert.ok(end.completeness.reasons.includes("chat_expected_messages_unobservable_omitted"));
}

{
  const fixture = fixtureWindow(
    true, false, true, false, true, false, false, false, false, true,
  );
  const controller = evaluate(fixture.page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch(request("start_comprehensive"))).ok, true);
  const frames = [];
  for (;;) {
    const frame = await controller.next();
    assert.ok(frame);
    checkFrame(frame);
    frames.push(frame);
    assert.equal(controller.ack(frame.sequence), true);
    if (frame.kind === "stream_end" || frame.kind === "error") break;
  }
  const end = JSON.parse(frames.at(-1).payload);
  const messages = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload))
    .filter((batch) => batch.dataset === "messages")
    .flatMap((batch) => batch.records);
  const historyReference = messages.find((record) =>
    record.id === "false_100000000000002@c.us_HISTORY_ONLY");
  assert.ok(historyReference, "a bare MsgKey returned by the loader must not be silently dropped");
  assert.deepEqual(
    historyReference.unsupportedReasonCodes,
    ["message_model_fields_unavailable"],
  );
  assert.equal(end.totals.messages, 2);
  assert.equal(end.completeness.historyScope, "stable_no_growth");
}

{
  const fixture = fixtureWindow(
    true, false, true, false, false, false, false, false, false, false, true,
  );
  const controller = evaluate(fixture.page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch(request("start_t0"))).ok, true);
  const frames = [];
  for (;;) {
    const frame = await controller.next();
    assert.ok(frame);
    checkFrame(frame);
    frames.push(frame);
    assert.equal(controller.ack(frame.sequence), true);
    if (frame.kind === "stream_end" || frame.kind === "error") break;
  }
  const messages = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload))
    .filter((batch) => batch.dataset === "messages")
    .flatMap((batch) => batch.records);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, "synthetic message");
  assert.deepEqual(messages[0].unsupportedReasonCodes, []);
}

{
  const fixture = fixtureWindow(
    true, false, true, false, true, false, false, false, false, false, false, true,
  );
  const controller = evaluate(fixture.page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch(request("start_comprehensive"))).ok, true);
  const frames = [];
  for (;;) {
    const frame = await controller.next();
    assert.ok(frame);
    checkFrame(frame);
    frames.push(frame);
    assert.equal(controller.ack(frame.sequence), true);
    if (frame.kind === "stream_end" || frame.kind === "error") break;
  }
  const end = JSON.parse(frames.at(-1).payload);
  assert.equal(end.completeness.historyScope, "loader_error");
  assert.ok(end.completeness.reasons.includes("history_loader_error"));
  assert.ok(end.completeness.reasons.includes("message_native_id_unavailable_omitted"));
}

{
  const { page } = fixtureWindow(true, false, false);
  const controller = evaluate(page);
  const probeDispatch = await controller.dispatch(request("probe"));
  assert.equal(probeDispatch.ok, true);
  const probe = await controller.next();
  checkFrame(probe);
  const payload = JSON.parse(probe.payload);
  assert.equal(payload.supported, false);
  assert.equal(payload.adapterId, null);
  assert.equal(payload.accountBindingSha256, null);
  assert.deepEqual(payload.reasons, ["account_reader_signature_mismatch"]);
  assert.equal(payload.capabilities.passiveT0, false);
  assert.equal(payload.capabilities.accounts, false);
  assert.equal(controller.ack(probe.sequence), true);
  const start = await controller.dispatch(request("start_t0"));
  assert.equal(start.ok, false);
  assert.equal(start.code, "unsupported_build");
}

function evaluate(page, DateConstructor = Date) {
  return vm.runInNewContext(source, {
    window: page,
    TextEncoder,
    Date: DateConstructor,
    Object,
    Array,
    Boolean,
    Error,
    Map,
    Math,
    Number,
    Reflect,
    RegExp,
    Set,
    setTimeout,
    clearTimeout,
    String,
    Uint8Array,
    ArrayBuffer,
    Blob,
    URL,
    atob,
    btoa,
  });
}

function checkFrame(frame) {
  assert.equal(frame.protocol, "wafc-bridge/2");
  assert.match(frame.sequence, /^(0|[1-9][0-9]*)$/);
  assert.ok(["utf8_json", "base64"].includes(frame.encoding));
  const bytes = frame.encoding === "base64"
    ? Buffer.from(frame.payload, "base64")
    : new TextEncoder().encode(frame.payload);
  assert.equal(frame.payloadBytes, bytes.byteLength);
  assert.equal(
    frame.payloadSha256,
    createHash("sha256").update(bytes).digest("hex")
  );
  assert.ok(Object.isFrozen(frame));
}

async function nextWithin(controller, milliseconds = 100) {
  return Promise.race([
    controller.next(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("non-blocking bridge poll timed out")),
      milliseconds,
    )),
  ]);
}

async function collectOperationFrames(fixture, command) {
  const controller = evaluate(fixture.page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  checkFrame(probe);
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch(request(command))).ok, true);
  const frames = [];
  for (;;) {
    const frame = await controller.next();
    assert.ok(frame);
    checkFrame(frame);
    frames.push(frame);
    assert.equal(controller.ack(frame.sequence), true);
    if (frame.kind === "stream_end" || frame.kind === "error") return frames;
  }
}

function fixtureWithAdapterVariants(
  adapterVariants,
  historyReturnedOnly = false,
  comprehensiveMedia = false,
) {
  return fixtureWindow(
    true, false, true, comprehensiveMedia, historyReturnedOnly, false, false, false,
    false, false, false, false, false, adapterVariants,
  );
}

{
  const { page, moduleCalls } = fixtureWindow(true);
  const keysBefore = Object.keys(page).sort();
  const controller = evaluate(page);
  assert.deepEqual(Object.keys(page).sort(), keysBefore);
  assert.ok(Object.isFrozen(controller));
  const unsupportedCommand = await controller.dispatch(request("anything"));
  assert.equal(unsupportedCommand.ok, false);
  assert.equal(unsupportedCommand.code, "unsupported_command");
  const mismatchedProtocol = await controller.dispatch({
    ...request("probe"),
    controllerVersion: "0.2.3",
  });
  assert.equal(mismatchedProtocol.ok, false);
  assert.equal(mismatchedProtocol.code, "protocol_mismatch");

  const probeDispatch = await controller.dispatch(request("probe"));
  assert.equal(probeDispatch.ok, true);
  const probe = await controller.next();
  checkFrame(probe);
  assert.strictEqual(await controller.next(), probe);
  const probePayload = JSON.parse(probe.payload);
  assert.equal(probePayload.supported, true);
  assert.equal(probePayload.adapterId, "wa-private-collections-v2");
  assert.match(probePayload.accountBindingSha256, /^[0-9a-f]{64}$/);
  assert.equal(probePayload.capabilities.networkActions, true);
  assert.equal(probePayload.capabilities.comprehensiveReadonlyV02, true);
  assert.equal(probePayload.capabilities.datasets.length, 18);
  assert.equal(controller.ack("1"), false);
  assert.equal(controller.ack("0"), true);
  assert.equal(controller.ack("0"), true);

  const start = await controller.dispatch(request("start_t0"));
  assert.equal(start.ok, true);
  const frames = [];
  for (;;) {
    const frame = await controller.next();
    if (frame === null) {
      break;
    }
    checkFrame(frame);
    frames.push(frame);
    assert.equal(controller.ack(frame.sequence), true);
    if (frame.kind === "stream_end" || frame.kind === "error") {
      break;
    }
  }
  assert.equal(frames[0].kind, "stream_start");
  assert.equal(frames.at(-1).kind, "stream_end");
  const batches = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload));
  assert.deepEqual(
    batches.map((batch) => batch.dataset),
    ["accounts", "contacts", "chats", "messages"]
  );
  const streamStart = JSON.parse(frames[0].payload);
  const streamEnd = JSON.parse(frames.at(-1).payload);
  assert.equal(
    batches[0].accountBindingSha256,
    probePayload.accountBindingSha256
  );
  assert.equal(streamStart.accountBindingSha256, probePayload.accountBindingSha256);
  assert.equal(streamEnd.accountBindingSha256, probePayload.accountBindingSha256);
  assert.ok(batches.slice(1).every((batch) => !("accountBindingSha256" in batch)));
  assert.ok(moduleCalls.includes("WAWebContactCollection"));
  assert.ok(moduleCalls.includes("WAWebChatLoadMessages"));
  assert.ok(moduleCalls.includes("WAWebMediaInMemoryBlobCache"));
  assert.equal(await controller.next(), null);
  const finalBindingCheck = await controller.checkAccountBinding();
  assert.equal(finalBindingCheck.ok, true);
  assert.equal(finalBindingCheck.accountBindingSha256, probePayload.accountBindingSha256);
}

{
  const { page, switchAccount } = fixtureWindow(true);
  const controller = evaluate(page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch(request("start_t0"))).ok, true);
  const streamStart = await controller.next();
  assert.equal(streamStart.kind, "stream_start");
  assert.equal(controller.ack(streamStart.sequence), true);
  switchAccount();
  const failure = await controller.next();
  assert.equal(failure.kind, "error");
  assert.equal(JSON.parse(failure.payload).code, "snapshot_failed");
  assert.equal(JSON.parse(failure.payload).message, "snapshot_failed");
  assert.equal(controller.ack(failure.sequence), true);
  const changedBindingCheck = await controller.checkAccountBinding();
  assert.equal(changedBindingCheck.ok, false);
  assert.equal(changedBindingCheck.code, "account_identity_changed");
}

{
  const first = evaluate(fixtureWindow(true).page);
  const second = evaluate(fixtureWindow(true).page);
  assert.equal((await first.dispatch(request("probe"))).ok, true);
  assert.equal((await second.dispatch(request("probe"))).ok, true);
  const firstProbe = await first.next();
  const secondProbe = await second.next();
  const firstBinding = JSON.parse(firstProbe.payload).accountBindingSha256;
  const secondBinding = JSON.parse(secondProbe.payload).accountBindingSha256;
  assert.match(firstBinding, /^[0-9a-f]{64}$/);
  assert.match(secondBinding, /^[0-9a-f]{64}$/);
  assert.notEqual(
    firstBinding,
    secondBinding,
    "per-controller private random secret must prevent cross-run linkability"
  );
  assert.equal(first.ack(firstProbe.sequence), true);
  assert.equal(second.ack(secondProbe.sequence), true);
}

{
  const { page, moduleCalls } = fixtureWindow(false);
  const controller = evaluate(page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  checkFrame(probe);
  assert.equal(JSON.parse(probe.payload).supported, false);
  assert.equal(controller.ack("0"), true);
  const unsupportedBuild = await controller.dispatch(request("start_t0"));
  assert.equal(unsupportedBuild.ok, false);
  assert.equal(unsupportedBuild.code, "unsupported_build");
  assert.deepEqual(moduleCalls, []);
}

{
  const { page, moduleCalls } = fixtureWindow(true);
  delete page.Debug;
  const controller = evaluate(page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  const payload = JSON.parse(probe.payload);
  assert.equal(payload.supported, false);
  assert.deepEqual(payload.reasons, ["unknown_build"]);
  assert.deepEqual(moduleCalls, [], "an unreported build must stop before private module access");
}

{
  const page = {
    crypto: webcrypto,
    Debug: Object.freeze({ VERSION: "synthetic-test-build" }),
    require() {
      throw new Error("SECRET-JID-100000000000001@c.us");
    }
  };
  const controller = evaluate(page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  const payload = JSON.parse(probe.payload);
  assert.equal(payload.supported, false);
  assert.deepEqual(payload.reasons, ["adapter_probe_failed"]);
  assert.equal(probe.payload.includes("SECRET-JID"), false);
}

{
  const { page } = fixtureWindow(true, true);
  const controller = evaluate(page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch(request("start_t0"))).ok, true);
  let terminal = null;
  for (;;) {
    const frame = await controller.next();
    assert.ok(frame);
    if (frame.kind === "stream_end" || frame.kind === "error") {
      terminal = frame;
      break;
    }
    assert.equal(controller.ack(frame.sequence), true);
  }
  assert.equal(terminal.kind, "stream_end");
  assert.equal(terminal.payload.includes("SECRET-JID"), false);
}

{
  const { page } = fixtureWindow(true, false, true, true);
  const controller = evaluate(page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch(request("start_comprehensive"))).ok, true);
  const frames = [];
  for (;;) {
    const frame = await controller.next();
    assert.ok(frame);
    checkFrame(frame);
    frames.push(frame);
    assert.equal(controller.ack(frame.sequence), true);
    if (frame.kind === "stream_end" || frame.kind === "error") break;
  }
  assert.equal(frames.at(-1).kind, "stream_end");
  assert.ok(frames.some((frame) => frame.kind === "progress"));
  assert.ok(frames.some((frame) => frame.kind === "media_start"));
  assert.ok(frames.some((frame) => frame.kind === "media_chunk"));
  assert.ok(frames.some((frame) => frame.kind === "media_end"));
  const end = JSON.parse(frames.at(-1).payload);
  assert.equal(end.operation, "comprehensive_readonly_v02");
  assert.equal(end.media.requested, 1);
  assert.equal(end.media.available, 1);
  assert.equal(end.completeness.mediaScope, "complete");
}

{
  const fixture = fixtureWithAdapterVariants({profileAvatars: true});
  const frames = await collectOperationFrames(fixture, "start_comprehensive");
  const batches = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload));
  const accounts = batches
    .filter((batch) => batch.dataset === "accounts")
    .flatMap((batch) => batch.records);
  const contacts = batches
    .filter((batch) => batch.dataset === "contacts")
    .flatMap((batch) => batch.records);
  assert.equal(accounts[0].profileImageAvailable, true);
  assert.equal(
    contacts.find((record) => record.id === "100000000000002@c.us")
      .profileImageAvailable,
    true,
  );

  const mediaStarts = frames
    .filter((frame) => frame.kind === "media_start")
    .map((frame) => JSON.parse(frame.payload));
  const mediaEnds = frames
    .filter((frame) => frame.kind === "media_end")
    .map((frame) => JSON.parse(frame.payload));
  assert.deepEqual(
    mediaStarts.map((payload) => payload.assetKey).sort(),
    [
      "account:100000000000001@c.us:avatar",
      "contact:100000000000002@c.us:avatar",
    ],
  );
  assert.ok(mediaStarts.every((payload) => payload.role === "avatar"));
  assert.ok(mediaStarts.every((payload) => payload.kind === "image"));
  assert.equal(mediaEnds.length, 2);
  assert.ok(mediaEnds.every((payload) => payload.status === "available"));
  const end = JSON.parse(frames.at(-1).payload);
  assert.equal(end.media.requested, 2);
  assert.equal(end.media.available, 2);
  assert.equal(end.completeness.mediaScope, "complete");
  const serializedFrames = JSON.stringify(frames);
  assert.equal(serializedFrames.includes("pps.whatsapp.net"), false);
  assert.equal(serializedFrames.includes("synthetic-account-avatar"), false);
  assert.equal(serializedFrames.includes("synthetic-contact-avatar"), false);
}

{
  const { page } = fixtureWindow(true, false, true, false, false, true);
  const controller = evaluate(page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch(request("start_comprehensive"))).ok, true);
  const frames = [];
  for (;;) {
    const frame = await controller.next();
    assert.ok(frame);
    checkFrame(frame);
    frames.push(frame);
    assert.equal(controller.ack(frame.sequence), true);
    if (frame.kind === "stream_end" || frame.kind === "error") break;
  }
  assert.equal(frames.at(-1).kind, "stream_end");
  const end = JSON.parse(frames.at(-1).payload);
  assert.equal(end.totals.messages, 1);
  assert.equal(end.completeness.localSnapshot, "partial");
  assert.ok(end.completeness.reasons.includes("message_native_id_unavailable_omitted"));
}

{
  const { page } = fixtureWindow(true, false, true, false, false, false, true);
  const controller = evaluate(page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch(request("start_t0"))).ok, true);
  const frames = [];
  for (;;) {
    const frame = await controller.next();
    assert.ok(frame);
    checkFrame(frame);
    frames.push(frame);
    assert.equal(controller.ack(frame.sequence), true);
    if (frame.kind === "stream_end" || frame.kind === "error") break;
  }
  assert.equal(frames.at(-1).kind, "stream_end");
  const messageRecords = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload))
    .filter((batch) => batch.dataset === "messages")
    .flatMap((batch) => batch.records);
  assert.equal(messageRecords.length, 1);
  assert.equal(
    messageRecords[0].id,
    "to_me_100000000000002@c.us_no_participant_TEST",
  );
}

{
  const fixture = fixtureWindow(true, false, true, true, false, false, false, true);
  const controller = evaluate(fixture.page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch(request("start_comprehensive"))).ok, true);

  let mediaStart = null;
  for (;;) {
    const frame = await nextWithin(controller);
    assert.ok(frame);
    checkFrame(frame);
    assert.equal(controller.ack(frame.sequence), true);
    if (frame.kind === "media_start") {
      mediaStart = JSON.parse(frame.payload);
      break;
    }
  }
  assert.equal(mediaStart.attempts, 0);
  assert.equal(mediaStart.networkActionAttempted, false);

  let cacheMiss = null;
  for (let polls = 0; polls < 4; polls += 1) {
    const frame = await nextWithin(controller);
    assert.equal(frame.kind, "progress");
    const payload = JSON.parse(frame.payload);
    assert.equal(controller.ack(frame.sequence), true);
    if (payload.statusCode === "media_cache_miss") {
      cacheMiss = payload;
      break;
    }
  }
  assert.ok(cacheMiss, "Adapter must report cache miss without blocking next()");
  assert.equal(controller.controlMedia({action: "begin_download"}), true);

  const waiting = await nextWithin(controller);
  assert.equal(waiting.kind, "progress");
  assert.ok([
    "media_requesting_download",
    "media_waiting_download",
  ].includes(JSON.parse(waiting.payload).statusCode));
  assert.equal(controller.ack(waiting.sequence), true);

  fixture.resolveMediaDownload();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const remaining = [];
  for (;;) {
    const frame = await nextWithin(controller);
    remaining.push(frame.kind);
    assert.equal(controller.ack(frame.sequence), true);
    if (frame.kind === "stream_end" || frame.kind === "error") break;
  }
  assert.ok(remaining.includes("media_chunk"));
  assert.ok(remaining.includes("media_end"));
  assert.equal(remaining.at(-1), "stream_end");
}

{
  const fixture = fixtureWindow(
    true, false, true, true, false, false, false, false, true,
  );
  const controller = evaluate(fixture.page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch(request("start_comprehensive"))).ok, true);

  const mediaEnds = [];
  let terminal = null;
  for (let polls = 0; polls < 200; polls += 1) {
    const frame = await nextWithin(controller);
    checkFrame(frame);
    if (frame.kind === "progress") {
      const payload = JSON.parse(frame.payload);
      if (payload.statusCode === "media_cache_miss") {
        assert.equal(controller.ack(frame.sequence), true);
        assert.equal(controller.controlMedia({action: "begin_download"}), true);
        continue;
      }
      if (payload.statusCode === "media_retrying") {
        assert.equal(controller.ack(frame.sequence), true);
        assert.equal(controller.controlMedia({action: "retry_current"}), true);
        continue;
      }
    }
    if (frame.kind === "media_end") mediaEnds.push(JSON.parse(frame.payload));
    assert.equal(controller.ack(frame.sequence), true);
    if (frame.kind === "stream_end" || frame.kind === "error") {
      terminal = frame;
      break;
    }
  }
  assert.ok(terminal, "two-media acquisition must reach a terminal frame");
  assert.equal(terminal.kind, "stream_end");
  assert.equal(mediaEnds.length, 2);
  const mediaByAssetKey = new Map(mediaEnds.map((payload) => [payload.assetKey, payload]));
  const failedMedia = mediaByAssetKey.get(
    "message:false_100000000000002@c.us_TEST:full",
  );
  const availableMedia = mediaByAssetKey.get(
    "message:false_100000000000002@c.us_TEST_2:full",
  );
  assert.equal(failedMedia.status, "unavailable");
  assert.equal(failedMedia.attempts, 2);
  assert.equal(availableMedia.status, "available");
  const end = JSON.parse(terminal.payload);
  assert.equal(end.media.requested, 2);
  assert.equal(end.media.available, 1);
  assert.equal(end.media.unavailable, 1);
  assert.equal(end.completeness.mediaScope, "partial");
}

{
  const fixture = fixtureWindow(
    true, false, true, true, false, false, false, false, false,
    false, false, false, true,
  );
  const controller = evaluate(fixture.page);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch(request("start_comprehensive"))).ok, true);

  let mediaEnd = null;
  let terminal = null;
  for (let polls = 0; polls < 200; polls += 1) {
    const frame = await nextWithin(controller);
    checkFrame(frame);
    if (frame.kind === "progress") {
      const payload = JSON.parse(frame.payload);
      if (payload.statusCode === "media_cache_miss") {
        assert.equal(controller.ack(frame.sequence), true);
        assert.equal(controller.controlMedia({action: "begin_download"}), true);
        continue;
      }
      if (payload.statusCode === "media_retrying") {
        assert.equal(controller.ack(frame.sequence), true);
        assert.equal(controller.controlMedia({action: "retry_current"}), true);
        continue;
      }
    }
    if (frame.kind === "media_end") mediaEnd = JSON.parse(frame.payload);
    assert.equal(controller.ack(frame.sequence), true);
    if (frame.kind === "stream_end" || frame.kind === "error") {
      terminal = frame;
      break;
    }
  }
  assert.ok(terminal, "retry-success acquisition must reach a terminal frame");
  assert.equal(terminal.kind, "stream_end");
  assert.equal(fixture.mediaDownloadAttemptCount(), 2);
  assert.equal(mediaEnd.status, "available");
  assert.equal(mediaEnd.attempts, 2);
  assert.equal(mediaEnd.networkActionAttempted, true);
  const end = JSON.parse(terminal.payload);
  assert.equal(end.media.requested, 1);
  assert.equal(end.media.available, 1);
  assert.equal(end.completeness.mediaScope, "complete");
}

{
  let syntheticNow = 1_700_000_000_000;
  class SyntheticDate extends Date {
    constructor(...args) {
      super(...(args.length === 0 ? [syntheticNow] : args));
    }

    static now() {
      return syntheticNow;
    }
  }
  const fixture = fixtureWindow(
    true, false, true, true, false, false, false, true,
  );
  const controller = evaluate(fixture.page, SyntheticDate);
  assert.equal((await controller.dispatch(request("probe"))).ok, true);
  const probe = await controller.next();
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch(request("start_comprehensive"))).ok, true);

  let downloadStarted = false;
  for (let polls = 0; polls < 100; polls += 1) {
    const frame = await nextWithin(controller);
    checkFrame(frame);
    if (frame.kind === "progress") {
      const payload = JSON.parse(frame.payload);
      assert.equal(controller.ack(frame.sequence), true);
      if (payload.statusCode === "media_cache_miss") {
        assert.equal(controller.controlMedia({action: "begin_download"}), true);
        downloadStarted = true;
        break;
      }
      continue;
    }
    assert.equal(controller.ack(frame.sequence), true);
  }
  assert.equal(downloadStarted, true);
  await Promise.resolve();

  syntheticNow += 40_000;
  const afterFortySeconds = await nextWithin(controller);
  assert.equal(afterFortySeconds.kind, "progress");
  const afterFortyPayload = JSON.parse(afterFortySeconds.payload);
  assert.ok([
    "media_requesting_download",
    "media_waiting_download",
  ].includes(afterFortyPayload.statusCode));
  assert.ok(afterFortyPayload.elapsedMs >= 40_000);
  assert.equal(controller.ack(afterFortySeconds.sequence), true);

  syntheticNow += 260_000;
  const afterFiveMinutes = await nextWithin(controller);
  assert.equal(afterFiveMinutes.kind, "progress");
  const afterFivePayload = JSON.parse(afterFiveMinutes.payload);
  assert.equal(afterFivePayload.statusCode, "media_waiting_download");
  assert.ok(afterFivePayload.elapsedMs >= 300_000);
  assert.equal(controller.ack(afterFiveMinutes.sequence), true);

  fixture.resolveMediaDownload();
  await new Promise((resolve) => setTimeout(resolve, 0));
  let terminal = null;
  for (let polls = 0; polls < 100; polls += 1) {
    const frame = await nextWithin(controller);
    assert.equal(controller.ack(frame.sequence), true);
    if (frame.kind === "stream_end" || frame.kind === "error") {
      terminal = frame;
      break;
    }
  }
  assert.ok(terminal, "synthetic five-minute media wait must finish after Blob readiness");
  assert.equal(terminal.kind, "stream_end");
}

console.log("collector bridge simulation: ok");
