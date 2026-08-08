import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  assert,
  canonicalize,
  isSafeRelativePath,
  readJson,
  readNdjson,
  sha256,
  sha512,
  utf8Sort,
  walkRegularFiles,
} from "./waeb-common.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V1_DIR = path.resolve(HERE, "..");
const TRUSTED_SCHEMA_DIR = path.join(V1_DIR, "schemas");
const TRUSTED_SCHEMA_PATHS = walkRegularFiles(TRUSTED_SCHEMA_DIR);
const TRUSTED_SCHEMA_INDEX = readJson(path.join(TRUSTED_SCHEMA_DIR, "index.json"));
const TRUSTED_CAPABILITY_NAMES = [
  ...TRUSTED_SCHEMA_INDEX.datasets.map((dataset) => dataset.name),
  "media",
];
const DEFAULT_BAG = path.join(
  V1_DIR,
  "examples",
  "minimal-valid-signed",
  "waeb-11111111-1111-4111-8111-111111111111",
);

const args = process.argv.slice(2);
let bagArgument = null;
let trustedFingerprint = null;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--trusted-fingerprint") {
    trustedFingerprint = args[index + 1] || null;
    index += 1;
  } else if (!bagArgument) {
    bagArgument = args[index];
  } else {
    throw new Error(`Unexpected argument: ${args[index]}`);
  }
}
const BAG_DIR = path.resolve(bagArgument || DEFAULT_BAG);

function fileAt(relativePath) {
  assert(isSafeRelativePath(relativePath), `Unsafe relative path: ${relativePath}`);
  return path.join(BAG_DIR, ...relativePath.split("/"));
}

function parseManifest(relativePath, algorithm) {
  const filePath = fileAt(relativePath);
  const bytes = fs.readFileSync(filePath);
  assert(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), `BOM in ${relativePath}`);
  const text = bytes.toString("utf8");
  assert(!text.includes("\r"), `CR/CRLF in ${relativePath}`);
  assert(text.endsWith("\n"), `${relativePath} must end with LF`);
  const lines = text.slice(0, -1).split("\n");
  assert(lines.length > 0 && !lines.some((line) => line.length === 0), `Blank manifest line in ${relativePath}`);
  const digestLength = algorithm === "sha256" ? 64 : 128;
  const entries = lines.map((line, index) => {
    const match = line.match(new RegExp(`^([0-9a-f]{${digestLength}})  (.+)$`));
    assert(match, `Invalid ${relativePath}:${index + 1}`);
    assert(isSafeRelativePath(match[2]), `Unsafe path in ${relativePath}:${index + 1}`);
    return {digest: match[1], path: match[2]};
  });
  assert(new Set(entries.map((entry) => entry.path)).size === entries.length, `Duplicate path in ${relativePath}`);
  assert(
    JSON.stringify(entries.map((entry) => entry.path)) === JSON.stringify(utf8Sort(entries.map((entry) => entry.path))),
    `${relativePath} paths are not UTF-8 byte sorted`,
  );
  return entries;
}

function verifyManifest(relativePath, algorithm, expectedPaths) {
  const entries = parseManifest(relativePath, algorithm);
  const entryPaths = entries.map((entry) => entry.path);
  assert(JSON.stringify(entryPaths) === JSON.stringify(utf8Sort(expectedPaths)), `${relativePath} coverage mismatch`);
  const hash = algorithm === "sha256" ? sha256 : sha512;
  for (const entry of entries) {
    const actual = hash(fs.readFileSync(fileAt(entry.path)));
    assert(actual === entry.digest, `${relativePath} hash mismatch: ${entry.path}`);
  }
  return entries;
}

