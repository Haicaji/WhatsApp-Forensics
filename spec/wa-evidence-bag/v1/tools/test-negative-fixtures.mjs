#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createPrivateKey, sign as signBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  buildManifest,
  canonicalize,
  jsonBytes,
  readJson,
  sha256,
  utf8Sort,
  walkRegularFiles,
  writeJson,
} from "./waeb-common.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const v1Dir = path.resolve(here, "..");
const sourceBag = path.join(
  v1Dir,
  "examples",
  "minimal-valid-signed",
  "waeb-11111111-1111-4111-8111-111111111111",
);
const verifier = path.join(here, "verify-example.mjs");
const privateJwkSource = readJson(path.join(v1Dir, "test-vectors", "keys", "test-only-ed25519-private.jwk"));
const privateKey = createPrivateKey({
  key: {
    kty: privateJwkSource.kty,
    crv: privateJwkSource.crv,
    x: privateJwkSource.x,
    d: privateJwkSource.d,
  },
  format: "jwk",
});

function rewritePayloadMetadata(bagDir) {
  const payloadPaths = walkRegularFiles(path.join(bagDir, "data")).map((name) => `data/${name}`);
  const payloadBytes = payloadPaths.reduce(
    (sum, relativePath) => sum + fs.statSync(path.join(bagDir, ...relativePath.split("/"))).size,
    0,
  );
  const bagInfoPath = path.join(bagDir, "bag-info.txt");
  const bagInfo = fs.readFileSync(bagInfoPath, "utf8").replace(
    /^Payload-Oxum: [0-9]+\.[0-9]+$/m,
    `Payload-Oxum: ${payloadBytes}.${payloadPaths.length}`,
  );
  fs.writeFileSync(bagInfoPath, bagInfo, "utf8");
  fs.writeFileSync(path.join(bagDir, "manifest-sha256.txt"), buildManifest(bagDir, payloadPaths, "sha256"), "utf8");
  fs.writeFileSync(path.join(bagDir, "manifest-sha512.txt"), buildManifest(bagDir, payloadPaths, "sha512"), "utf8");
}

function reseal(bagDir, mutateSeal = () => {}) {
  rewritePayloadMetadata(bagDir);
  const signer = readJson(path.join(bagDir, "signatures", "signer.json"));
  const previousSeal = readJson(path.join(bagDir, "signatures", "seal.json"));
  const payloadManifests = ["manifest-sha256.txt", "manifest-sha512.txt"].map((relativePath) => ({
    path: relativePath,
    sha256: sha256(fs.readFileSync(path.join(bagDir, relativePath))),
  }));
  const schemaFiles = walkRegularFiles(path.join(bagDir, "schemas")).map((name) => `schemas/${name}`);
  const coreTagPaths = utf8Sort(["bagit.txt", "bag-info.txt", ...schemaFiles, "signatures/signer.json"]);
  const tagFiles = coreTagPaths.map((relativePath) => ({
    path: relativePath,
    sha256: sha256(fs.readFileSync(path.join(bagDir, ...relativePath.split("/")))),
  }));
  const seal = {
    ...previousSeal,
    payloadManifests,
    tagFiles,
    signature: {
      algorithm: "Ed25519",
      signerFingerprint: signer.publicKeyFingerprint,
      signaturePath: "signatures/seal.ed25519",
      signedBytes: "exact-seal-json-utf8",
    },
  };
  mutateSeal(seal);
  seal.manifestRootSha256 = sha256(Buffer.from(canonicalize({
    payloadManifests: seal.payloadManifests,
    tagFiles: seal.tagFiles,
  }), "utf8"));
  const sealBytes = jsonBytes(seal);
  fs.writeFileSync(path.join(bagDir, "signatures", "seal.json"), sealBytes);
  fs.writeFileSync(path.join(bagDir, "signatures", "seal.ed25519"), signBytes(null, sealBytes, privateKey));
  const tagPaths = walkRegularFiles(bagDir).filter(
    (relativePath) => !relativePath.startsWith("data/") && relativePath !== "tagmanifest-sha256.txt",
  );
  fs.writeFileSync(path.join(bagDir, "tagmanifest-sha256.txt"), buildManifest(bagDir, tagPaths, "sha256"), "utf8");
}

