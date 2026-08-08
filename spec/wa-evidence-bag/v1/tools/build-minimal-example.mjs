import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
} from "node:crypto";
import {
  buildManifest,
  canonicalize,
  jsonBytes,
  sha256,
  utf8Sort,
  walkRegularFiles,
  writeJson,
  writeNdjson,
} from "./waeb-common.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V1_DIR = path.resolve(HERE, "..");
const SCHEMA_DIR = path.join(V1_DIR, "schemas");
const EXAMPLE_DIR = path.join(V1_DIR, "examples", "minimal-valid-signed");
const EVIDENCE_ID = "11111111-1111-4111-8111-111111111111";
const ACQUISITION_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const BAG_DIR = path.join(EXAMPLE_DIR, `waeb-${EVIDENCE_ID}`);
const DATA_DIR = path.join(BAG_DIR, "data");
const FIXED_START = "2026-01-15T08:00:00.000Z";
const FIXED_END = "2026-01-15T08:00:10.000Z";
const CAPTURED_AT = "2026-01-15T08:00:03.000Z";

const IDS = Object.freeze({
  account: "acc_7c86888e0bc1458c",
  contact: "con_121b38ac89314a19",
  chat: "cht_c4dc679aac2f4df0",
  chatList: "lst_c41357156a264ee1",
  participantA: "par_5b95cb52ce5143ef",
  participantB: "par_a1ddbca89e5145ce",
  messageSystem: "msg_c4cc6af2965241bc",
  messageText: "msg_7f2e8c70c5a9429a",
  messageImage: "msg_25dc705ae036447d",
  assetImage: "ast_760c4a0632a748c1",
});

const NORMALIZED_DATASETS = [
  ["accounts", "accounts.ndjson", "account"],
  ["contacts", "contacts.ndjson", "contact"],
  ["chats", "chats.ndjson", "chat"],
  ["chat_lists", "chat-lists.ndjson", "chat_list"],
  ["participants", "participants.ndjson", "participant"],
  ["messages", "messages.ndjson", "message"],
  ["message_events", "message-events.ndjson", "message_event"],
  ["reactions", "reactions.ndjson", "reaction"],
  ["receipts", "receipts.ndjson", "receipt"],
  ["poll_votes", "poll-votes.ndjson", "poll_vote"],
  ["group_events", "group-events.ndjson", "group_event"],
  ["statuses", "statuses.ndjson", "status"],
  ["calls", "calls.ndjson", "call"],
  ["channels", "channels.ndjson", "channel"],
  ["channel_events", "channel-events.ndjson", "channel_event"],
  ["communities", "communities.ndjson", "community"],
  ["community_relations", "community-relations.ndjson", "community_relation"],
  ["presence_snapshots", "presence-snapshots.ndjson", "presence_snapshot"],
];

function normalizedRecord(recordType, recordId, data, provenance) {
  return {
    schemaVersion: "1.0.0",
    recordType,
    recordId,
    sourceId: SOURCE_ID,
    capturedAtUtc: CAPTURED_AT,
    provenance,
    contentSha256: sha256(Buffer.from(canonicalize(data), "utf8")),
    data,
  };
}

function rawRecord(recordId, nativeType, value) {
  return {
    schemaVersion: "1.0.0",
    recordId,
    provider: "store",
    phase: "baseline",
    capturedAtUtc: CAPTURED_AT,
    nativeType,
    value,
    omittedFields: ["mediaKey", "directPath", "accessToken"],
    contentSha256: sha256(Buffer.from(canonicalize(value), "utf8")),
  };
}

function rawProvenance(pathName, record) {
  return [{
    provider: "store",
    phase: "baseline",
    rawRef: {
      path: pathName,
      recordId: record.recordId,
      contentSha256: record.contentSha256,
    },
  }];
}

function derivedProvenance(reason) {
  return [{provider: "derived", phase: "baseline", absenceReason: reason}];
}

function fixedMessageTime(secondsOffset) {
  const utc = new Date(Date.parse(FIXED_START) + secondsOffset * 1000).toISOString();
  return {
    utc,
    originalValue: String(1768464000 + secondsOffset),
    originalUnit: "seconds",
    source: "message_store",
    precision: "second",
  };
}