function verifyBagIt() {
  const expectedBagIt = "BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n";
  assert(fs.readFileSync(fileAt("bagit.txt"), "utf8") === expectedBagIt, "Invalid bagit.txt");
  const payloadPaths = walkRegularFiles(fileAt("data")).map((relativePath) => `data/${relativePath}`);
  verifyManifest("manifest-sha256.txt", "sha256", payloadPaths);
  verifyManifest("manifest-sha512.txt", "sha512", payloadPaths);
  const tagPaths = walkRegularFiles(BAG_DIR).filter(
    (relativePath) => !relativePath.startsWith("data/") && relativePath !== "tagmanifest-sha256.txt",
  );
  verifyManifest("tagmanifest-sha256.txt", "sha256", tagPaths);

  const bagInfo = fs.readFileSync(fileAt("bag-info.txt"), "utf8");
  assert(!bagInfo.includes("\r"), "CR/CRLF in bag-info.txt");
  const oxumMatch = bagInfo.match(/^Payload-Oxum: ([0-9]+)\.([0-9]+)$/m);
  assert(oxumMatch, "Missing Payload-Oxum");
  const actualBytes = payloadPaths.reduce((sum, relativePath) => sum + fs.statSync(fileAt(relativePath)).size, 0);
  assert(Number(oxumMatch[1]) === actualBytes, "Payload-Oxum byte count mismatch");
  assert(Number(oxumMatch[2]) === payloadPaths.length, "Payload-Oxum file count mismatch");
  return {payloadPaths, payloadBytes: actualBytes, tagPaths};
}

function verifySchemas() {
  const schemaPaths = walkRegularFiles(fileAt("schemas"));
  assert(
    JSON.stringify(schemaPaths) === JSON.stringify(TRUSTED_SCHEMA_PATHS),
    "Embedded schema file set differs from trusted v1 contract",
  );
  for (const relativePath of schemaPaths) {
    assert(relativePath.endsWith(".json"), `Non-JSON schema tag file: ${relativePath}`);
    readJson(fileAt(`schemas/${relativePath}`));
    const embedded = fs.readFileSync(fileAt(`schemas/${relativePath}`));
    const trusted = fs.readFileSync(path.join(TRUSTED_SCHEMA_DIR, ...relativePath.split("/")));
    assert(embedded.equals(trusted), `Embedded schema differs from trusted v1 contract: ${relativePath}`);
  }
  const index = readJson(fileAt("schemas/index.json"));
  assert(index.waEvidenceBagVersion === "1.0.0-draft.1", "Unsupported schema index version");
  return TRUSTED_SCHEMA_INDEX;
}

function verifyNormalizedAndRaw(schemaIndex, sourceId) {
  const allRecords = [];
  const recordsByDataset = new Map();
  for (const dataset of schemaIndex.datasets) {
    const records = readNdjson(fileAt(dataset.path));
    recordsByDataset.set(dataset.name, records);
    for (const record of records) {
      assert(record.schemaVersion === "1.0.0", `Bad record schemaVersion in ${dataset.path}`);
      assert(record.recordType === dataset.recordType, `recordType mismatch in ${dataset.path}`);
      assert(typeof record.recordId === "string" && /^[a-z][a-z0-9_]{7,127}$/.test(record.recordId), `Bad recordId in ${dataset.path}`);
      assert(record.sourceId === sourceId, `sourceId mismatch in ${dataset.path}`);
      const expectedContentHash = sha256(Buffer.from(canonicalize(record.data), "utf8"));
      assert(record.contentSha256 === expectedContentHash, `contentSha256 mismatch: ${record.recordId}`);
      assert(Array.isArray(record.provenance) && record.provenance.length > 0, `Missing provenance: ${record.recordId}`);
      allRecords.push(record);
    }
  }
  assert(new Set(allRecords.map((record) => record.recordId)).size === allRecords.length, "Duplicate normalized recordId");

  const rawRecords = new Map();
  for (const relativePath of walkRegularFiles(fileAt("data/raw"))) {
    if (!relativePath.endsWith(".ndjson")) continue;
    const bagPath = `data/raw/${relativePath}`;
    for (const record of readNdjson(fileAt(bagPath))) {
      const expectedContentHash = sha256(Buffer.from(canonicalize(record.value), "utf8"));
      assert(record.contentSha256 === expectedContentHash, `Raw content hash mismatch: ${record.recordId}`);
      const key = `${bagPath}#${record.recordId}`;
      assert(!rawRecords.has(key), `Duplicate raw record: ${key}`);
      rawRecords.set(key, record);
    }
  }
  for (const record of allRecords) {
    for (const provenance of record.provenance) {
      if (!provenance.rawRef) {
        assert(typeof provenance.absenceReason === "string", `Missing rawRef reason: ${record.recordId}`);
        continue;
      }
      const key = `${provenance.rawRef.path}#${provenance.rawRef.recordId}`;
      const raw = rawRecords.get(key);
      assert(raw, `Dangling rawRef: ${key}`);
      assert(raw.contentSha256 === provenance.rawRef.contentSha256, `rawRef hash mismatch: ${key}`);
    }
  }

  const byId = new Map(allRecords.map((record) => [record.recordId, record]));
  for (const record of recordsByDataset.get("chats") || []) {
    for (const participantId of record.data.participantRecordIds) assert(byId.has(participantId), `Dangling chat participant: ${participantId}`);
  }
  for (const record of recordsByDataset.get("participants") || []) {
    assert(byId.has(record.data.containerRecordId), `Dangling participant container: ${record.recordId}`);
    assert(byId.has(record.data.subjectRecordId), `Dangling participant subject: ${record.recordId}`);
  }
  for (const record of recordsByDataset.get("messages") || []) {
    assert(byId.has(record.data.container.recordId), `Dangling message container: ${record.recordId}`);
    if (record.data.senderRecordId) assert(byId.has(record.data.senderRecordId), `Dangling sender: ${record.recordId}`);
    for (const recipientId of record.data.recipientRecordIds) assert(byId.has(recipientId), `Dangling recipient: ${record.recordId}`);
  }
  return {allRecords, recordsByDataset};
}

