import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  CaseImportWriter,
  SqliteEvidenceRepository,
  type MessageImportInput,
} from "./node";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "wafc-repository-"));
  temporaryDirectories.push(directory);
  return join(directory, "case.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function seed(path: string): void {
  const writer = new CaseImportWriter(path);
  writer.setCaseMeta({
    caseId: "case-001",
    name: "测试案件",
    authorizationReference: "AUTH-001",
    organization: "测试机构",
    description: "",
    status: "open",
    createdAtUtc: "2026-08-09T00:00:00.000Z",
    updatedAtUtc: "2026-08-09T00:00:00.000Z",
  });
  writer.begin();
  writer.insertSource({
    sourceId: "22222222-2222-4222-8222-222222222222",
    evidenceId: "11111111-1111-4111-8111-111111111111",
    assignmentId: "assignment-001",
    operatorId: "operator-a",
    signerFingerprint: `sha256:${"a".repeat(64)}`,
    manifestRootSha256: "b".repeat(64),
    bagPath: "sources/waeb-test",
    importedAtUtc: "2026-08-09T00:00:00.000Z",
    observationStartedAtUtc: "2026-08-09T00:00:00.000Z",
    observationEndedAtUtc: "2026-08-09T00:01:00.000Z",
    localSnapshot: "verified",
    historyScope: "not_run",
    mediaScope: "not_requested",
    unresolvedReferences: 0,
  });
  writer.insertChat({
    recordId: "cht_test",
    sourceId: "22222222-2222-4222-8222-222222222222",
    title: "测试会话",
    kind: "direct",
    unreadCount: 0,
    firstObservedAtUtc: "2026-08-09T00:00:00.000Z",
    lastObservedAtUtc: "2026-08-09T00:01:00.000Z",
    contentSha256: "c".repeat(64),
    json: "{}",
  });
  const message: MessageImportInput = {
    recordId: "msg_test",
    sourceId: "22222222-2222-4222-8222-222222222222",
    chatRecordId: "cht_test",
    senderRecordId: null,
    senderDisplayName: "测试联系人",
    chatTitle: "测试会话",
    sentAtUtc: "2026-08-09T00:00:30.000Z",
    kind: "text",
    text: "这是用于检索的中文测试消息",
    caption: null,
    fromMe: false,
    edited: false,
    revoked: false,
    starred: false,
    forwarded: false,
    attachmentCount: 0,
    contentSha256: "d".repeat(64),
    json: "{}",
  };
  writer.insertMessage(message);
  writer.insertIntegrityDocuments({
    sourceId: "22222222-2222-4222-8222-222222222222",
    completenessJson: "{}",
    inventoryJson: "{}",
    verifierJson: "{}",
  });
  writer.finalizeSource(message.sourceId, {
    accountCount: 1,
    contactCount: 1,
    chatCount: 1,
    messageCount: 1,
    attachmentCount: 0,
  });
  writer.commit();
  writer.close();
}

describe("SqliteEvidenceRepository", () => {
  it("lists chats and messages through the stable repository contract", async () => {
    const path = databasePath();
    seed(path);
    const repository = new SqliteEvidenceRepository(path);
    const chats = await repository.listChats();
    assert.equal(chats.items.length, 1);
    const messages = await repository.listMessages({
      chatRecordId: chats.items[0]?.recordId ?? "",
    });
    assert.match(messages.items[0]?.text ?? "", /中文测试/u);
    await repository.close();
  });

  it("uses the FTS5 trigram index for Chinese substring search", async () => {
    const path = databasePath();
    seed(path);
    const repository = new SqliteEvidenceRepository(path);
    const hits = await repository.searchMessages({ text: "中文测试" });
    assert.equal(hits.items.length, 1);
    assert.equal(hits.items[0]?.message.recordId, "msg_test");
    await repository.close();
  });

  it("rejects malformed cursors rather than silently restarting", async () => {
    const path = databasePath();
    seed(path);
    const repository = new SqliteEvidenceRepository(path);
    await assert.rejects(
      repository.listChats({ cursor: "broken" }),
      /分页游标无效/u,
    );
    await repository.close();
  });
});