function baseMessageData(nativeOpaqueValue, kind, nativeType, secondsOffset) {
  return {
    nativeIdentity: {kind: "native_unknown", opaqueValue: nativeOpaqueValue},
    container: {kind: "chat", recordId: IDS.chat},
    senderRecordId: null,
    recipientRecordIds: [],
    authorRecordId: null,
    sentAt: fixedMessageTime(secondsOffset),
    kind,
    nativeType,
    text: null,
    caption: null,
    quoted: null,
    mentionRecordIds: [],
    flags: {
      fromMe: false,
      forwarded: false,
      starred: false,
      edited: false,
      revoked: false,
      viewOnce: false,
      ephemeral: false,
    },
    acknowledgement: {state: "unknown", nativeValue: null},
    attachmentAssetIds: [],
    location: null,
    poll: null,
    event: null,
    unsupportedReasonCodes: [],
  };
}

function makeLogEvents() {
  const definitions = [
    ["2026-01-15T08:00:00.000Z", "0", "acquisition_started", {mode: "baseline", synthetic: true}],
    ["2026-01-15T08:00:01.000Z", "1000000000", "capability_probe_completed", {supported: 19, unsupported: 0}],
    ["2026-01-15T08:00:08.000Z", "8000000000", "dataset_completed", {datasetCount: 18, normalizedRecordCount: 9}],
    ["2026-01-15T08:00:10.000Z", "10000000000", "acquisition_completed", {overall: "partial", reasonCode: "history_not_requested"}],
  ];
  const events = [];
  let previous = null;
  for (let index = 0; index < definitions.length; index += 1) {
    const [wallClockUtc, monotonicOffsetNs, type, summary] = definitions[index];
    const withoutHash = {
      schemaVersion: "1.0.0",
      sequence: String(index + 1),
      sessionId: SESSION_ID,
      wallClockUtc,
      monotonicOffsetNs,
      previousEventHash: previous,
      event: {type, summary},
    };
    const previousBytes = previous ? Buffer.from(previous, "hex") : Buffer.alloc(32, 0);
    const eventHash = sha256(Buffer.concat([
      Buffer.from("WAEB-LOG-v1\0", "utf8"),
      previousBytes,
      Buffer.from(canonicalize(withoutHash), "utf8"),
    ]));
    events.push({...withoutHash, eventHash});
    previous = eventHash;
  }
  return events;
}

function copySchemas() {
  const destination = path.join(BAG_DIR, "schemas");
  fs.mkdirSync(destination, {recursive: true});
  fs.cpSync(SCHEMA_DIR, destination, {recursive: true, force: true});
}

