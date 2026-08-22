import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../dist/collector.iife.js", import.meta.url), "utf8");
const mockStore = JSON.parse(
  await readFile(new URL("../../tests/fixtures/mock-store.json", import.meta.url), "utf8")
);

function load() {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    Blob,
    ArrayBuffer,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    ReadableStream,
    AbortController,
    URL,
    Event: class Event { constructor(type) { this.type = type; } },
    MouseEvent: class MouseEvent { constructor(type) { this.type = type; } },
    fetch: async () => { throw new Error("network disabled in tests"); },
    atob,
    btoa,
    crypto: globalThis.crypto,
    document: {
      getElementById() { return null; },
      querySelector() { return null; }
    }
  });
  context.globalThis = context;
  context.window = context;
  const controller = vm.runInContext(source, context, {timeout: 5_000});
  return {context, controller, FC: context.FieldCollectorExtractor};
}

test("capability report always covers every declared dataset", async () => {
  const {controller, FC} = load();
  const capabilities = await controller.dispatch({command: "probe"});
  assert.equal(Object.keys(capabilities.datasets).length, 22);
  assert.deepEqual(Object.keys(capabilities.datasets), Array.from(FC.DATASETS));
  assert.equal(capabilities.datasets.accounts.status, "unavailable");
  assert.equal(capabilities.features.media_decryption.status, "unavailable");
  assert.equal(capabilities.features.media_blob_cache.status, "unavailable");
});

test("raw snapshot preserves fields and marks cycles", () => {
  const {FC} = load();
  const raw = {id: "one", nested: {value: 2}};
  raw.self = raw;
  const snapshot = FC.rawSnapshot({toJSON: () => raw});
  assert.equal(snapshot.id, "one");
  assert.equal(snapshot.nested.value, 2);
  assert.equal(snapshot.self.__fieldCollectorType, "Reference");
});

test("raw snapshots omit undefined fields and declared repeated collections", () => {
  const {FC} = load();
  const snapshot = FC.rawSnapshot({id: "chat", unused: undefined, msgs: [{id: "m1"}]}, {
    omitKeys: FC.REPEATED_COLLECTION_KEYS
  });
  assert.equal(snapshot.id, "chat");
  assert.equal("unused" in snapshot, false);
  assert.equal("msgs" in snapshot, false);
  assert.deepEqual(Array.from(snapshot.__fieldCollectorOmittedKeys), ["msgs"]);
});

test("current WhatsApp message keys use the $1 serialized id fallback", () => {
  const {FC} = load();
  assert.equal(
    FC.idString({id: "stanza", $1: "false_chat@lid_stanza"}),
    "false_chat@lid_stanza"
  );
});

test("timestamps are normalized to UTC without inheriting the collector time zone", () => {
  const {FC} = load();
  assert.equal(FC.timestamp({t: 1_755_651_900}), "2025-08-20T01:05:00.000Z");
  assert.equal(FC.timestamp({t: "1755651900000"}), "2025-08-20T01:05:00.000Z");
  assert.equal(FC.timestamp({t: "2025-08-20T09:05:00+08:00"}), "2025-08-20T01:05:00.000Z");
  assert.equal(FC.timestamp({t: "2026-08-20 01:02:03"}), "2026-08-20T01:02:03.000Z");
  assert.equal(FC.timestampMillis({t: "1755651900"}), 1_755_651_900_000);
});

test("phone metadata normalizes phone WIDs and keeps device identity separately", () => {
  const {FC} = load();
  const phone = FC.phoneMetadata({_serialized: "8615396599307:4@c.us", user: "8615396599307", device: 4});
  assert.equal(phone.phoneId, "8615396599307@c.us");
  assert.equal(phone.phoneNumber, "8615396599307");
  assert.equal(phone.formattedPhoneNumber, "+8615396599307");
  assert.equal(phone.deviceId, "4");
  assert.equal(phone.devicePhoneId, "8615396599307:4@c.us");
});

test("LID contacts resolve to phone identities through WAWebApiContact", async () => {
  const {FC} = load();
  const lid = {id: {_serialized: "259567069958235@lid"}, formattedName: "JJ"};
  const identity = await FC.resolveContactIdentity(lid, {
    async contactPhoneNumber(id) {
      assert.equal(id._serialized, "259567069958235@lid");
      return {_serialized: "8615880921237@c.us"};
    }
  });
  assert.equal(identity.lidId, "259567069958235@lid");
  assert.equal(identity.phoneId, "8615880921237@c.us");
  assert.equal(identity.phoneNumber, "8615880921237");
  assert.equal(identity.phoneSource, "WAWebApiContact.getPhoneNumber");
});

