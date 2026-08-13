import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import { SqliteEvidenceRepository } from "@wafc/evidence-repository/node";

import { WorkstationCatalog } from "./catalog";
import { EvidenceIntakeService } from "./importer";
import { ProvisioningService } from "./provisioning";

const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(__dirname, "../../../..");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const verifierExecutable = join(
  repositoryRoot,
  "tools",
  "verify-cli",
  "target",
  "release",
  `waeb-verify${executableSuffix}`,
);
const provisionerExecutable = join(
  repositoryRoot,
  "analysis-workstation",
  "tools",
  "usb-provisioner",
  "target",
  "release",
  `wafc-usb-provisioner${executableSuffix}`,
);
const releaseDirectory = join(
  repositoryRoot,
  "field-collector",
  "out",
  "whatsapp-field-collector-v0.2.6-windows-x86_64",
);
const fixtureBag = join(
  repositoryRoot,
  "spec",
  "wa-evidence-bag",
  "v1",
  "examples",
  "minimal-valid-signed",
  "waeb-11111111-1111-4111-8111-111111111111",
);
const fixtureFingerprint =
  "sha256:17f1694d3f0457248236d70a2346d7eece8862bab742a05d60d0dc1d9dc87591";

function temporaryRoot(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `wafc-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixtureCase(catalog: WorkstationCatalog): void {
  catalog.createCase(
    {
      caseId: "case-fixture",
      name: "合成证据导入案件",
      authorizationReference: "SYNTHETIC-FIXTURE-AUTHORIZATION",
      organization: "Synthetic Fixture Lab",
      description: "仅用于自动测试",
    },
    new Date("2026-01-01T00:00:00.000Z"),
  );
  catalog.registerAssignment({
    assignmentId: "assignment-synthetic-fixture",
    caseId: "case-fixture",
    operatorId: "fixture_operator",
    operatorKeyId: "fixture-key-001",
    operatorFingerprint: fixtureFingerprint,
    bundleId: "99999999-9999-4999-8999-999999999999",
    authorizationReference: "SYNTHETIC-FIXTURE-AUTHORIZATION",
    validFromUtc: "2026-01-15T00:00:00.000Z",
    validUntilUtc: "2026-01-16T00:00:00.000Z",
    operatorDisplayName: "合成操作者",
    operatorOrganization: "Synthetic Fixture Lab",
    operatorPublicKeySpkiBase64: "synthetic-public-key-for-test",
    receiptJson: "{}",
    registeredAtUtc: "2026-01-01T00:00:00.000Z",
  });
}

describe("Analysis Workstation vertical slice", () => {
  it("creates a case without storing chat bodies in the global database", () => {
    const catalog = new WorkstationCatalog(temporaryRoot("catalog"));
    const created = catalog.createCase({
      caseId: "case-001",
      name: "案件一",
      authorizationReference: "AUTH-001",
      organization: "测试机构",
      description: "",
    });
    assert.equal(created.integrity, "empty");
    const globalDatabase = readFileSync(
      join(catalog.dataRoot, "workstation.sqlite"),
    );
    assert.equal(globalDatabase.includes(Buffer.from("这是聊天正文")), false);
    assert.ok(existsSync(catalog.caseDatabasePath("case-001")));
    catalog.close();
  });

  it("accepts a trusted fixture, archives it, imports idempotently, and searches Chinese text", async () => {
    const catalog = new WorkstationCatalog(temporaryRoot("intake"));
    createFixtureCase(catalog);
    const intake = new EvidenceIntakeService({ catalog, verifierExecutable });
    const first = await intake.importEvidence("case-fixture", fixtureBag);
    assert.equal(first.status, "imported");
    assert.equal(first.chatCount, 1);
    assert.equal(first.messageCount, 3);
    const second = await intake.importEvidence("case-fixture", fixtureBag);
    assert.equal(second.status, "already_imported");
    const repository = new SqliteEvidenceRepository(
      catalog.caseDatabasePath("case-fixture"),
    );
    const chats = await repository.listChats();
    assert.equal(chats.items[0]?.title, "合成测试会话");
    const hits = await repository.searchMessages({ text: "合成的测试消息" });
    assert.equal(hits.items.length, 1);
    const integrity = await repository.getIntegrity();
    assert.equal(integrity.sourceCount, 1);
    assert.equal(integrity.trustedSourceCount, 1);
    await repository.close();
    catalog.close();
  });

  it("rejects an unregistered signer before creating an archive", async () => {
    const catalog = new WorkstationCatalog(temporaryRoot("untrusted"));
    catalog.createCase({
      caseId: "case-untrusted",
      name: "未信任测试",
      authorizationReference: "AUTH-UNTRUSTED",
      organization: "Lab",
      description: "",
    });
    const intake = new EvidenceIntakeService({ catalog, verifierExecutable });
    await assert.rejects(
      intake.importEvidence("case-untrusted", fixtureBag),
      /未在当前 Workstation 登记/u,
    );
    assert.equal(
      existsSync(join(catalog.casePaths("case-untrusted").sources, "waeb-11111111-1111-4111-8111-111111111111")),
      false,
    );
    catalog.close();
  });

  it("rejects a byte-tampered bag even when its signer is registered", async () => {
    const catalog = new WorkstationCatalog(temporaryRoot("tampered-state"));
    createFixtureCase(catalog);
    const sourceRoot = temporaryRoot("tampered-source");
    const tamperedBag = join(
      sourceRoot,
      "waeb-11111111-1111-4111-8111-111111111111",
    );
    cpSync(fixtureBag, tamperedBag, { recursive: true, errorOnExist: true });
    const messages = join(tamperedBag, "data", "normalized", "messages.ndjson");
    writeFileSync(messages, `${readFileSync(messages, "utf8")} `, "utf8");
    const intake = new EvidenceIntakeService({ catalog, verifierExecutable });
    await assert.rejects(
      intake.importEvidence("case-fixture", tamperedBag),
      /独立校验器/u,
    );
    assert.equal(
      existsSync(join(catalog.casePaths("case-fixture").sources, basename(tamperedBag))),
      false,
    );
    catalog.close();
  });

  it("does not allow an existing operator key id to be rebound to another public key", () => {
    const catalog = new WorkstationCatalog(temporaryRoot("operator-trust"));
    createFixtureCase(catalog);
    assert.throws(
      () =>
        catalog.registerAssignment({
          assignmentId: "assignment-trust-substitution",
          caseId: "case-fixture",
          operatorId: "fixture_operator",
          operatorKeyId: "fixture-key-001",
          operatorFingerprint:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          bundleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          authorizationReference: "SYNTHETIC-FIXTURE-AUTHORIZATION",
          validFromUtc: "2026-01-15T00:00:00.000Z",
          validUntilUtc: "2026-01-16T00:00:00.000Z",
          operatorDisplayName: "伪造操作者",
          operatorOrganization: "Untrusted Lab",
          operatorPublicKeySpkiBase64: "substituted-public-key",
          receiptJson: "{}",
          registeredAtUtc: "2026-01-01T00:01:00.000Z",
        }),
      /已登记为另一公钥/u,
    );
    assert.equal(catalog.listAssignments("case-fixture").length, 1);
    assert.equal(catalog.findOperatorFingerprint(fixtureFingerprint), fixtureFingerprint);
    catalog.close();
  });

  it("matches sealed USB bags to their registered cases automatically", async () => {
    const catalog = new WorkstationCatalog(temporaryRoot("automatic-intake"));
    createFixtureCase(catalog);
    const usbRoot = temporaryRoot("automatic-intake-usb");
    const sealed = join(usbRoot, "Field Collector", "evidence", "sealed");
    mkdirSync(sealed, { recursive: true });
    cpSync(fixtureBag, join(sealed, basename(fixtureBag)), {
      recursive: true,
      errorOnExist: true,
    });
    const intake = new EvidenceIntakeService({ catalog, verifierExecutable });
    const first = await intake.intakeUsbAutomatically(usbRoot);
    assert.equal(first.skipped.length, 0);
    assert.equal(first.imported.length, 1);
    assert.equal(first.imported[0]?.caseId, "case-fixture");
    assert.equal(first.imported[0]?.status, "imported");
    const second = await intake.intakeUsbAutomatically(usbRoot);
    assert.equal(second.skipped.length, 0);
    assert.equal(second.imported[0]?.status, "already_imported");
    catalog.close();
  });

  it("creates only a Field Collector folder and preserves existing USB content", async () => {
    assert.ok(existsSync(provisionerExecutable), "release provisioner must be built");
    assert.ok(existsSync(releaseDirectory), "Field Collector release must exist");
    const dataRoot = temporaryRoot("provisioning-state");
    const usbRoot = temporaryRoot("usb");
    const sentinel = join(usbRoot, "用户原有文件.txt");
    writeFileSync(sentinel, "preserve-me", "utf8");
    const catalog = new WorkstationCatalog(dataRoot);
    catalog.createCase({
      caseId: "case-usb-001",
      name: "U盘测试案件",
      authorizationReference: "AUTH-USB-001",
      organization: "测试机构",
      description: "",
    });
    const service = new ProvisioningService({
      catalog,
      provisionerExecutable,
      collectorReleaseDirectory: releaseDirectory,
    });
    await service.initializeWorkstation({
      workstationId: "lab-workstation-001",
      keyId: "workstation-key-001",
      passphrase: "Workstation!Passphrase2026",
      passphraseConfirmation: "Workstation!Passphrase2026",
    });
    const validFrom = new Date(Date.now() + 60_000);
    const validUntil = new Date(Date.now() + 86_400_000);
    const receipt = await service.provisionUsb({
      caseId: "case-usb-001",
      usbRoot,
      operator: {
        operatorId: "operator-a",
        displayName: "现场勘察员 A",
        organization: "测试机构",
        keyId: "operator-key-001",
      },
      assignment: {
        assignmentId: "usb-001",
        authorizationReference: "AUTH-USB-001",
        sourceOrganization: "测试机构",
        validFromUtc: validFrom.toISOString(),
        validUntilUtc: validUntil.toISOString(),
        acquisitionMode: "comprehensive_readonly_v02",
        mediaPolicy: {
          mode: "network_best_effort",
          maxAssetBytes: 2_147_483_648,
          maxTotalBytes: 21_474_836_480,
          cacheLookupTimeoutSeconds: 10,
          noProgressTimeoutSeconds: 120,
          attemptTimeoutSeconds: 600,
          maxAssetDurationSeconds: 1_200,
          maxAttempts: 2,
          continueOnFailure: true,
        },
        targetDescription: "经授权的综合只读采集",
      },
      workstationPassphrase: "Workstation!Passphrase2026",
      operatorPassphrase: "Operator!Passphrase2026",
      operatorPassphraseConfirmation: "Operator!Passphrase2026",
    });
    assert.equal(readFileSync(sentinel, "utf8"), "preserve-me");
    const collector = join(usbRoot, "Field Collector");
    assert.equal(receipt.collectorDirectory, collector);
    assert.ok(existsSync(join(collector, "field-collector.exe")));
    assert.ok(existsSync(join(collector, "config", "operator-key.enc")));
    assert.ok(
      existsSync(join(collector, "assignments", "assignment-usb-001.json")),
    );
    assert.ok(existsSync(join(collector, "evidence", "sealed")));
    assert.equal(receipt.assignments[0]?.assignmentId, "assignment-usb-001");
    assert.equal(
      catalog.listAssignments("case-usb-001")[0]?.assignmentId,
      "assignment-usb-001",
    );

    const operatorKey = join(collector, "config", "operator-key.enc");
    const assignment = join(
      collector,
      "assignments",
      "assignment-usb-001.json",
    );
    const keyBefore = readFileSync(operatorKey);
    const assignmentBefore = readFileSync(assignment);
    const evidenceSentinel = join(collector, "evidence", "sealed", "preserve.txt");
    writeFileSync(evidenceSentinel, "sealed-evidence-stays", "utf8");

    const deployedManifestPath = join(collector, "release-manifest.json");
    const deployedManifest = JSON.parse(
      readFileSync(deployedManifestPath, "utf8"),
    ) as { releaseVersion: string };
    deployedManifest.releaseVersion = "0.2.5-test-outdated";
    writeFileSync(
      deployedManifestPath,
      `${JSON.stringify(deployedManifest, null, 2)}\n`,
      "utf8",
    );

    const inspection = await service.inspectUsbSoftware({ usbRoot });
    assert.equal(inspection.currentReleaseVersion, "0.2.5-test-outdated");
    assert.equal(inspection.availableReleaseVersion, "0.2.6");
    assert.equal(inspection.updateNeeded, true);
    assert.equal(inspection.operatorId, "operator-a");
    assert.deepEqual(inspection.assignmentIds, ["assignment-usb-001"]);

    const update = await service.updateUsbSoftware({ usbRoot });
    assert.equal(update.status, "updated");
    assert.equal(update.previousReleaseVersion, "0.2.5-test-outdated");
    assert.equal(update.newReleaseVersion, "0.2.6");
    assert.equal(update.cleanupPending, false);
    assert.deepEqual(readFileSync(operatorKey), keyBefore);
    assert.deepEqual(readFileSync(assignment), assignmentBefore);
    assert.equal(readFileSync(evidenceSentinel, "utf8"), "sealed-evidence-stays");
    assert.deepEqual(
      readFileSync(join(collector, "release-manifest.json")),
      readFileSync(join(releaseDirectory, "release-manifest.json")),
    );
    assert.equal(
      existsSync(join(usbRoot, ".Field Collector.software-update.json")),
      false,
    );
    const current = await service.inspectUsbSoftware({ usbRoot });
    assert.equal(current.updateNeeded, false);

    const interruptedId = "22222222-2222-4222-8222-222222222222";
    const interruptedBackup = join(
      usbRoot,
      `.Field Collector.software-update.${interruptedId}.backup`,
    );
    const interruptedStaging = join(
      usbRoot,
      `.Field Collector.software-update.${interruptedId}.partial`,
    );
    renameSync(collector, interruptedBackup);
    cpSync(releaseDirectory, interruptedStaging, {
      recursive: true,
      errorOnExist: true,
    });
    writeFileSync(
      join(usbRoot, ".Field Collector.software-update.json"),
      `${JSON.stringify({
        schemaVersion: "wafc-software-update-journal/1",
        transactionId: interruptedId,
        state: "old_renamed",
        previousReleaseVersion: "0.2.6",
        newReleaseVersion: "0.2.6",
      })}\n`,
      "utf8",
    );
    const recovered = await service.inspectUsbSoftware({ usbRoot });
    assert.equal(recovered.updateNeeded, false);
    assert.equal(existsSync(collector), true);
    assert.equal(existsSync(interruptedBackup), false);
    assert.equal(existsSync(interruptedStaging), false);
    assert.equal(
      existsSync(join(usbRoot, ".Field Collector.software-update.json")),
      false,
    );

    const unexpected = join(collector, "unknown-field-tool.exe");
    writeFileSync(unexpected, "do-not-delete-silently", "utf8");
    await assert.rejects(
      service.inspectUsbSoftware({ usbRoot }),
      /无法安全归类/u,
    );
    assert.equal(readFileSync(unexpected, "utf8"), "do-not-delete-silently");
    catalog.close();
  });
});