function verifyDatasetState(dataset) {
  const hasReasons = Array.isArray(dataset.reasonCodes) && dataset.reasonCodes.length > 0;
  if (dataset.requestState === "not_requested") {
    assert(dataset.result === "not_requested", `not_requested request/result mismatch: ${dataset.name}`);
    assert(dataset.recordCount === 0 && dataset.byteLength === 0, `not_requested dataset must be empty: ${dataset.name}`);
    assert(dataset.observationWindow === null && hasReasons, `not_requested dataset metadata mismatch: ${dataset.name}`);
    return;
  }
  if (dataset.capability === "unsupported") {
    assert(dataset.result === "unsupported", `Unsupported dataset must use result unsupported: ${dataset.name}`);
    assert(dataset.recordCount === 0 && dataset.byteLength === 0, `Unsupported dataset must be empty: ${dataset.name}`);
    assert(dataset.observationWindow === null && hasReasons, `Unsupported dataset metadata mismatch: ${dataset.name}`);
    return;
  }
  if (dataset.result === "empty") {
    assert(dataset.capability === "supported", `Empty dataset must be supported: ${dataset.name}`);
    assert(dataset.recordCount === 0 && dataset.byteLength === 0, `Empty dataset has records: ${dataset.name}`);
    assert(dataset.observationWindow !== null, `Empty dataset lacks observation window: ${dataset.name}`);
    return;
  }
  if (dataset.result === "complete_as_observed") {
    assert(dataset.capability === "supported", `Completed dataset must be supported: ${dataset.name}`);
    assert(dataset.recordCount > 0 && dataset.byteLength > 0, `Completed dataset is empty: ${dataset.name}`);
    assert(dataset.observationWindow !== null, `Completed dataset lacks observation window: ${dataset.name}`);
    return;
  }
  if (dataset.result === "partial") {
    assert(dataset.capability === "supported" && dataset.observationWindow !== null && hasReasons, `Partial dataset metadata mismatch: ${dataset.name}`);
    return;
  }
  assert(dataset.result === "failed", `Invalid requested dataset result: ${dataset.name}`);
  assert(["supported", "unknown"].includes(dataset.capability), `Invalid failed capability: ${dataset.name}`);
  assert(dataset.recordCount === 0 && dataset.byteLength === 0 && hasReasons, `Failed dataset metadata mismatch: ${dataset.name}`);
}