test("current account uses MeUser phone identity and merges the proven LID sibling", async () => {
  const {FC} = load();
  const lid = {id: {_serialized: "45046355239082@lid"}, formattedName: "H", isMe: false};
  const pn = {id: {_serialized: "8615396599307@c.us"}, formattedName: "H", isMe: false};
  const env = {
    contactCollection: {getMeContact: () => lid},
    meUser: {getMaybeMeDevicePn: () => ({_serialized: "8615396599307:0@c.us", user: "8615396599307", device: 0})},
    contactPhoneNumber: id => id._serialized === "45046355239082@lid"
      ? Promise.resolve({_serialized: "8615396599307@c.us"})
      : null
  };
  const identities = await FC.collectContactIdentities([lid, pn], env);
  assert.equal(identities.index.get("8615396599307@c.us").id, "8615396599307@c.us");
  const account = await FC.accountRecord([lid, pn], identities, env);
  assert.equal(account.id, "8615396599307@c.us");
  assert.equal(account.lidId, "45046355239082@lid");
  assert.equal(account.phoneNumber, "8615396599307");
  assert.equal(account.deviceId, "0");
  assert.equal(account.devicePhoneId, "8615396599307:0@c.us");
  assert.equal(account.isMe, true);
  assert.equal(account.accountSource, "WAWebUserPrefsMeUser");
});

test("chat and participant records use native identity links without matching names", async () => {
  const {FC} = load();
  const lid = {id: {_serialized: "person@lid"}, formattedName: "Same"};
  const unrelated = {id: {_serialized: "8615000000000@c.us"}, formattedName: "Same"};
  const identities = await FC.collectContactIdentities([lid, unrelated], {});
  assert.equal(identities.index.get("person@lid").phoneId, null);
  const unresolved = FC.chatRecord({id: {_serialized: "person@lid"}, formattedTitle: "Same"}, identities.index);
  assert.equal(unresolved.phoneNumber, null);

  const linkedIdentity = {...identities.index.get("person@lid"), phoneId: "8615880921237@c.us", phoneNumber: "8615880921237", formattedPhoneNumber: "+8615880921237"};
  identities.index.set("person@lid", linkedIdentity);
  const chat = FC.chatRecord({id: {_serialized: "person@lid"}, formattedTitle: "Same"}, identities.index);
  assert.equal(chat.contactId, "person@lid");
  assert.equal(chat.formattedPhoneNumber, "+8615880921237");
  const participants = FC.participantsForChat({
    id: {_serialized: "group@g.us"},
    groupMetadata: {participants: {_models: [{id: {_serialized: "person@lid"}}]}}
  }, {}, identities.index);
  assert.equal(participants[0].phoneId, "8615880921237@c.us");
});

test("a chat-only LID resolves its phone and is added to the contact dataset", async () => {
  const {FC} = load();
  const identities = await FC.collectContactIdentities([], {});
  const chat = {
    id: {_serialized: "259567069958235@lid"},
    formattedTitle: "JJ"
  };
  const record = await FC.ensureChatContactIdentity(chat, identities, {
    contactPhoneNumber(id) {
      assert.equal(id._serialized, "259567069958235@lid");
      return {_serialized: "8615880921237@c.us"};
    }
  });
  assert.equal(record.phoneNumber, "8615880921237");
  assert.equal(identities.records.length, 1);
  assert.equal(identities.index.get("259567069958235@lid").formattedPhoneNumber, "+8615880921237");
  assert.equal(FC.chatRecord(chat, identities.index).phoneId, "8615880921237@c.us");
});

test("media payload bodies are omitted from compact message records", () => {
  const {FC} = load();
  const payload = "/9j/" + "A".repeat(512);
  const record = FC.messageRecord({
    id: {_serialized: "media-message"},
    type: "image",
    body: payload,
    mimetype: "image/jpeg"
  }, "chat@c.us");
  assert.equal(record.text, null);
  assert.equal("raw" in record, false);
});

test("outgoing messages keep the parent chat id instead of the local account id", () => {
  const {FC} = load();
  const record = FC.messageRecord({
    id: {_serialized: "outgoing-message"},
    from: {_serialized: "me@lid"},
    to: {_serialized: "family@g.us"},
    type: "chat",
    body: "hello"
  }, "family@g.us");
  assert.equal(record.chatId, "family@g.us");
  assert.equal(record.senderId, "me@lid");
  assert.equal(record.recipientId, "family@g.us");
});

test("dataset batches are bounded by record count and serialized size", () => {
  const {FC} = load();
  const records = Array.from({length: 101}, (_, id) => ({id, text: "x".repeat(32)}));
  const byCount = FC.datasetBatches(records, 1024 * 1024);
  assert.deepEqual(Array.from(byCount, batch => batch.length), [100, 1]);
  const bySize = FC.datasetBatches(records.slice(0, 3), 80);
  assert.ok(bySize.length > 1);
  assert.equal(bySize.flat().length, 3);
});

