import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PortableTask } from "@wafc/domain";

import {
  sanitizeCaseDirectoryName,
  WorkstationService,
} from "./index.js";

const MESSAGE_HEADERS = [
  "id",
  "chatId",
  "senderId",
  "recipientId",
  "fromMe",
  "timestamp",
  "type",
  "text",
  "caption",
  "quotedMessageId",
  "isForwarded",
  "isStarred",
  "isRevoked",
  "acknowledgement",
  "hasMedia",
  "mediaMimeType",
  "mediaFileName",
  "mediaSize",
  "mediaDurationSeconds",
] as const;

type SyntheticSessionOptions = {
  specimenName: string;
  status?: "complete" | "cancelled" | "failed";
  task?: PortableTask;
  sessionId?: string;
  text?: string;
  messageChatId?: string;
  unsafeMediaPath?: string;
};

function writePayload(root: string): void {
  mkdirSync(join(root, "extension"), { recursive: true });
  writeFileSync(join(root, "Field Collector.exe"), "synthetic executable");
  writeFileSync(join(root, "extension", "manifest.json"), "{}\n");
  writeFileSync(join(root, "payload-manifest.json"), "{}\n");
  writeFileSync(join(root, "LICENSE"), "synthetic test license\n");
  writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "synthetic notices\n");
}

function csvRow(values: readonly string[]): string {
  return values
    .map((value) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value)
    .join(",");
}

