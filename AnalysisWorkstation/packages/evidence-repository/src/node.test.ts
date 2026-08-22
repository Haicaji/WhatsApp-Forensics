import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
      phoneNumber: null,
      formattedPhoneNumber: null,
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
      isStarred: true,
      isRevoked: false,
      acknowledgement: null,
    });
    transaction.insertAttachment({
      opaqueId: sourceId,
      sourceId,
      messageNativeId: "shared-message-id",
      relativePath: "media/example.png",
      kind: "image",
      status: "available",
      mimeType: "image/png",
      fileName: "example.png",
      sizeBytes: 128,
      failureReason: null,
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
  const chats = repository.listChats({
    sourceId: "4fc165ec-e67b-46ea-a88d-3f7f97c4e48e",
    search: "",
    cursor: null,
    limit: 20,
  });
  assert.equal(chats.items[0]?.mediaCount, 1);
  assert.equal(chats.items[0]?.starredMessageCount, 1);
  assert.equal(chats.items[0]?.avatarUrl, null);
  assert.equal(chats.items[0]?.community, null);

  repository.close();
  rmSync(root, { recursive: true, force: true });
});

test("legacy cases gain phone columns and can backfill contact identities", () => {
  const root = mkdtempSync(join(tmpdir(), "wafc-repository-phone-migration-"));
  const databasePath = join(root, "case.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE chats (
      source_id TEXT NOT NULL,
      native_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      participant_count INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_at_utc TEXT,
      last_message_preview TEXT,
      PRIMARY KEY (source_id, native_id)
    ) STRICT;
  `);
  legacy.close();

  const repository = new CaseRepository(databasePath);
  const sourceId = "d2d2dc64-5c59-44a6-a699-36fed92d3d02";
  const transaction = repository.beginSessionImport({
    sourceId,
    specimenName: "联系人手机",
    schemaVersion: "field-collector-session/5",
    collectionStatus: "complete",
    taskId: null,
    sessionId: sourceId,
    importFingerprint: `sha256:${"1".repeat(64)}`,
    rawRelativePath: `sources/${sourceId}/raw`,
    importedAtUtc: "2026-08-22T01:02:03.000Z",
    startedAtUtc: null,
    finishedAtUtc: null,
    warning: null,
  });
  transaction.insertChat({
    sourceId,
    nativeId: "259567069958235@lid",
    title: "JJ",
    phoneNumber: null,
    formattedPhoneNumber: null,
    kind: "chat",
    participantCount: 0,
  });
  transaction.commit();
  repository.backfillChatPhoneIdentities(sourceId, [{
    nativeId: "259567069958235@lid",
    phoneNumber: "8615880921237",
    formattedPhoneNumber: "+8615880921237",
  }]);

  const chat = repository.listChats({ sourceId, search: "", cursor: null, limit: 20 }).items[0];
  assert.equal(chat?.phoneNumber, "8615880921237");
  assert.equal(chat?.formattedPhoneNumber, "+8615880921237");
  repository.close();
  rmSync(root, { recursive: true, force: true });
});