function verifyInventory(schemaIndex, recordsByDataset, sourceId) {
  const inventory = readJson(fileAt("data/dataset-inventory.json"));
  assert(inventory.sourceId === sourceId, "Inventory sourceId mismatch");
  const expectedNames = schemaIndex.datasets.map((dataset) => dataset.name);
  const expectedPaths = schemaIndex.datasets.map((dataset) => dataset.path);
  const inventoryNames = inventory.datasets.map((dataset) => dataset.name);
  const inventoryPaths = inventory.datasets.map((dataset) => dataset.path);
  assert(new Set(expectedNames).size === expectedNames.length, "Duplicate schema-index dataset name");
  assert(new Set(expectedPaths).size === expectedPaths.length, "Duplicate schema-index dataset path");
  assert(new Set(inventoryNames).size === inventoryNames.length, "Duplicate inventory dataset name");
  assert(new Set(inventoryPaths).size === inventoryPaths.length, "Duplicate inventory dataset path");
  assert(JSON.stringify(inventoryNames) === JSON.stringify(expectedNames), "Inventory dataset names/order mismatch");
  assert(JSON.stringify(inventoryPaths) === JSON.stringify(expectedPaths), "Inventory dataset paths/order mismatch");
  for (let index = 0; index < inventory.datasets.length; index += 1) {
    const dataset = inventory.datasets[index];
    const registered = schemaIndex.datasets[index];
    assert(dataset.path === registered.path && dataset.recordType === registered.recordType, `Inventory registry mismatch: ${dataset.name}`);
    const records = recordsByDataset.get(dataset.name);
    assert(dataset.recordCount === records.length, `Inventory record count mismatch: ${dataset.name}`);
    assert(dataset.byteLength === fs.statSync(fileAt(dataset.path)).size, `Inventory byte length mismatch: ${dataset.name}`);
    verifyDatasetState(dataset);
  }
  return inventory;
}

function verifyCapabilities(schemaIndex, sourceId) {
  const document = readJson(fileAt("data/diagnostics/capabilities.json"));
  assert(document.sourceId === sourceId, "Capabilities sourceId mismatch");
  const expectedNames = TRUSTED_CAPABILITY_NAMES;
  const actualNames = document.capabilities.map((capability) => capability.name);
  assert(new Set(actualNames).size === actualNames.length, "Duplicate capability name");
  assert(JSON.stringify(actualNames) === JSON.stringify(expectedNames), "Capability names/order mismatch");
  for (const capability of document.capabilities) {
    const hasAdapter = typeof capability.adapter === "string" && capability.adapter.length > 0;
    const hasReasons = Array.isArray(capability.reasonCodes) && capability.reasonCodes.length > 0;
    if (capability.result === "supported") assert(hasAdapter, `Supported capability lacks adapter: ${capability.name}`);
    else if (capability.result === "degraded") assert(hasAdapter && hasReasons, `Degraded capability metadata mismatch: ${capability.name}`);
    else if (capability.result === "unsupported") assert(capability.adapter === null && hasReasons, `Unsupported capability metadata mismatch: ${capability.name}`);
    else assert(capability.result === "error" && hasReasons, `Error capability metadata mismatch: ${capability.name}`);
  }
  return document;
}

function verifyMedia(allRecords, sourceId) {
  const mediaRecords = readNdjson(fileAt("data/indexes/media.ndjson"));
  const assets = new Map();
  const recordIds = new Set(allRecords.map((record) => record.recordId));
  for (const media of mediaRecords) {
    assert(media.sourceId === sourceId, `Media sourceId mismatch: ${media.assetId}`);
    assert(!assets.has(media.assetId), `Duplicate media assetId: ${media.assetId}`);
    assets.set(media.assetId, media);
    for (const recordId of media.sourceRecordIds) assert(recordIds.has(recordId), `Dangling media source: ${recordId}`);
    if (media.acquisitionStatus === "available") {
      assert(media.cas && /^data\/media\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(media.cas.path), `Invalid CAS path: ${media.assetId}`);
      assert(media.cas.path.endsWith(`/${media.cas.digest}`), `CAS path/digest mismatch: ${media.assetId}`);
      const bytes = fs.readFileSync(fileAt(media.cas.path));
      assert(bytes.length === media.cas.byteLength, `CAS size mismatch: ${media.assetId}`);
      assert(sha256(bytes) === media.cas.digest, `CAS hash mismatch: ${media.assetId}`);
    } else {
      assert(media.cas === null, `Unavailable media must not have CAS: ${media.assetId}`);
    }
  }
  for (const record of allRecords.filter((item) => item.recordType === "message")) {
    for (const assetId of record.data.attachmentAssetIds) assert(assets.has(assetId), `Dangling attachment asset: ${assetId}`);
  }
  return mediaRecords;
}