function writeSyntheticSession(root: string, options: SyntheticSessionOptions): void {
  const chatRoot = join(root, "chats", "1_family@g.us");
  mkdirSync(join(chatRoot, "media"), { recursive: true });
  mkdirSync(join(root, "media", "objects", "aa"), { recursive: true });
  const schemaVersion = options.task === undefined
    ? "field-collector-session/5"
    : "field-collector-session/6";
  const messageChatId = options.messageChatId ?? "family@g.us";
  const manifest: Record<string, unknown> = {
    schemaVersion,
    status: options.status ?? "complete",
    startedAt: "2026-08-20T01:00:00.000Z",
    finishedAt: "2026-08-20T01:05:00.000Z",
    evidenceItem: { name: options.specimenName },
    chatCount: 1,
  };
  if (options.task !== undefined) {
    manifest.sessionId = options.sessionId;
    const { resultDirectory: _resultDirectory, ...taskReference } = options.task;
    manifest.task = taskReference;
  }
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(root, "account.json"), '{"id":"me@c.us","displayName":"本机账号"}\n');
  writeFileSync(
    join(root, "contacts.csv"),
    [
      "id,lidId,phoneId,displayName,savedName,pushName,name,formattedPhoneNumber",
      "alice@c.us,,,爱丽丝,,,,+8613800000000",
    ].join("\n"),
  );
  writeFileSync(
    join(chatRoot, "chat.json"),
    JSON.stringify({
      id: "family@g.us",
      title: "家庭群聊",
      kind: "group",
      isGroup: true,
    }),
  );
  const messageRows = [
    MESSAGE_HEADERS.join(","),
    csvRow([
      "shared-message-id",
      messageChatId,
      "alice@c.us",
      "me@c.us",
      "false",
      "1755651723",
      "chat",
      options.text ?? "第一行\n第二行，含逗号",
      "",
      "",
      "false",
      "true",
      "false",
      "2",
      "false",
      "",
      "",
      "",
      "",
    ]),
    csvRow([
      "system-message",
      messageChatId,
      "",
      "",
      "false",
      "1755651730",
      "gp2",
      "成员加入群聊",
      "",
      "",
      "false",
      "false",
      "false",
      "",
      "false",
      "",
      "",
      "",
      "",
    ]),
    csvRow([
      "revoked-message",
      messageChatId,
      "alice@c.us",
      "me@c.us",
      "false",
      "1755651740",
      "chat",
      "原始文本",
      "",
      "",
      "true",
      "false",
      "true",
      "",
      "false",
      "",
      "",
      "",
      "",
    ]),
    csvRow([
      "image-message",
      messageChatId,
      "me@c.us",
      "alice@c.us",
      "true",
      "1755651750",
      "image",
      "",
      "现场图片说明",
      "",
      "false",
      "false",
      "false",
      "3",
      "true",
      "image/png",
      "现场图片.png",
      "68",
      "",
    ]),
  ];
  writeFileSync(join(chatRoot, "messages.csv"), `${messageRows.join("\n")}\n`);
  const relativePath = options.unsafeMediaPath ?? "media/objects/aa/image.png";
  writeFileSync(
    join(chatRoot, "media", "index.json"),
    `${JSON.stringify([
      {
        scope: "chat",
        chatId: "family@g.us",
        messageId: "image-message",
        type: "image",
        mimeType: "image/png",
        originalFileName: "现场图片.png",
        relativePath,
        byteLength: 68,
        status: "available",
      },
    ], null, 2)}\n`,
  );
  writeFileSync(
    join(root, "media", "objects", "aa", "image.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  writeFileSync(join(root, "media", "index.json"), "[]\n");
}

test("case names are safe on Windows without losing Chinese text", () => {
  assert.equal(sanitizeCaseDirectoryName("  浦江:案件?  "), "浦江_案件_");
  assert.equal(sanitizeCaseDirectoryName("CON"), "_CON");
});

test("v5 sessions import transactionally and isolate repeated native ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "wafc-core-v5-"));
  const payload = join(root, "payload");
  const cases = join(root, "external-cases");
  const firstSession = join(root, "session-one");
  const secondSession = join(root, "session-two");
  mkdirSync(payload);
  mkdirSync(cases);
  mkdirSync(firstSession);
  mkdirSync(secondSession);
  writePayload(payload);
  writeSyntheticSession(firstSession, {
    specimenName: "张三手机",
    text: "第一台手机\n带换行",
    messageChatId: "me@lid",
  });
  writeSyntheticSession(secondSession, {
    specimenName: "李四手机",
    status: "cancelled",
    text: "第二台手机，相同原生 ID",
  });
  const service = new WorkstationService({
    dataRoot: join(root, "data"),
    collectorPayloadRoot: payload,
  });
  try {
    const created = await service.createCase({
      name: "浦江:案件?",
      parentDirectory: cases,
    });
    assert.match(created.path, /浦江_案件_-\w{8}$/u);
    const first = await service.receiveResults({ caseId: created.caseId, selectedPath: firstSession });
    const second = await service.receiveResults({ caseId: created.caseId, selectedPath: secondSession });
    assert.equal(first[0]?.accepted, true);
    assert.equal(second[0]?.accepted, true);
    assert.equal(second[0]?.source?.collectionStatus, "cancelled");
    assert.match(second[0]?.source?.warning ?? "", /部分结果/u);
    assert.equal(service.listSources(created.caseId).length, 2);

    for (const source of service.listSources(created.caseId)) {
      const chats = service.listChats(created.caseId, {
        sourceId: source.sourceId,
        search: "",
        cursor: null,
        limit: 80,
      });
      assert.equal(chats.items[0]?.nativeId, "family@g.us");
      const messages = service.listMessages(created.caseId, {
        sourceId: source.sourceId,
        chatNativeId: "family@g.us",
        beforeCursor: null,
        limit: 100,
      });
      assert.equal(messages.items.length, 4);
      assert.equal(messages.items[0]?.nativeId, "shared-message-id");
      assert.equal(messages.items[0]?.senderDisplayName, "爱丽丝");
      assert.equal(messages.items[2]?.isRevoked, true);
      const image = messages.items[3]?.attachments[0];
      assert.equal(image?.status, "available");
      assert.match(image?.url ?? "", /^wafc-media:\/\/asset\//u);
      const resolved = service.resolveAsset(created.caseId, image?.opaqueId ?? "");
      assert.equal(existsSync(resolved.path), true);
    }

    const duplicate = await service.receiveResults({
      caseId: created.caseId,
      selectedPath: firstSession,
    });
    assert.equal(duplicate[0]?.deduplicated, true);
    assert.equal(service.listSources(created.caseId).length, 2);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable v6 results match active tasks and disabled tasks reject new sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "wafc-core-v6-"));
  const payload = join(root, "payload");
  const cases = join(root, "cases");
  const usb = join(root, "usb");
  mkdirSync(payload);
  mkdirSync(cases);
  mkdirSync(usb);
  writePayload(payload);
  writeFileSync(join(usb, "keep-me.txt"), "do not overwrite");
  const service = new WorkstationService({
    dataRoot: join(root, "data"),
    collectorPayloadRoot: payload,
  });
  try {
    const created = await service.createCase({ name: "便携任务案件", parentDirectory: cases });
    const task = await service.assignTask({
      caseId: created.caseId,
      taskName: "现场采集任务",
      usbRoot: usb,
    });
    assert.equal(readFileSync(join(usb, "keep-me.txt"), "utf8"), "do not overwrite");
    assert.equal(existsSync(join(usb, "Field Collector", "task.json")), true);
    await assert.rejects(
      service.assignTask({
        caseId: created.caseId,
        taskName: "不应覆盖的任务",
        usbRoot: usb,
      }),
      /已经存在 Field Collector/u,
    );
    const contract = JSON.parse(
      readFileSync(join(usb, "Field Collector", "task.json"), "utf8"),
    ) as PortableTask;
    const firstSession = join(usb, "Field Collector", "results", "session-one");
    mkdirSync(firstSession);
    writeSyntheticSession(firstSession, {
      specimenName: "便携检材一号",
      task: contract,
      sessionId: "f66bbbd3-5ee4-43fd-8ad4-8b96cfb70c7d",
    });
    const otherCase = await service.createCase({ name: "另一个案件", parentDirectory: cases });
    const crossCase = await service.receiveResults({
      caseId: otherCase.caseId,
      selectedPath: firstSession,
    });
    assert.equal(crossCase[0]?.accepted, false);
    assert.equal(crossCase[0]?.errorCode, "CASE_MISMATCH");
    const accepted = await service.receiveResults({ caseId: created.caseId, selectedPath: usb });
    assert.equal(accepted[0]?.accepted, true);
    assert.equal(service.listTasks(created.caseId)[0]?.receivedCount, 1);
    const duplicate = await service.receiveResults({
      caseId: created.caseId,
      selectedPath: firstSession,
    });
    assert.equal(duplicate[0]?.deduplicated, true);
    assert.equal(service.listTasks(created.caseId)[0]?.receivedCount, 1);

    service.disableTask(created.caseId, task.taskId);
    const secondSession = join(usb, "Field Collector", "results", "session-two");
    mkdirSync(secondSession);
    writeSyntheticSession(secondSession, {
      specimenName: "便携检材二号",
      task: contract,
      sessionId: "5d29baba-7b06-4b28-94d4-847d201fa4e7",
    });
    const rejected = await service.receiveResults({ caseId: created.caseId, selectedPath: secondSession });
    assert.equal(rejected[0]?.accepted, false);
    assert.equal(rejected[0]?.errorCode, "TASK_DISABLED");
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("media path escape rolls back database rows and copied source", async () => {
  const root = mkdtempSync(join(tmpdir(), "wafc-core-rollback-"));
  const payload = join(root, "payload");
  const cases = join(root, "cases");
  const session = join(root, "bad-session");
  mkdirSync(payload);
  mkdirSync(cases);
  mkdirSync(session);
  writePayload(payload);
  writeSyntheticSession(session, {
    specimenName: "越界媒体检材",
    unsafeMediaPath: "../../outside.png",
  });
  const service = new WorkstationService({
    dataRoot: join(root, "data"),
    collectorPayloadRoot: payload,
  });
  try {
    const created = await service.createCase({ name: "回滚测试", parentDirectory: cases });
    const results = await service.receiveResults({ caseId: created.caseId, selectedPath: session });
    assert.equal(results[0]?.accepted, false);
    assert.equal(results[0]?.errorCode, "MEDIA_PATH_ESCAPE");
    assert.equal(service.listSources(created.caseId).length, 0);
    assert.deepEqual(readdirSync(join(created.path, "sources")), []);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