test("message collection deduplicates by stable message id", () => {
  const {FC} = load();
  const first = {id: {_serialized: "m1"}, t: 1};
  const duplicate = {id: {_serialized: "m1"}, t: 1, body: "newer view"};
  const chat = {id: {_serialized: "chat@c.us"}, msgs: {_models: [first, duplicate]}};
  const env = {chatCollection: {_models: [chat]}, msgGetters: {getId: item => item.id}};
  FC._activeEnv = env;
  const messages = new Map();
  assert.equal(FC.mergeChatMessages(chat, env, messages), 1);
  assert.equal(messages.size, 1);
  assert.equal(messages.get("m1").body, "newer view");
});

test("dynamic chat queue absorbs new chats and replaces native-id duplicates", () => {
  const {FC} = load();
  const first = {...mockStore.chats[0]};
  const refreshed = {...first, title: "Refreshed"};
  const second = {id: {_serialized: "second@c.us"}, title: "Same"};
  const env = {chatCollection: {_models: [first]}};
  const queue = [];
  const byId = new Map();
  assert.equal(FC.absorbChats(queue, byId, env), 1);
  env.chatCollection._models = [refreshed, second];
  assert.equal(FC.absorbChats(queue, byId, env), 1);
  assert.equal(queue.length, 2);
  assert.equal(queue[0], refreshed);
});

test("private collection readers support current WhatsApp internal Maps", () => {
  const {FC} = load();
  const first = {id: "call-1"};
  const second = {id: "call-2"};
  const wrapper = {minifiedPrivateKey: new Map([["one", first], ["two", second]])};
  assert.deepEqual(Array.from(FC.collectionValues(wrapper), item => item.id), ["call-1", "call-2"]);
  assert.equal(FC.collectionReadable(wrapper), true);
});

test("current status, call-log and newsletter module variants are detected", () => {
  const {context, FC} = load();
  const statusStore = {_models: []};
  const callStore = {privateCalls: new Map()};
  const channelStore = {_models: []};
  const metadataStore = {_models: []};
  const groupMetadataStore = {_models: []};
  const pinStore = {_models: []};
  const msgFindCallLog = async () => [];
  const modules = {
    WAWebStatusCollection: {StatusV3CollectionImpl: statusStore},
    WAWebCallCollection: {default: callStore},
    WAWebDBMessageFindLocal: {msgFindCallLog},
    WAWebNewsletterCollection: {default: channelStore},
    WAWebNewsletterMetadataCollection: {default: metadataStore},
    WAWebGroupMetadataCollection: {GroupMetadataCollectionImpl: groupMetadataStore},
    WAWebPinInChatCollection: {PinInChatCollectionImpl: pinStore},
    WAWebChatCollection: {ChatCollection: {_models: []}}
  };
  context.require = name => modules[name] || null;
  const detected = FC.detectModules();
  assert.equal(detected.env.statuses, statusStore);
  assert.equal(detected.env.calls, callStore);
  assert.equal(typeof detected.env.msgFindCallLog, "function");
  assert.equal(detected.env.channels, channelStore);
  assert.equal(detected.env.channelMetadata, metadataStore);
  assert.equal(detected.env.groupMetadata, groupMetadataStore);
  assert.equal(detected.env.pins, pinStore);
  assert.equal(detected.capabilities.datasets.calls.status, "supported");
  assert.equal(detected.capabilities.datasets.communities.status, "supported");
  assert.equal(detected.capabilities.datasets.pins.status, "supported");
});

test("communities fall back to group metadata and observed community events", () => {
  const {FC} = load();
  const parentId = "parent@g.us";
  const announcementId = "announcement@g.us";
  const childId = "child@g.us";
  const chats = [
    {id: {_serialized: parentId}, title: "Community"},
    {id: {_serialized: announcementId}, title: "Announcements"},
    {id: {_serialized: childId}, title: "Child"}
  ];
  const metadata = {
    _models: [
      {
        id: {_serialized: parentId}, isParentGroup: true,
        defaultSubgroup: {_serialized: announcementId},
        subgroups: [{id: {_serialized: announcementId}}, {id: {_serialized: childId}}]
      },
      {id: {_serialized: childId}, parentGroup: {_serialized: parentId}}
    ]
  };
  const result = FC.collectCommunities({chatCollection: {_models: chats}, groupMetadata: metadata}, [{
    chatId: announcementId,
    messages: [{
      id: {_serialized: "community-event"}, type: "gp2", subtype: "community_create",
      body: "Community", templateParams: [{_serialized: parentId}, "Community"]
    }]
  }]);
  assert.equal(result.status, "supported");
  assert.deepEqual(Array.from(result.records, record => record.id), [parentId]);
  assert.ok(result.relations.some(relation =>
    relation.relationKind === "community_announcement_group"
      && relation.fromId === parentId && relation.toId === announcementId));
  assert.ok(result.relations.some(relation =>
    relation.relationKind === "community_child_group"
      && relation.fromId === parentId && relation.toId === childId));
  assert.ok(result.relations.some(relation =>
    relation.relationKind === "community_parent"
      && relation.fromId === childId && relation.toId === parentId));
});

