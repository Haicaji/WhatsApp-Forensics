import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CaseRepository } from "./node.js";

test("same WhatsApp native ids remain isolated by source", () => {
  const root = mkdtempSync(join(tmpdir(), "wafc-repository-"));
  const repository = new CaseRepository(join(root, "case.sqlite"));
  repository.initializeManifest({
    schemaVersion: "wafc-analysis-case/1",
    caseId: "a5e26f98-d91a-4aa8-92ee-a0681c344442",
    name: "重复 ID 测试",
    createdAtUtc: "2026-08-20T01:02:03.000Z",
  });

  for (const sourceId of [
    "4fc165ec-e67b-46ea-a88d-3f7f97c4e48e",
    "56f33f19-3c92-4e3d-bf51-a101221c710b",
  ]) {
    const transaction = repository.beginSessionImport({
      sourceId,
      specimenName: `检材 ${sourceId.slice(0, 4)}`,
      schemaVersion: "field-collector-session/5",
      collectionStatus: "complete",
      taskId: null,
      sessionId: sourceId,
      importFingerprint: `sha256:${sourceId.replaceAll("-", "").padEnd(64, "0")}`,
      rawRelativePath: `sources/${sourceId}/raw`,
      importedAtUtc: "2026-08-20T01:02:03.000Z",
      startedAtUtc: null,
      finishedAtUtc: null,
      warning: null,
    });
    transaction.insertChat({
      sourceId,
      nativeId: "shared-chat@g.us",
      title: `会话 ${sourceId.slice(0, 4)}`,
      kind: "group",
      participantCount: 2,
    });
    transaction.insertMessage({
      sourceId,
      nativeId: "shared-message-id",
      chatNativeId: "shared-chat@g.us",
      sortIndex: 1,
      senderId: null,
      senderDisplayName: null,
      recipientId: null,
      fromMe: false,
      timestampUtc: "2026-08-20T01:02:03.000Z",
      type: "chat",
      text: `内容 ${sourceId.slice(0, 4)}`,
      caption: null,
      quotedMessageId: null,
      isForwarded: false,
      isStarred: false,
      isRevoked: false,
      acknowledgement: null,
    });
    transaction.commit();
  }

  assert.deepEqual(repository.getCounts(), {
    sourceCount: 2,
    taskCount: 0,
    chatCount: 2,
    messageCount: 2,
  });
  const first = repository.listMessages({
    sourceId: "4fc165ec-e67b-46ea-a88d-3f7f97c4e48e",
    chatNativeId: "shared-chat@g.us",
    beforeCursor: null,
    limit: 100,
  });
  assert.equal(first.items[0]?.text, "内容 4fc1");

  repository.close();
  rmSync(root, { recursive: true, force: true });
});
