import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createCaseInputSchema,
  fingerprintSchema,
  initializeWorkstationInputSchema,
  inspectUsbSoftwareInputSchema,
  newKeyPassphraseSchema,
  provisionUsbInputSchema,
  usbSoftwareInspectionSchema,
} from "./index";

describe("domain validation", () => {
  it("rejects unsafe case identifiers", () => {
    assert.equal(
      createCaseInputSchema.safeParse({
        caseId: "../case",
        name: "case",
        authorizationReference: "AUTH-1",
        organization: "Lab",
        description: "",
      }).success,
      false,
    );
  });

  it("accepts only canonical trusted fingerprints", () => {
    assert.equal(
      fingerprintSchema.safeParse(`sha256:${"a".repeat(64)}`).success,
      true,
    );
    assert.equal(fingerprintSchema.safeParse("A".repeat(64)).success, false);
  });

  it("validates the USB software-maintenance contract", () => {
    assert.equal(
      inspectUsbSoftwareInputSchema.safeParse({ usbRoot: "E:\\" }).success,
      true,
    );
    assert.equal(
      usbSoftwareInspectionSchema.safeParse({
        schemaVersion: "wafc-usb-software-inspection/1",
        collectorDirectory: "E:\\Field Collector",
        bundleId: "11111111-1111-4111-8111-111111111111",
        operatorId: "operator-a",
        operatorDisplayName: "现场勘察员 A",
        assignmentIds: ["assignment-task-001"],
        currentReleaseVersion: "0.2.5",
        availableReleaseVersion: "0.2.6",
        currentReleasePublishable: false,
        availableReleasePublishable: false,
        updateNeeded: true,
      }).success,
      true,
    );
  });

  it("requires matching passphrases to be checked by the service", () => {
    const parsed = provisionUsbInputSchema.parse({
      caseId: "case-001",
      usbRoot: "E:\\",
      operator: {
        operatorId: "operator-a",
        displayName: "现场勘察员 A",
        organization: "Lab",
        keyId: "operator-key-001",
      },
      assignment: {
        assignmentId: "task-001",
        authorizationReference: "AUTH-001",
        sourceOrganization: "Lab",
        validFromUtc: "2026-08-09T00:00:00.000Z",
        validUntilUtc: "2026-08-10T00:00:00.000Z",
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
        targetDescription: "综合只读采集",
      },
      workstationPassphrase: "legacy-workstation-passphrase",
      operatorPassphrase: "Operator!A1",
      operatorPassphraseConfirmation: "Different!A1",
    });
    assert.notEqual(
      parsed.operatorPassphrase,
      parsed.operatorPassphraseConfirmation,
    );
    assert.equal(parsed.assignment.assignmentId, "assignment-task-001");
  });

  it("keeps an already canonical assignment identifier unchanged", () => {
    const parsed = provisionUsbInputSchema.parse({
      caseId: "case-001",
      usbRoot: "E:\\",
      operator: {
        operatorId: "operator-a",
        displayName: "现场勘察员 A",
        organization: "Lab",
        keyId: "operator-key-001",
      },
      assignment: {
        assignmentId: "assignment-001",
        authorizationReference: "AUTH-001",
        sourceOrganization: "Lab",
        validFromUtc: "2026-08-09T00:00:00.000Z",
        validUntilUtc: "2026-08-10T00:00:00.000Z",
        acquisitionMode: "passive_t0",
        mediaPolicy: {
          mode: "metadata_only",
          maxAssetBytes: 1,
          maxTotalBytes: 1,
          cacheLookupTimeoutSeconds: 1,
          noProgressTimeoutSeconds: 5,
          attemptTimeoutSeconds: 5,
          maxAssetDurationSeconds: 5,
          maxAttempts: 1,
          continueOnFailure: true,
        },
        targetDescription: "只读采集",
      },
      workstationPassphrase: "legacy-workstation-passphrase",
      operatorPassphrase: "Operator!A1",
      operatorPassphraseConfirmation: "Operator!A1",
    });
    assert.equal(parsed.assignment.assignmentId, "assignment-001");
  });

  it("accepts an eight-character uppercase, lowercase, digit and symbol passphrase", () => {
    assert.equal(newKeyPassphraseSchema.safeParse("Aa!bcde1").success, true);
    assert.equal(
      initializeWorkstationInputSchema.safeParse({
        workstationId: "workstation-001",
        keyId: "workstation-key-001",
        passphrase: "Aa!bcde1",
        passphraseConfirmation: "Aa!bcde1",
      }).success,
      true,
    );
  });

  it("rejects short or compositionally weak new-key passphrases", () => {
    for (const passphrase of [
      "Aa!bc1d",
      "aa!bcde1",
      "AA!BCDE1",
      "Aa1bcdef",
      "Aa!bcdef",
    ]) {
      assert.equal(
        newKeyPassphraseSchema.safeParse(passphrase).success,
        false,
        passphrase,
      );
    }
  });
});