test("community collection rejects boolean ids and keeps ordinary groups out of the root list", () => {
  const {FC} = load();
  const parentId = "parent@g.us";
  const announcementId = "announcement@g.us";
  const childId = "child@g.us";
  const standaloneId = "standalone@g.us";
  const chats = [
    {id: {_serialized: parentId}, title: "Community"},
    {id: {_serialized: announcementId}, title: "Announcements"},
    {id: {_serialized: childId}, title: "Child"},
    {id: {_serialized: standaloneId}, title: "Standalone"}
  ];
  const metadata = {
    _models: [
      {
        id: {_serialized: parentId}, isParentGroup: true,
        defaultSubgroup: false,
        subgroups: [{id: {_serialized: announcementId}}, {id: {_serialized: childId}}]
      },
      {
        id: {_serialized: announcementId}, isParentGroup: false,
        defaultSubgroup: true, announce: true,
        parentGroup: {_serialized: parentId}
      },
      {
        id: {_serialized: childId}, isParentGroup: false,
        defaultSubgroup: false, parentGroup: {_serialized: parentId}
      },
      {
        id: {_serialized: standaloneId}, isParentGroup: false,
        defaultSubgroup: false
      }
    ]
  };

  const result = FC.collectCommunities({chatCollection: {_models: chats}, groupMetadata: metadata});

  assert.deepEqual(Array.from(result.records, record => record.id), [parentId]);
  assert.equal(result.relations.some(relation => ["true", "false"].includes(relation.toId)), false);
  assert.ok(result.relations.some(relation =>
    relation.relationKind === "community_announcement_group"
      && relation.fromId === parentId && relation.toId === announcementId));
  assert.ok(result.relations.some(relation =>
    relation.relationKind === "community_child_group"
      && relation.fromId === parentId && relation.toId === childId));
  assert.equal(result.relations.some(relation =>
    relation.fromId === standaloneId || relation.toId === standaloneId), false);
});

test("community events alone reconstruct the visible parent and subgroup links", () => {
  const {FC} = load();
  const parentId = "parent@g.us";
  const announcementId = "announcement@g.us";
  const firstChildId = "first-child@g.us";
  const secondChildId = "second-child@g.us";
  const contexts = [
    {
      chatId: announcementId,
      messages: [
        {subtype: "community_create", body: "Community", templateParams: [{_serialized: parentId}, "Community"]},
        {subtype: "sibling_group_link", templateParams: [{_serialized: firstChildId}, "First child"]}
      ]
    },
    {
      chatId: parentId,
      messages: [{
        subtype: "sub_group_link",
        templateParams: [{_serialized: announcementId}, "Announcements", {_serialized: secondChildId}, "Second child"]
      }]
    },
    {
      chatId: firstChildId,
      messages: [{subtype: "empty_subgroup_create", templateParams: [{_serialized: parentId}, "First child"]}]
    }
  ];
  const result = FC.collectCommunities({chatCollection: {_models: []}}, contexts);
  assert.equal(result.status, "supported");
  assert.equal(result.reason, "derived_from_community_events");
  assert.deepEqual(Array.from(result.records, record => record.id), [parentId]);
  for (const childId of [announcementId, firstChildId, secondChildId]) {
    assert.ok(result.relations.some(relation => relation.fromId === parentId && relation.toId === childId));
  }
});

test("pin-in-chat records use the materialized collection and message fallback", () => {
  const {FC} = load();
  const chatId = "chat@g.us";
  const materialized = {
    id: {_serialized: "pin-record"}, chatId: {_serialized: chatId},
    parentMsgKey: {_serialized: "message-1"}, pinType: "pin", senderTimestampMs: 1_000
  };
  const protocol = {
    id: {_serialized: "pin-event"}, type: "protocol_pin", subtype: "pin_in_chat",
    quotedStanzaID: "message-2", t: 2
  };
  const records = FC.pinRecordsForChat(chatId, [protocol], {pins: {_models: [materialized]}});
  assert.equal(records.length, 2);
  assert.ok(records.some(record => record.messageId === "message-1"));
  assert.ok(records.some(record => record.messageId === "message-2" && record.state === "pin"));
});

test("historical call logs use the dedicated database query and native ids", async () => {
  const {FC} = load();
  const calls = [
    {id: {_serialized: "call-new"}, t: 20, fromMe: true, to: {_serialized: "peer@c.us"}, isVideoCall: true},
    {id: {_serialized: "call-old"}, t: 10, fromMe: false, from: {_serialized: "caller@c.us"}, callDuration: 42}
  ];
  let queries = 0;
  const result = await FC.collectCalls({
    calls: {privateMap: new Map()},
    async msgFindCallLog(params) {
      queries += 1;
      assert.equal(params.count, 1_000);
      return queries === 1 ? calls : [];
    }
  });
  assert.equal(result.status, "supported");
  assert.equal(queries, 2);
  assert.deepEqual(Array.from(result.records, record => record.id), ["call-old", "call-new"]);
  assert.equal(result.records[0].peerId, "caller@c.us");
  assert.equal(result.records[0].durationSeconds, 42);
  assert.equal(result.records[1].peerId, "peer@c.us");
  assert.equal(result.records[1].direction, "outgoing");
});