function verifyLog() {
  const events = readNdjson(fileAt("data/logs/acquisition.ndjson"));
  assert(events.length > 0, "Empty acquisition log");
  let previous = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    assert(event.sequence === String(index + 1), `Bad log sequence: ${event.sequence}`);
    assert(event.previousEventHash === previous, `Broken previousEventHash at sequence ${event.sequence}`);
    const withoutHash = {...event};
    delete withoutHash.eventHash;
    const previousBytes = previous ? Buffer.from(previous, "hex") : Buffer.alloc(32, 0);
    const expected = sha256(Buffer.concat([
      Buffer.from("WAEB-LOG-v1\0", "utf8"),
      previousBytes,
      Buffer.from(canonicalize(withoutHash), "utf8"),
    ]));
    assert(event.eventHash === expected, `Broken eventHash at sequence ${event.sequence}`);
    previous = event.eventHash;
  }
  const acquisition = readJson(fileAt("data/acquisition.json"));
  assert(acquisition.log.eventCount === events.length, "Acquisition event count mismatch");
  assert(acquisition.log.terminalEventHash === previous, "Acquisition terminal hash mismatch");
  return {events, acquisition};
}

function verifySeal() {
  const signer = readJson(fileAt("signatures/signer.json"));
  const sealBytes = fs.readFileSync(fileAt("signatures/seal.json"));
  const seal = JSON.parse(sealBytes.toString("utf8"));
  const signature = fs.readFileSync(fileAt("signatures/seal.ed25519"));
  const publicSpki = Buffer.from(signer.publicKeySpkiBase64, "base64");
  const fingerprint = `sha256:${sha256(publicSpki)}`;
  assert(fingerprint === signer.publicKeyFingerprint, "Signer fingerprint mismatch");
  assert(fingerprint === seal.signature.signerFingerprint, "Seal signer fingerprint mismatch");
  const publicKey = createPublicKey({key: publicSpki, format: "der", type: "spki"});
  assert(verifySignature(null, sealBytes, publicKey, signature), "Invalid Ed25519 signature");

  const payloadManifestPaths = seal.payloadManifests.map((entry) => entry.path);
  const expectedPayloadManifestPaths = ["manifest-sha256.txt", "manifest-sha512.txt"];
  assert(new Set(payloadManifestPaths).size === payloadManifestPaths.length, "Duplicate payload manifest in seal");
  assert(JSON.stringify(payloadManifestPaths) === JSON.stringify(expectedPayloadManifestPaths), "Seal payload manifest coverage/order mismatch");

  const tagFilePaths = seal.tagFiles.map((entry) => entry.path);
  const expectedTagFilePaths = utf8Sort([
    "bagit.txt",
    "bag-info.txt",
    ...TRUSTED_SCHEMA_PATHS.map((relativePath) => `schemas/${relativePath}`),
    "signatures/signer.json",
  ]);
  assert(new Set(tagFilePaths).size === tagFilePaths.length, "Duplicate core tag file in seal");
  assert(JSON.stringify(tagFilePaths) === JSON.stringify(expectedTagFilePaths), "Seal core tag coverage/order mismatch");

  for (const entry of [...seal.payloadManifests, ...seal.tagFiles]) {
    assert(sha256(fs.readFileSync(fileAt(entry.path))) === entry.sha256, `Seal digest mismatch: ${entry.path}`);
  }
  const expectedRoot = sha256(Buffer.from(canonicalize({payloadManifests: seal.payloadManifests, tagFiles: seal.tagFiles}), "utf8"));
  assert(seal.manifestRootSha256 === expectedRoot, "Seal manifest root mismatch");
  const trusted = trustedFingerprint === fingerprint;
  return {seal, fingerprint, trusted};
}