function createPayload() {
  const rawEntityPath = "data/raw/baseline/store/entities.ndjson";
  const rawMessagePath = "data/raw/baseline/store/messages.ndjson";

  const rawAccount = rawRecord("raw_acc_alpha_001", "account", {
    id: "user-alpha@wa.invalid",
    formattedName: "测试用户甲",
    isMe: true,
    isBusiness: false,
  });
  const rawContact = rawRecord("raw_con_bravo_001", "contact", {
    id: "user-bravo@wa.invalid",
    formattedName: "测试用户乙",
    isMyContact: true,
    isWAContact: true,
  });
  const rawChat = rawRecord("raw_cht_alpha_bravo_001", "chat", {
    id: "chat-alpha-bravo@wa.invalid",
    kind: "chat",
    formattedTitle: "合成测试会话",
    unreadCount: 0,
  });
  const rawSystem = rawRecord("raw_msg_system_001", "e2e_notification", {
    id: "native-system-001.invalid",
    chatId: "chat-alpha-bravo@wa.invalid",
    type: "e2e_notification",
    t: 1768464001,
  });
  const rawText = rawRecord("raw_msg_alpha_001", "chat", {
    id: "native-message-001.invalid",
    chatId: "chat-alpha-bravo@wa.invalid",
    from: "user-alpha@wa.invalid",
    to: "user-bravo@wa.invalid",
    fromMe: true,
    type: "chat",
    t: 1768464002,
    body: "这是完全合成的测试消息。",
  });
  const rawImage = rawRecord("raw_msg_bravo_002", "image", {
    id: "native-message-002.invalid",
    chatId: "chat-alpha-bravo@wa.invalid",
    from: "user-bravo@wa.invalid",
    to: "user-alpha@wa.invalid",
    fromMe: false,
    type: "image",
    t: 1768464003,
    mimetype: "image/png",
    size: 68,
  });

  writeNdjson(path.join(BAG_DIR, ...rawEntityPath.split("/")), [rawAccount, rawContact, rawChat]);
  writeNdjson(path.join(BAG_DIR, ...rawMessagePath.split("/")), [rawSystem, rawText, rawImage]);

  const accountData = {
    nativeIdentities: [{kind: "jid", opaqueValue: "user-alpha@wa.invalid"}],
    displayName: "测试用户甲",
    accountKind: "consumer",
    isBusiness: false,
    verifiedName: null,
    profileAssetIds: [],
    observedDevice: {deviceId: "synthetic-web-device", isCompanion: true},
  };
  const contactData = {
    nativeIdentities: [{kind: "jid", opaqueValue: "user-bravo@wa.invalid"}],
    displayNames: {formatted: "测试用户乙", push: "测试用户乙", short: "用户乙", verified: null},
    about: "合成联系人，仅用于测试。",
    isSelf: false,
    isAddressBookContact: true,
    isWhatsAppUser: true,
    isVerified: false,
    isDeactivated: null,
    profileAssetIds: [],
  };
  const chatData = {
    nativeIdentity: {kind: "native_unknown", opaqueValue: "chat-alpha-bravo@wa.invalid"},
    kind: "direct",
    title: "合成测试会话",
    participantRecordIds: [IDS.participantA, IDS.participantB],
    state: {archived: false, pinned: true, readOnly: false, unreadCount: 0, mutedUntilUtc: null},
    ephemeral: {enabled: false, durationSeconds: null},
    firstObservedAtUtc: FIXED_START,
    lastObservedAtUtc: FIXED_END,
  };
  const chatListData = {
    nativeIdentity: null,
    listKind: "favorites",
    name: "特别关注",
    order: 0,
    chatRecordIds: [IDS.chat],
  };
  const participantAData = {
    containerRecordId: IDS.chat,
    subjectRecordId: IDS.account,
    role: "member",
    membershipState: "active",
    joinedAtUtc: null,
    leftAtUtc: null,
  };
  const participantBData = {
    containerRecordId: IDS.chat,
    subjectRecordId: IDS.contact,
    role: "member",
    membershipState: "active",
    joinedAtUtc: null,
    leftAtUtc: null,
  };

  const systemData = baseMessageData("native-system-001.invalid", "system", "e2e_notification", 1);
  systemData.text = "合成系统通知";
  const textData = baseMessageData("native-message-001.invalid", "text", "chat", 2);
  textData.senderRecordId = IDS.account;
  textData.recipientRecordIds = [IDS.contact];
  textData.text = "这是完全合成的测试消息。";
  textData.flags.fromMe = true;
  textData.acknowledgement = {state: "read", nativeValue: 3};
  const imageData = baseMessageData("native-message-002.invalid", "image", "image", 3);
  imageData.senderRecordId = IDS.contact;
  imageData.recipientRecordIds = [IDS.account];
  imageData.caption = "合成的一像素图片";
  imageData.attachmentAssetIds = [IDS.assetImage];
  imageData.acknowledgement = {state: "delivered", nativeValue: 2};

  const recordsByDataset = new Map(NORMALIZED_DATASETS.map(([name]) => [name, []]));
  recordsByDataset.get("accounts").push(normalizedRecord("account", IDS.account, accountData, rawProvenance(rawEntityPath, rawAccount)));
  recordsByDataset.get("contacts").push(normalizedRecord("contact", IDS.contact, contactData, rawProvenance(rawEntityPath, rawContact)));
  recordsByDataset.get("chats").push(normalizedRecord("chat", IDS.chat, chatData, rawProvenance(rawEntityPath, rawChat)));
  recordsByDataset.get("chat_lists").push(normalizedRecord("chat_list", IDS.chatList, chatListData, derivedProvenance("synthetic_fixture_ui_observation")));
  recordsByDataset.get("participants").push(
    normalizedRecord("participant", IDS.participantA, participantAData, rawProvenance(rawEntityPath, rawChat)),
    normalizedRecord("participant", IDS.participantB, participantBData, rawProvenance(rawEntityPath, rawChat)),
  );
  recordsByDataset.get("messages").push(
    normalizedRecord("message", IDS.messageSystem, systemData, rawProvenance(rawMessagePath, rawSystem)),
    normalizedRecord("message", IDS.messageText, textData, rawProvenance(rawMessagePath, rawText)),
    normalizedRecord("message", IDS.messageImage, imageData, rawProvenance(rawMessagePath, rawImage)),
  );

  for (const [name, fileName] of NORMALIZED_DATASETS) {
    writeNdjson(path.join(DATA_DIR, "normalized", fileName), recordsByDataset.get(name));
  }

  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const mediaDigest = sha256(onePixelPng);
  const casRelativePath = `data/media/sha256/${mediaDigest.slice(0, 2)}/${mediaDigest}`;
  const casAbsolutePath = path.join(BAG_DIR, ...casRelativePath.split("/"));
  fs.mkdirSync(path.dirname(casAbsolutePath), {recursive: true});
  fs.writeFileSync(casAbsolutePath, onePixelPng);
  const mediaRecord = {
    schemaVersion: "1.0.0",
    assetId: IDS.assetImage,
    sourceId: SOURCE_ID,
    sourceRecordIds: [IDS.messageImage],
    role: "full",
    kind: "image",
    acquisitionStatus: "available",
    cas: {algorithm: "sha256", digest: mediaDigest, path: casRelativePath, byteLength: onePixelPng.length},
    declaredMime: "image/png",
    detectedMime: "image/png",
    detector: {name: "synthetic-fixture-detector", version: "1.0.0"},
    suggestedExtension: ".png",
    originalFileName: "synthetic-one-pixel.png",
    width: 1,
    height: 1,
    durationMs: null,
    relatedAssetIds: [],
    acquisition: {method: "blob_observed", attempts: 1, capturedAtUtc: CAPTURED_AT, errorCode: null},
  };
  writeNdjson(path.join(DATA_DIR, "indexes", "media.ndjson"), [mediaRecord]);

  const chatCompleteness = {
    schemaVersion: "1.0.0",
    sourceId: SOURCE_ID,
    chatRecordId: IDS.chat,
    discoverySources: ["store", "visible_list"],
    initialMessageCount: 3,
    finalMessageCount: 3,
    historyScope: "not_run",
    loadMethod: "none",
    rounds: 0,
    returnedCount: 0,
    newCount: 0,
    emptyRounds: 0,
    stagnantRounds: 0,
    earliestObservedAtUtc: "2026-01-15T08:00:01.000Z",
    latestObservedAtUtc: "2026-01-15T08:00:03.000Z",
    terminationEvidence: null,
    reasonCodes: ["history_not_requested"],
  };
  writeNdjson(path.join(DATA_DIR, "completeness", "chats.ndjson"), [chatCompleteness]);

  const capabilities = {
    schemaVersion: "1.0.0",
    sourceId: SOURCE_ID,
    probedAtUtc: "2026-01-15T08:00:01.000Z",
    whatsappBuild: "synthetic-build.invalid",
    capabilities: [
      "accounts", "contacts", "chats", "chat_lists", "participants", "messages",
      "message_events", "reactions", "receipts", "poll_votes", "group_events",
      "statuses", "calls", "channels", "channel_events", "communities",
      "community_relations", "presence_snapshots", "media"
    ].map((name) => ({name, result: "supported", adapter: "synthetic-adapter-v1", reasonCodes: []})),
  };
  writeJson(path.join(DATA_DIR, "diagnostics", "capabilities.json"), capabilities);

  const logEvents = makeLogEvents();
  writeNdjson(path.join(DATA_DIR, "logs", "acquisition.ndjson"), logEvents);

  const inventory = {
    schemaVersion: "1.0.0",
    sourceId: SOURCE_ID,
    generatedAtUtc: FIXED_END,
    datasets: NORMALIZED_DATASETS.map(([name, fileName, recordType]) => {
      const datasetPath = `data/normalized/${fileName}`;
      const absolutePath = path.join(BAG_DIR, ...datasetPath.split("/"));
      const records = recordsByDataset.get(name);
      const requested = !["statuses", "calls", "channels", "channel_events", "communities", "community_relations", "presence_snapshots"].includes(name);
      return {
        name,
        path: datasetPath,
        recordType,
        capability: "supported",
        requestState: requested ? "requested" : "not_requested",
        result: requested ? (records.length ? "complete_as_observed" : "empty") : "not_requested",
        recordCount: records.length,
        byteLength: fs.statSync(absolutePath).size,
        observationWindow: requested ? {startedAtUtc: FIXED_START, endedAtUtc: FIXED_END} : null,
        reasonCodes: requested ? [] : ["fixture_scope_not_requested"],
      };
    }),
  };
  writeJson(path.join(DATA_DIR, "dataset-inventory.json"), inventory);

  const completeness = {
    schemaVersion: "1.0.0",
    sourceId: SOURCE_ID,
    evaluatedAtUtc: FIXED_END,
    overall: "partial",
    localSnapshot: "verified",
    historyScope: "not_run",
    mediaScope: "complete",
    accountScope: "unverifiable",
    datasetInventoryPath: "data/dataset-inventory.json",
    chatCompletenessPath: "data/completeness/chats.ndjson",
    mediaCounts: {requested: 1, full: 1, thumbnail: 0, missing: 0, expired: 0, decryptError: 0, notRequested: 0},
    crossChecks: {inventoryCountsMatch: true, mediaIndexMatchesCas: true, normalizedRefsResolved: true, differences: []},
    reasonCodes: ["history_not_requested", "optional_datasets_not_requested", "account_scope_unverifiable"],
  };
  writeJson(path.join(DATA_DIR, "completeness.json"), completeness);

  const acquisition = {
    schemaVersion: "1.0.0",
    waEvidenceBagVersion: "1.0.0-draft.1",
    evidenceId: EVIDENCE_ID,
    acquisitionId: ACQUISITION_ID,
    sourceId: SOURCE_ID,
    synthetic: true,
    fixture: {fixtureId: "minimal-valid-signed", generatorVersion: "1.0.0", seed: "waeb-fixture-seed-1"},
    collector: {name: "Synthetic WAEB Fixture Builder", version: "1.0.0", sha256: sha256("synthetic-collector")},
    injector: {name: "Synthetic Main World Injector", version: "1.0.0", sha256: sha256("synthetic-injector")},
    adapter: {name: "Synthetic WhatsApp Adapter", version: "1.0.0", sha256: sha256("synthetic-adapter")},
    environment: {
      os: {family: "windows", version: "synthetic", architecture: "x86_64"},
      browser: {
        family: "chrome",
        version: "synthetic",
        profileMode: "authorized_existing",
        profileReferenceSha256: sha256("synthetic-profile-reference"),
        debugTransport: "loopback_websocket",
      },
      whatsappBuild: "synthetic-build.invalid",
      locale: "zh-Hans",
      timeZone: "Asia/Shanghai",
    },
    operator: {operatorId: "fixture_operator", displayName: "合成测试操作者"},
    authorization: {reference: "SYNTHETIC-FIXTURE-AUTHORIZATION", confirmedAtUtc: FIXED_START},
    portableConfiguration: {
      bundleId: "99999999-9999-4999-8999-999999999999",
      bundleManifestSha256: sha256("synthetic-portable-bundle-manifest"),
      assignmentId: "assignment-synthetic-fixture",
      assignmentSha256: sha256("synthetic-signed-assignment"),
      workstationKeyFingerprintSha256: `sha256:${sha256("synthetic-workstation-public-key")}`,
    },
    observationWindow: {startedAtUtc: FIXED_START, endedAtUtc: FIXED_END},
    acquisitionMode: {baseline: true, enrichmentRequested: false, uiFallbackAllowed: false},
    log: {path: "data/logs/acquisition.ndjson", eventCount: logEvents.length, terminalEventHash: logEvents.at(-1).eventHash},
    privacy: {
      normalizedWhitelist: true,
      omittedFieldClasses: ["media_keys", "access_tokens", "direct_urls", "cookies", "credentials", "debug_secrets"],
      restrictedRawIncluded: false,
    },
    extensions: {"fixture.whatsapp-forensics.invalid": {browserObservationBasis: "structure-only"}},
  };
  writeJson(path.join(DATA_DIR, "acquisition.json"), acquisition);
}