test("an empty transient call collection is not reported as historical success", async () => {
  const {FC} = load();
  const result = await FC.collectCalls({calls: {privateMap: new Map()}});
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "historical_call_query_unavailable_and_call_collection_empty");
  assert.equal(result.records.length, 0);
});

test("status V3 collection is synchronized and saved as grouped status items", async () => {
  const {FC} = load();
  const parent = {
    id: {_serialized: "owner@status"},
    unreadCount: 1,
    totalCount: 1,
    msgs: {_models: [{id: {_serialized: "status-message"}, t: 100, type: "image", caption: "today"}]},
    async loadMore() { return []; }
  };
  const store = {
    _models: [],
    async sync() { this._models.push(parent); }
  };
  const result = await FC.collectStatuses({statuses: store});
  assert.equal(result.status, "supported");
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, "owner@status");
  assert.equal(result.records[0].items[0].id, "status-message");
  assert.equal(result.records[0].items[0].caption, "today");
});

test("joined channels load newsletter membership metadata and exclude guests", async () => {
  const {FC} = load();
  const joined = {
    id: {_serialized: "joined@newsletter"},
    name: "Joined",
    msgs: {_models: [{id: {_serialized: "post-1"}, t: Math.floor(Date.now() / 1000), body: "news"}]}
  };
  const guest = {id: {_serialized: "guest@newsletter"}, name: "Guest", msgs: {_models: []}};
  const metadata = {
    async update(id) {
      const serialized = FC.idString(id);
      const channel = serialized === "joined@newsletter" ? joined : guest;
      channel.newsletterMetadata = {
        membershipType: serialized === "joined@newsletter" ? "subscriber" : "guest",
        description: `${serialized} description`
      };
      return channel.newsletterMetadata;
    }
  };
  const result = await FC.collectChannels({channels: {_models: [joined, guest]}, channelMetadata: metadata});
  assert.equal(result.status, "supported");
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, "joined@newsletter");
  assert.equal(result.records[0].membershipType, "subscriber");
  assert.equal(result.records[0].isJoined, true);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].channelId, "joined@newsletter");
});

test("channel extraction keeps only the configured rolling window and exposes media models", async () => {
  const {FC} = load();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const recent = {id: {_serialized: "recent"}, t: nowSeconds - 2 * 86400, type: "image", mimetype: "image/jpeg"};
  const old = {id: {_serialized: "old"}, t: nowSeconds - 20 * 86400, type: "image", mimetype: "image/jpeg"};
  const channel = {
    id: {_serialized: "joined@newsletter"},
    name: "Joined",
    membershipType: "subscriber",
    msgs: {_models: [old, recent]}
  };
  const result = await FC.collectChannels({channels: {_models: [channel]}, msgGetters: {}}, () => false, {days: 15});
  assert.deepEqual(Array.from(result.events, event => event.id), ["recent"]);
  assert.equal(result.mediaMessages.length, 1);
  assert.equal(result.mediaMessages[0].message, recent);
  assert.equal(result.records[0].windowDays, 15);
});

test("channel history falls back to the chat loader and still enforces the configured day window", async () => {
  const {FC} = load();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const newest = {id: {_serialized: "newest"}, t: nowSeconds - 86400, body: "one day ago"};
  const withinWindow = {id: {_serialized: "within"}, t: nowSeconds - 10 * 86400, body: "ten days ago"};
  const outsideWindow = {id: {_serialized: "outside"}, t: nowSeconds - 20 * 86400, body: "twenty days ago"};
  const channel = {
    id: {_serialized: "joined@newsletter"},
    name: "Joined",
    membershipType: "subscriber",
    msgs: {_models: [newest]}
  };
  const liveChat = {id: channel.id, msgs: {_models: [newest]}};
  let calls = 0;
  const env = {
    channels: {_models: [channel]},
    chatCollection: {_models: [liveChat]},
    historyLoader: {
      async loadEarlierMsgs({chat}) {
        assert.equal(chat, liveChat);
        calls += 1;
        const message = calls === 1 ? withinWindow : outsideWindow;
        chat.msgs._models.push(message);
        return [message];
      }
    }
  };

  const result = await FC.collectChannels(env, () => false, {days: 15});

  assert.equal(calls, 2);
  assert.deepEqual(Array.from(result.events, event => event.id), ["within", "newest"]);
  assert.equal(result.records[0].historyComplete, true);
  assert.equal(result.records[0].historyReason, "window_start_reached");
  assert.equal(result.records[0].historyMethod, "WAWebChatLoadMessages.loadEarlierMsgs");
});