function verifyCompleteness(mediaRecords, inventory, allRecords, sourceId) {
  const completeness = readJson(fileAt("data/completeness.json"));
  const chatCompleteness = readNdjson(fileAt("data/completeness/chats.ndjson"));
  assert(completeness.sourceId === sourceId, "Completeness sourceId mismatch");
  const expectedMediaCounts = {
    requested: mediaRecords.filter((record) => record.acquisitionStatus !== "not_requested").length,
    full: mediaRecords.filter((record) => record.acquisitionStatus === "available" && record.role === "full").length,
    thumbnail: mediaRecords.filter((record) => record.acquisitionStatus === "available" && record.role === "thumbnail").length,
    missing: mediaRecords.filter((record) => record.acquisitionStatus === "missing").length,
    expired: mediaRecords.filter((record) => record.acquisitionStatus === "expired").length,
    decryptError: mediaRecords.filter((record) => record.acquisitionStatus === "decrypt_error").length,
    notRequested: mediaRecords.filter((record) => record.acquisitionStatus === "not_requested").length,
  };
  for (const [name, expected] of Object.entries(expectedMediaCounts)) {
    assert(completeness.mediaCounts[name] === expected, `Completeness media ${name} count mismatch`);
  }
  assert(completeness.accountScope === "unverifiable", "accountScope must be unverifiable");
  const chats = new Set(allRecords.filter((record) => record.recordType === "chat").map((record) => record.recordId));
  const coveredChats = chatCompleteness.map((record) => record.chatRecordId);
  assert(new Set(coveredChats).size === coveredChats.length, "Duplicate chat completeness record");
  assert(coveredChats.length === chats.size && coveredChats.every((recordId) => chats.has(recordId)), "Chat completeness coverage mismatch");
  for (const record of chatCompleteness) {
    assert(record.sourceId === sourceId, `Chat completeness sourceId mismatch: ${record.chatRecordId}`);
    assert(record.finalMessageCount >= record.initialMessageCount, `Chat message count regressed: ${record.chatRecordId}`);
  }
  assert(completeness.crossChecks.inventoryCountsMatch === true, "Completeness inventory cross-check is false");
  assert(completeness.crossChecks.mediaIndexMatchesCas === true, "Completeness media cross-check is false");
  assert(completeness.crossChecks.normalizedRefsResolved === true, "Completeness reference cross-check is false");
  assert(completeness.crossChecks.differences.length === 0, "Completeness reports unresolved differences");
  if (completeness.mediaScope === "complete") {
    assert(expectedMediaCounts.missing + expectedMediaCounts.expired + expectedMediaCounts.decryptError + expectedMediaCounts.notRequested === 0, "Complete media scope has unavailable assets");
  } else if (completeness.mediaScope === "not_requested") {
    assert(expectedMediaCounts.requested === 0, "not_requested media scope has attempted assets");
  }
  const incompleteDatasets = inventory.datasets.filter((dataset) => !["empty", "complete_as_observed"].includes(dataset.result));
  if (completeness.overall === "complete_as_observed") {
    assert(completeness.localSnapshot === "verified", "Complete result requires verified local snapshot");
    assert(incompleteDatasets.length === 0, "Complete result has incomplete datasets");
    assert(completeness.mediaScope === "complete", "Complete result requires complete media scope");
  } else {
    assert(completeness.reasonCodes.length > 0, `${completeness.overall} completeness lacks reason codes`);
  }
  return {completeness, chatCompleteness};
}

try {
  assert(fs.existsSync(BAG_DIR) && fs.statSync(BAG_DIR).isDirectory(), `Bag directory not found: ${BAG_DIR}`);
  const bag = verifyBagIt();
  const schemaIndex = verifySchemas();
  const log = verifyLog();
  const sourceId = log.acquisition.sourceId;
  const capabilities = verifyCapabilities(schemaIndex, sourceId);
  const normalized = verifyNormalizedAndRaw(schemaIndex, sourceId);
  const inventory = verifyInventory(schemaIndex, normalized.recordsByDataset, sourceId);
  const media = verifyMedia(normalized.allRecords, sourceId);
  const sealed = verifySeal();
  const coverage = verifyCompleteness(media, inventory, normalized.allRecords, sourceId);
  assert(log.acquisition.evidenceId === sealed.seal.evidenceId, "Evidence ID mismatch between acquisition and seal");
  assert(log.acquisition.sourceId === inventory.sourceId, "Source ID mismatch between acquisition and inventory");
  assert(capabilities.sourceId === inventory.sourceId, "Source ID mismatch between capabilities and inventory");

  const status = sealed.trusted ? "valid_trusted" : "valid_untrusted";
  console.log(JSON.stringify({
    status,
    waEvidenceBagVersion: schemaIndex.waEvidenceBagVersion,
    evidenceId: sealed.seal.evidenceId,
    payloadFiles: bag.payloadPaths.length,
    payloadBytes: bag.payloadBytes,
    tagFiles: bag.tagPaths.length,
    normalizedRecords: normalized.allRecords.length,
    datasets: inventory.datasets.length,
    mediaAssets: media.length,
    logEvents: log.events.length,
    chatCompletenessRecords: coverage.chatCompleteness.length,
    signature: {
      mathematicalValidity: true,
      trusted: sealed.trusted,
      fingerprint: sealed.fingerprint,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({status: "invalid", error: error.message}, null, 2));
  process.exitCode = 1;
}
