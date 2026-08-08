import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createCaseInputSchema,
  fingerprintSchema,
  provisionUsbInputSchema,
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
        assignmentId: "assignment-001",
        authorizationReference: "AUTH-001",
        sourceOrganization: "Lab",
        validFromUtc: "2026-08-09T00:00:00.000Z",
        validUntilUtc: "2026-08-10T00:00:00.000Z",
        targetDescription: "只读 T0",
      },
      workstationPassphrase: "workstation-passphrase",
      operatorPassphrase: "operator-passphrase",
      operatorPassphraseConfirmation: "different-passphrase",
    });
    assert.notEqual(
      parsed.operatorPassphrase,
      parsed.operatorPassphraseConfirmation,
    );
  });
});