test("acquisition policy is bounded and defaults remain enabled", () => {
  const {FC} = load();
  const defaults = FC.normalizePolicy();
  assert.equal(defaults.includeChannels, true);
  assert.equal(defaults.channelDays, 15);
  assert.equal(defaults.maxMediaBytes, 0);
  const bounded = FC.normalizePolicy({includeChannels: false, channelDays: 99999, maxMediaBytes: 1024});
  assert.equal(bounded.includeChannels, false);
  assert.equal(bounded.channelDays, 3650);
  assert.equal(bounded.maxMediaBytes, 1024);
});

test("channel message collections are exported separately from compact channel raw data", () => {
  const {FC} = load();
  const channel = {
    id: {_serialized: "channel@newsletter"},
    msgs: {_models: [{id: {_serialized: "post1"}, t: 1, body: "post"}]}
  };
  const datasets = FC.globalDatasets({channels: {_models: [channel]}});
  assert.equal(datasets.channels.length, 1);
  assert.equal("msgs" in datasets.channels[0].raw, false);
  assert.equal(datasets.channel_events.length, 1);
  assert.equal(datasets.channel_events[0].chatId, "channel@newsletter");
});

test("duplicate titles are never sufficient to select a conversation", async () => {
  const {context, FC} = load();
  let clicks = 0;
  const row = () => ({
    textContent: "Repeated title",
    getAttribute() { return ""; },
    querySelector() { return null; },
    scrollIntoView() {},
    dispatchEvent() {},
    click() { clicks += 1; }
  });
  const rows = [row(), row()];
  context.document.getElementById = id => id === "pane-side" ? {querySelectorAll: () => rows} : {};
  const chat = {id: {_serialized: "wanted@c.us"}, title: "Repeated title"};
  const env = {chatCollection: {activeChat: null}};
  const opened = await FC.openChat(chat, env);
  assert.equal(opened.opened, false);
  assert.equal(clicks, 0);
});

test("Store history requires two stable empty rounds", async () => {
  const {FC} = load();
  FC.sleep = async () => {};
  let calls = 0;
  const chat = {id: {_serialized: "chat@c.us"}, msgs: {_models: []}};
  const env = {
    chatCollection: {_models: [chat]},
    historyLoader: {async loadEarlierMsgs() { calls += 1; return []; }},
    msgGetters: {getId: item => item.id}
  };
  FC._activeEnv = env;
  const report = {};
  const complete = await FC.tryStoreHistory(chat, env, new Map(), report, () => false);
  assert.equal(complete, true);
  assert.equal(calls, 2);
  assert.equal(report.reason, "history_end_confirmed_by_store_loader");
});

test("UI history fallback terminates after two stable rounds", async () => {
  const {FC} = load();
  FC.sleep = async () => {};
  FC.openChat = async () => ({opened: true, method: "row_id"});
  FC.conversationPanel = () => ({scrollTop: 10, dispatchEvent() {}});
  FC.earlierControl = () => null;
  let merges = 0;
  FC.mergeChatMessages = (_chat, _env, messages) => {
    merges += 1;
    if (merges === 1) {
      messages.set("m1", {id: {_serialized: "m1"}, t: 1});
      return 1;
    }
    return 0;
  };
  const report = {};
  const messages = new Map();
  await FC.tryUiHistory({id: {_serialized: "chat@c.us"}}, {}, messages, report, () => false);
  assert.equal(report.complete, true);
  assert.equal(report.rounds, 3);
  assert.equal(report.reason, "history_end_stable_without_control");
});

test("media metadata distinguishes original files from previews", () => {
  const {FC} = load();
  const message = {id: {_serialized: "m1"}, type: "image", mimetype: "image/jpeg"};
  const env = {msgGetters: {
    getId: item => item.id,
    getType: item => item.type,
    getMimetype: item => item.mimetype
  }};
  FC._activeEnv = env;
  assert.equal(FC.mediaMeta(message, env, "chat", "original").isOriginal, true);
  assert.equal(FC.mediaMeta(message, env, "chat", "preview").isOriginal, false);
});

test("voice media uses the base MIME type for its file extension", () => {
  const {FC} = load();
  const message = {id: {_serialized: "voice1"}, type: "ptt", mimetype: "audio/ogg; codecs=opus"};
  const env = {msgGetters: {
    getId: item => item.id,
    getType: item => item.type,
    getMimetype: item => item.mimetype
  }};
  assert.match(FC.mediaMeta(message, env, "chat").originalFileName, /\.ogg$/);
});