function expectVerifierFailure(bagDir, expectedFragment) {
  const result = spawnSync(process.execPath, [verifier, bagDir], {encoding: "utf8"});
  assert(result.status !== 0, `Verifier accepted negative fixture: ${path.basename(bagDir)}`);
  const output = `${result.stdout}\n${result.stderr}`;
  assert(output.includes(expectedFragment), `Unexpected verifier failure for ${path.basename(bagDir)}: ${output}`);
}

const tempBase = path.resolve(os.tmpdir());
const tempRoot = fs.mkdtempSync(path.join(tempBase, "waeb-negative-"));
let passed = 0;

function runCase(name, mutatePayload, mutateSeal, expectedFragment) {
  const bagDir = path.join(tempRoot, name);
  fs.cpSync(sourceBag, bagDir, {recursive: true});
  mutatePayload(bagDir);
  reseal(bagDir, mutateSeal);
  expectVerifierFailure(bagDir, expectedFragment);
  passed += 1;
}

try {
  runCase(
    "duplicate-payload-manifest",
    () => {},
    (seal) => { seal.payloadManifests[1] = {...seal.payloadManifests[0]}; },
    "Duplicate payload manifest in seal",
  );
  runCase(
    "missing-core-tag",
    () => {},
    (seal) => { seal.tagFiles.pop(); },
    "Seal core tag coverage/order mismatch",
  );
  runCase(
    "duplicate-dataset",
    (bagDir) => {
      const inventoryPath = path.join(bagDir, "data", "dataset-inventory.json");
      const inventory = readJson(inventoryPath);
      inventory.datasets[1] = {...inventory.datasets[0]};
      writeJson(inventoryPath, inventory);
    },
    () => {},
    "Duplicate inventory dataset name",
  );
  runCase(
    "unsupported-completed-dataset",
    (bagDir) => {
      const inventoryPath = path.join(bagDir, "data", "dataset-inventory.json");
      const inventory = readJson(inventoryPath);
      inventory.datasets[5].capability = "unsupported";
      writeJson(inventoryPath, inventory);
    },
    () => {},
    "Unsupported dataset must use result unsupported",
  );
  runCase(
    "duplicate-capability",
    (bagDir) => {
      const capabilitiesPath = path.join(bagDir, "data", "diagnostics", "capabilities.json");
      const capabilities = readJson(capabilitiesPath);
      capabilities.capabilities[1].name = capabilities.capabilities[0].name;
      writeJson(capabilitiesPath, capabilities);
    },
    () => {},
    "Duplicate capability name",
  );
  runCase(
    "extra-embedded-schema",
    (bagDir) => {
      writeJson(path.join(bagDir, "schemas", "extra.json"), {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://schemas.whatsapp-forensics.invalid/waeb/v1/extra.json",
        type: "object",
      });
    },
    () => {},
    "Embedded schema file set differs from trusted v1 contract",
  );
  runCase(
    "modified-schema-index",
    (bagDir) => {
      const indexPath = path.join(bagDir, "schemas", "index.json");
      const index = readJson(indexPath);
      index.datasets[0].name = "accounts_modified";
      writeJson(indexPath, index);
    },
    () => {},
    "Embedded schema differs from trusted v1 contract: index.json",
  );
  console.log(JSON.stringify({status: "negative_fixtures_rejected", cases: passed}, null, 2));
} finally {
  const resolvedTemp = path.resolve(tempRoot);
  const safePrefix = `${tempBase}${path.sep}`.toLocaleLowerCase("en-US");
  assert(resolvedTemp.toLocaleLowerCase("en-US").startsWith(safePrefix), "Refusing unsafe temporary cleanup");
  assert(path.basename(resolvedTemp).startsWith("waeb-negative-"), "Unexpected temporary cleanup target");
  fs.rmSync(resolvedTemp, {recursive: true, force: true});
}