function createBagAndSeal() {
  fs.mkdirSync(BAG_DIR, {recursive: true});
  copySchemas();
  createPayload();

  fs.writeFileSync(path.join(BAG_DIR, "bagit.txt"), "BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n", "utf8");

  const payloadFiles = walkRegularFiles(DATA_DIR).map((name) => `data/${name}`);
  const payloadBytes = payloadFiles.reduce((sum, relativePath) => sum + fs.statSync(path.join(BAG_DIR, ...relativePath.split("/"))).size, 0);
  const bagInfo = [
    `Bagging-Date: 2026-01-15`,
    `Bag-Software-Agent: Synthetic WAEB Fixture Builder/1.0.0`,
    `Payload-Oxum: ${payloadBytes}.${payloadFiles.length}`,
    `External-Identifier: ${EVIDENCE_ID}`,
    `WAEvidenceBag-Version: 1.0.0-draft.1`,
    `Source-Organization: Synthetic fixture only`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(BAG_DIR, "bag-info.txt"), bagInfo, "utf8");

  fs.writeFileSync(path.join(BAG_DIR, "manifest-sha256.txt"), buildManifest(BAG_DIR, payloadFiles, "sha256"), "utf8");
  fs.writeFileSync(path.join(BAG_DIR, "manifest-sha512.txt"), buildManifest(BAG_DIR, payloadFiles, "sha512"), "utf8");

  const privateJwkSource = JSON.parse(fs.readFileSync(path.join(V1_DIR, "test-vectors", "keys", "test-only-ed25519-private.jwk"), "utf8"));
  const privateJwk = {kty: privateJwkSource.kty, crv: privateJwkSource.crv, x: privateJwkSource.x, d: privateJwkSource.d};
  const privateKey = createPrivateKey({key: privateJwk, format: "jwk"});
  const publicKey = createPublicKey(privateKey);
  const publicSpki = publicKey.export({format: "der", type: "spki"});
  const fingerprint = `sha256:${sha256(publicSpki)}`;
  const signer = {
    schemaVersion: "1.0.0",
    algorithm: "Ed25519",
    publicKeyFormat: "DER-SPKI",
    publicKeySpkiBase64: publicSpki.toString("base64"),
    publicKeyFingerprint: fingerprint,
    keyId: "waeb-fixture-test-key-1",
    synthetic: true,
  };
  writeJson(path.join(BAG_DIR, "signatures", "signer.json"), signer);

  const schemaFiles = walkRegularFiles(path.join(BAG_DIR, "schemas")).map((name) => `schemas/${name}`);
  const payloadManifestPaths = ["manifest-sha256.txt", "manifest-sha512.txt"];
  const coreTagPaths = utf8Sort(["bagit.txt", "bag-info.txt", ...schemaFiles, "signatures/signer.json"]);
  const payloadManifests = payloadManifestPaths.map((relativePath) => ({
    path: relativePath,
    sha256: sha256(fs.readFileSync(path.join(BAG_DIR, relativePath))),
  }));
  const tagFiles = coreTagPaths.map((relativePath) => ({
    path: relativePath,
    sha256: sha256(fs.readFileSync(path.join(BAG_DIR, ...relativePath.split("/")))),
  }));
  const manifestRootSha256 = sha256(Buffer.from(canonicalize({payloadManifests, tagFiles}), "utf8"));
  const seal = {
    schemaVersion: "1.0.0",
    waEvidenceBagVersion: "1.0.0-draft.1",
    evidenceId: EVIDENCE_ID,
    createdAtUtc: FIXED_END,
    manifestRootSha256,
    payloadManifests,
    tagFiles,
    signature: {
      algorithm: "Ed25519",
      signerFingerprint: fingerprint,
      signaturePath: "signatures/seal.ed25519",
      signedBytes: "exact-seal-json-utf8",
    },
  };
  const sealBytes = jsonBytes(seal);
  const sealPath = path.join(BAG_DIR, "signatures", "seal.json");
  fs.writeFileSync(sealPath, sealBytes);
  fs.writeFileSync(path.join(BAG_DIR, "signatures", "seal.ed25519"), signBytes(null, sealBytes, privateKey));

  const tagFilesForManifest = walkRegularFiles(BAG_DIR).filter((relativePath) => !relativePath.startsWith("data/") && relativePath !== "tagmanifest-sha256.txt");
  fs.writeFileSync(path.join(BAG_DIR, "tagmanifest-sha256.txt"), buildManifest(BAG_DIR, tagFilesForManifest, "sha256"), "utf8");

  return {payloadFiles: payloadFiles.length, payloadBytes, fingerprint};
}

fs.mkdirSync(EXAMPLE_DIR, {recursive: true});
const buildResult = createBagAndSeal();
writeJson(path.join(EXAMPLE_DIR, "expected-verify.json"), {
  schemaVersion: "1.0.0",
  expectedStatusWithoutTrustStore: "valid_untrusted",
  expectedStatusWithFixtureFingerprint: "valid_trusted",
  trustedFingerprint: buildResult.fingerprint,
  evidenceId: EVIDENCE_ID,
  synthetic: true,
});

console.log(JSON.stringify({
  bag: path.relative(V1_DIR, BAG_DIR).split(path.sep).join("/"),
  payloadFiles: buildResult.payloadFiles,
  payloadBytes: buildResult.payloadBytes,
  signerFingerprint: buildResult.fingerprint,
}, null, 2));