test("downloadMedia waits for an asynchronously populated blob", async () => {
  const {FC} = load();
  const mediaData = {
    downloadMedia(options) {
      assert.equal(options.downloadEvenIfExpensive, true);
      assert.equal(options.isUserInitiated, true);
      setTimeout(() => {
        mediaData.mediaBlob = new Blob([new Uint8Array([1, 2, 3])], {type: "image/jpeg"});
      }, 5);
    }
  };
  const message = {type: "image", mediaData};
  const source = await FC.tryDownloadMedia(message, {msgGetters: {}}, {
    waitMs: 100,
    pollMs: 5,
    requestTimeoutMs: 100
  });
  assert.equal(source.byteLength, 3);
  assert.equal(source.source, "downloadMedia_populated_blob");
});

test("expired media URLs and their expiry time are detected", () => {
  const {FC} = load();
  const url = "https://mmg.whatsapp.net/file.enc?oe=00000001";
  assert.equal(FC.mediaUrlExpiry(url), 1000);
  assert.equal(FC.mediaUrlIsExpired(url, 2000), true);
  assert.equal(FC.mediaNeedsChatRefresh({clientUrl: url}, {}, 2000), true);
});

test("an expired media URL is fetched and decrypted before downloadMedia refresh", async () => {
  const {context, FC} = load();
  const expiredUrl = "https://mmg.whatsapp.net/file.enc?oe=00000001";
  let fetchCalls = 0;
  let downloadCalls = 0;
  context.fetch = async url => {
    fetchCalls += 1;
    assert.equal(url, expiredUrl);
    return {
      ok: true,
      arrayBuffer: async () => new Uint8Array(26).buffer
    };
  };
  context.crypto = {subtle: {
    importKey: async () => ({}),
    decrypt: async () => new Uint8Array([1, 2, 3]).buffer
  }};
  const message = {
    type: "image",
    mimetype: "image/jpeg",
    clientUrl: expiredUrl,
    mediaKey: btoa("01234567890123456789012345678901"),
    mediaData: {downloadMedia() { downloadCalls += 1; }}
  };
  const env = {
    cryptoHkdf: {extractAndExpand: async () => new Uint8Array(112).buffer},
    msgGetters: {
      getDeprecatedMms3Url: item => item.clientUrl,
      getMediaKey: item => item.mediaKey,
      getType: item => item.type,
      getMimetype: item => item.mimetype
    }
  };
  const source = await FC.originalMedia(message, env, {
    beforeRefresh: async () => { throw new Error("refresh must not run"); }
  });
  assert.equal(fetchCalls, 1);
  assert.equal(downloadCalls, 0);
  assert.equal(source.source, "expired_url_aes_cbc_buffered");
  assert.equal(source.byteLength, 3);
});

test("a rejected old URL is retried after downloadMedia supplies a new URL", async () => {
  const {context, FC} = load();
  const oldUrl = "https://mmg.whatsapp.net/old.enc?oe=00000001";
  const newUrl = "https://mmg.whatsapp.net/new.enc?oe=ffffffff";
  const requestedUrls = [];
  context.fetch = async url => {
    requestedUrls.push(url);
    if (url === oldUrl) return {ok: false, status: 403};
    return {ok: true, arrayBuffer: async () => new Uint8Array(26).buffer};
  };
  context.crypto = {subtle: {
    importKey: async () => ({}),
    decrypt: async () => new Uint8Array([4, 5, 6]).buffer
  }};
  let refreshContextCalls = 0;
  let downloadCalls = 0;
  const message = {
    type: "image",
    mimetype: "image/jpeg",
    clientUrl: oldUrl,
    mediaKey: btoa("01234567890123456789012345678901")
  };
  message.mediaData = {
    downloadMedia() {
      downloadCalls += 1;
      message.clientUrl = newUrl;
    }
  };
  const env = {
    cryptoHkdf: {extractAndExpand: async () => new Uint8Array(112).buffer},
    msgGetters: {
      getDeprecatedMms3Url: item => item.clientUrl,
      getMediaKey: item => item.mediaKey,
      getType: item => item.type,
      getMimetype: item => item.mimetype
    }
  };
  const source = await FC.originalMedia(message, env, {
    beforeRefresh: async current => {
      refreshContextCalls += 1;
      return current;
    }
  });
  assert.deepEqual(requestedUrls, [oldUrl, newUrl]);
  assert.equal(refreshContextCalls, 1);
  assert.equal(downloadCalls, 1);
  assert.equal(source.source, "refreshed_url_aes_cbc_buffered");
});

test("media refresh resolves the newest message model after reopening a chat", () => {
  const {FC} = load();
  const original = {id: {_serialized: "m1"}, clientUrl: "old"};
  const refreshed = {id: {_serialized: "m1"}, clientUrl: "fresh"};
  const staleChat = {id: {_serialized: "chat@c.us"}, msgs: {_models: [original]}};
  const liveChat = {id: {_serialized: "chat@c.us"}, msgs: {_models: [refreshed]}};
  const env = {
    chatCollection: {_models: [liveChat]},
    msgGetters: {getId: item => item.id}
  };
  FC._activeEnv = env;
  assert.equal(FC.refreshedMessageModel(original, staleChat, env), refreshed);
});

test("message body thumbnails are exported only as previews", async () => {
  const {FC} = load();
  const body = "/9j/" + "A".repeat(512);
  const source = await FC.previewMedia({type: "video", body});
  assert.equal(source.source, "message_body_preview_base64");
  assert.equal(source.mimeType, "image/jpeg");
});

test("original media failures preserve a diagnostic reason", async () => {
  const {FC} = load();
  await assert.rejects(
    FC.originalMedia(
      {type: "image", clientUrl: "https://mmg.whatsapp.net/file.enc?oe=00000001"},
      {msgGetters: {}}
    ),
    /media_hkdf_unavailable/
  );
});

test("vCard bodies are exported as original vcf bytes", async () => {
  const {FC} = load();
  const body = "BEGIN:VCARD\nFN:Alice\nEND:VCARD";
  const message = {id: {_serialized: "v1"}, type: "vcard", body};
  const env = {msgGetters: {
    getId: item => item.id,
    getType: item => item.type,
    getBody: item => item.body
  }};
  FC._activeEnv = env;
  const meta = FC.mediaMeta(message, env, "chat", "original");
  const source = await FC.originalMedia(message, env);
  const chunks = [];
  const result = await FC.streamMediaSource(source, chunk => chunks.push(chunk.slice()), () => false);
  assert.equal(meta.mimeType, "text/vcard");
  assert.match(meta.originalFileName, /\.vcf$/);
  assert.equal(result.complete, true);
  assert.equal(new TextDecoder().decode(chunks[0]), body);
});

test("unknown-size media streams are forwarded in bounded chunks", async () => {
  const {FC} = load();
  const payload = new Uint8Array(300 * 1024).fill(7);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    }
  });
  const source = FC.mediaSourceFrom(stream, "test_readable_stream");
  const chunkSizes = [];
  const result = await FC.streamMediaSource(
    source,
    chunk => chunkSizes.push(chunk.byteLength),
    () => false
  );
  assert.equal(source.byteLength, null);
  assert.equal(result.byteLength, payload.byteLength);
  assert.ok(chunkSizes.every(size => size <= 128 * 1024));
  assert.equal(chunkSizes.length, 3);
});

test("unknown-size streams stop before exceeding the attachment policy limit", async () => {
  const {FC} = load();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(80).fill(1));
      controller.enqueue(new Uint8Array(80).fill(2));
      controller.close();
    }
  });
  let received = 0;
  await assert.rejects(
    FC.streamMediaSource(
      FC.mediaSourceFrom(stream, "limited"),
      chunk => { received += chunk.byteLength; },
      () => false,
      {chunkBytes: 80, maxBytes: 100}
    ),
    /media_size_limit_exceeded/
  );
  assert.equal(received, 80);
});

test("observable blobs are streamed without making an eager byte-array copy", async () => {
  const {FC} = load();
  const blob = new Blob([new Uint8Array(260 * 1024).fill(3)], {type: "video/mp4"});
  const message = {id: {_serialized: "video1"}, type: "video", mediaData: {mediaBlob: blob}};
  const env = {msgGetters: {getType: item => item.type}};
  const source = await FC.originalMedia(message, env);
  let chunks = 0;
  const result = await FC.streamMediaSource(source, () => { chunks += 1; }, () => false);
  assert.equal(source.transferMode, "blob_stream");
  assert.equal(result.byteLength, blob.size);
  assert.ok(chunks >= 3);
});

test("stalled media streams fail after the no-progress timeout", async () => {
  const {FC} = load();
  const stream = new ReadableStream({start() {}});
  const source = FC.mediaSourceFrom(stream, "stalled_test_stream");
  await assert.rejects(
    FC.streamMediaSource(source, () => {}, () => false, {idleTimeoutMs: 10}),
    /media_idle_timeout/
  );
});

test("avatar tasks include only relevant ids that have a usable URL", () => {
  const {FC} = load();
  const env = {profilePictures: {_models: [
    {id: {_serialized: "used@c.us"}, imgFull: "https://cdn.test/used.jpg"},
    {id: {_serialized: "unused@c.us"}, imgFull: "https://cdn.test/unused.jpg"},
    {id: {_serialized: "no-avatar@c.us"}}
  ]}};
  const tasks = FC.avatarTasks(env, new Set(["used@c.us", "no-avatar@c.us"]));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].contactId, "used@c.us");
});

test("controller keeps a frame frozen until matching ACK", async () => {
  const {controller} = load();
  const started = await controller.dispatch({command: "start_full"});
  assert.equal(started.accepted, true);
  await new Promise(resolve => setTimeout(resolve, 0));
  const first = controller.next();
  const repeated = controller.next();
  assert.equal(first.kind, "capabilities");
  assert.deepEqual(repeated, first);
  assert.equal(controller.ack("999").accepted, false);
  assert.equal(controller.ack(first.sequence).accepted, true);
});
