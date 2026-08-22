import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  includeCommunityTopology?: boolean;
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
  mkdirSync(join(root, "global"), { recursive: true });
  mkdirSync(join(root, "global", "channel-media"), { recursive: true });
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
    chatCount: options.includeCommunityTopology === true ? 3 : 1,
  };
  if (options.task !== undefined) {
    manifest.sessionId = options.sessionId;
    const { resultDirectory: _resultDirectory, ...taskReference } = options.task;
    manifest.task = taskReference;
  }
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(root, "account.json"),
    '{"id":"me@c.us","displayName":"本机账号","about":"现场采集账号","formattedPhoneNumber":"+8613800000000"}\n',
  );
  writeFileSync(
    join(root, "capabilities.json"),
    `${JSON.stringify({
      datasets: {
        calls: { status: "supported" },
        statuses: { status: "supported" },
        channels: { status: "supported" },
        communities: { status: "supported" },
      },
    })}\n`,
  );
  writeFileSync(
    join(root, "global", "calls.json"),
    `${JSON.stringify([{
      id: "call-1",
      peerId: "family@g.us",
      timestamp: "2026-08-20T01:03:00.000Z",
      durationSeconds: 62,
      direction: "incoming",
      isVideo: true,
      isGroup: true,
      state: "completed",
    }])}\n`,
  );
  writeFileSync(
    join(root, "global", "statuses.json"),
    `${JSON.stringify([{
      id: "status-1",
      contactId: "family@g.us",
      items: [{ timestamp: "2026-08-20T01:02:00.000Z", text: "合成动态" }],
    }])}\n`,
  );
  writeFileSync(
    join(root, "global", "channels.json"),
    `${JSON.stringify([{
      id: "channel-1@newsletter",
      title: "现场通知频道",
      description: "合成频道",
      subscribersCount: 16,
      historyComplete: true,
    }])}\n`,
  );
  writeFileSync(
    join(root, "global", "channel-events.json"),
    `${JSON.stringify([
      {
        id: "channel-message-1",
        channelId: "channel-1@newsletter",
        timestamp: "2026-08-20T01:04:00.000Z",
        type: "chat",
        text: "采集已开始",
      },
      {
        id: "channel-message-2",
        channelId: "channel-1@newsletter",
        timestamp: "2026-08-20T01:05:00.000Z",
        type: "image",
        caption: "频道图片",
        hasMedia: true,
        media: { mimeType: "image/png", fileName: "频道图片.png", size: 68 },
      },
    ])}\n`,
  );
  writeFileSync(
    join(root, "global", "channel-media", "index.json"),
    `${JSON.stringify([{
      scope: "channel",
      channelId: "channel-1@newsletter",
      chatId: "channel-1@newsletter",
      messageId: "channel-message-2",
      type: "image",
      mimeType: "image/png",
      originalFileName: "频道图片.png",
      relativePath: "media/objects/aa/image.png",
      byteLength: 68,
      status: "available",
    }])}\n`,
  );
  writeFileSync(
    join(root, "global", "communities.json"),
    `${JSON.stringify([
      {
        id: "community-1@g.us",
        title: "现场工作社群",
        description: "合成社群",
        createdAt: "2026-08-20T01:00:00.000Z",
        source: "WAWebCommunityCollection",
      },
      {
        id: "standalone@g.us",
        title: "独立普通群聊",
        source: "WAWebGroupMetadataCollection",
        raw: { isParentGroup: false, defaultSubgroup: false },
      },
    ])}\n`,
  );
  const communityRelations: Record<string, unknown>[] = [
    {
      relationKind: "community_child_group",
      fromId: "community-1@g.us",
      toId: "family@g.us",
    },
    {
      relationKind: "community_announcement_group",
      fromId: "standalone@g.us",
      toId: "false",
    },
  ];
  if (options.includeCommunityTopology === true) {
    communityRelations.push({
      relationKind: "community_announcement_group",
      fromId: "community-1@g.us",
      toId: "announcements@g.us",
    });
  }
  writeFileSync(
    join(root, "global", "community-relations.json"),
    `${JSON.stringify(communityRelations)}\n`,
  );
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
  writeFileSync(
    join(root, "media", "avatars.json"),
    `${JSON.stringify([
      {
        contactId: "family@g.us",
        mimeType: "image/png",
        originalFileName: "family.png",
        relativePath: "media/objects/aa/image.png",
        status: "available",
      },
      {
        contactId: "community-1@g.us",
        mimeType: "image/png",
        originalFileName: "community.png",
        relativePath: "media/objects/aa/image.png",
        status: "available",
      },
      {
        contactId: "channel-1@newsletter",
        mimeType: "image/png",
        originalFileName: "channel.png",
        relativePath: "media/objects/aa/image.png",
        status: "available",
      },
      {
        contactId: "unsafe@g.us",
        mimeType: "image/png",
        relativePath: "../../outside.png",
        status: "available",
      },
    ], null, 2)}\n`,
  );
  writeFileSync(join(root, "media", "index.json"), "[]\n");
  if (options.includeCommunityTopology === true) {
    writeMinimalChat(root, {
      directoryName: "2_announcements@g.us",
      id: "announcements@g.us",
      title: "内部公告记录",
      messageId: "community-main-message",
      messageText: "社群主对话消息",
      timestamp: "1755651600",
    });
    writeMinimalChat(root, {
      directoryName: "3_community-1@g.us",
      id: "community-1@g.us",
      title: "社群内部信息",
      messageId: "community-internal-message",
      messageText: "不应显示的内部信息",
      timestamp: "1755651900",
    });
  }
}

function writeMinimalChat(
  root: string,
  chat: {
    directoryName: string;
    id: string;
    title: string;
    messageId: string;
    messageText: string;
    timestamp: string;
  },
): void {
  const chatRoot = join(root, "chats", chat.directoryName);
  mkdirSync(join(chatRoot, "media"), { recursive: true });
  writeFileSync(
    join(chatRoot, "chat.json"),
    `${JSON.stringify({ id: chat.id, title: chat.title, kind: "group", isGroup: true })}\n`,
  );
  writeFileSync(
    join(chatRoot, "messages.csv"),
    `${MESSAGE_HEADERS.join(",")}\n${csvRow([
      chat.messageId,
      chat.id,
      "me@c.us",
      chat.id,
      "true",
      chat.timestamp,
      "chat",
      chat.messageText,
      "",
      "",
      "false",
      "false",
      "false",
      "3",
      "false",
      "",
      "",
      "",
      "",
    ])}\n`,
  );
  writeFileSync(join(chatRoot, "media", "index.json"), "[]\n");
}

test("case names are safe on Windows without losing Chinese text", () => {
  assert.equal(sanitizeCaseDirectoryName("  浦江:案件?  "), "浦江_案件_");
  assert.equal(sanitizeCaseDirectoryName("CON"), "_CON");
});

test("copied portable data relinks catalog cases to the current default Cases directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "wafc-core-portable-relink-"));
  const payload = join(root, "payload");
  const oldDataRoot = join(root, "v0.1.15-windows-x64", "AnalysisWorkstationData");
  const newDataRoot = join(root, "v0.1.16-windows-x64", "AnalysisWorkstationData");
  mkdirSync(payload);
  writePayload(payload);

  let createdCaseId = "";
  let oldCasePath = "";
  const oldService = new WorkstationService({
    dataRoot: oldDataRoot,
    collectorPayloadRoot: payload,
  });
  try {
    const created = await oldService.createCase({
      name: "便携迁移案件",
      parentDirectory: oldService.paths.defaultCasesDirectory,
    });
    createdCaseId = created.caseId;
    oldCasePath = created.path;
  } finally {
    oldService.close();
  }

  mkdirSync(dirname(newDataRoot), { recursive: true });
  cpSync(oldDataRoot, newDataRoot, { recursive: true });
  const copiedCaseName = readdirSync(join(newDataRoot, "Cases"))[0];
  assert.notEqual(copiedCaseName, undefined);
  const relocatedCasePath = join(newDataRoot, "Cases", "按案件编号重新关联");
  renameSync(join(newDataRoot, "Cases", copiedCaseName ?? ""), relocatedCasePath);
  rmSync(oldDataRoot, { recursive: true, force: true });
  assert.equal(existsSync(oldCasePath), false, "旧版本案件路径应已失效");

  const migratedService = new WorkstationService({
    dataRoot: newDataRoot,
    collectorPayloadRoot: payload,
  });
  try {
    const summary = migratedService.listCases()[0];
    assert.equal(summary?.caseId, createdCaseId);
    assert.equal(summary?.path, relocatedCasePath);
    assert.notEqual(summary?.path, oldCasePath);
    assert.equal(migratedService.openCase(createdCaseId).path, relocatedCasePath);
  } finally {
    migratedService.close();
    rmSync(root, { recursive: true, force: true });
  }
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
      assert.equal(chats.items[0]?.mediaCount, 1);
      assert.equal(chats.items[0]?.starredMessageCount, 1);
      const chat = chats.items[0];
      assert.match(chat?.avatarUrl ?? "", /^wafc-media:\/\/asset\//u);
      assert.deepEqual(
        chat?.community === null || chat?.community === undefined
          ? chat?.community
          : { ...chat.community, avatarUrl: null },
        {
          id: "community-1@g.us",
          title: "现场工作社群",
          avatarUrl: null,
          role: "group",
        },
      );
      assert.match(chat?.community?.avatarUrl ?? "", /^wafc-media:\/\/asset\//u);
      const resolvedAvatar = service.resolveAsset(
        created.caseId,
        chat?.avatarUrl?.split("/").at(-1) ?? "",
      );
      assert.equal(resolvedAvatar.mimeType, "image/png");
      assert.equal(existsSync(resolvedAvatar.path), true);
      const workspace = service.getSourceWorkspace(created.caseId, source.sourceId);
      assert.equal(workspace.visibleChatCount, 1);
      assert.equal(workspace.account.displayName, "本机账号");
      assert.equal(workspace.calls[0]?.title, "家庭群聊");
      assert.equal(workspace.calls[0]?.durationSeconds, 62);
      assert.equal(workspace.statuses[0]?.preview, "合成动态");
      assert.equal(workspace.channels[0]?.eventCount, 2);
      assert.match(workspace.channels[0]?.avatarUrl ?? "", /^wafc-media:\/\/asset\//u);
      assert.equal(workspace.channels[0]?.messages[0]?.text, "采集已开始");
      const channelImage = workspace.channels[0]?.messages[1]?.attachments[0];
      assert.equal(channelImage?.status, "available");
      assert.match(channelImage?.url ?? "", /^wafc-media:\/\/asset\//u);
      const resolvedChannelImage = service.resolveAsset(
        created.caseId,
        channelImage?.opaqueId ?? "",
      );
      assert.equal(existsSync(resolvedChannelImage.path), true);
      assert.equal(workspace.communities[0]?.childGroups[0]?.title, "家庭群聊");
      assert.equal(workspace.communities[0]?.childGroups[0]?.role, "group");
      assert.equal(workspace.communities.length, 1);
      assert.deepEqual(
        Object.values(workspace.availability).map((value) => value.status),
        ["available", "available", "available", "available"],
      );
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

    const exportSource = service.listSources(created.caseId)
      .find((source) => source.specimenName === "张三手机");
    assert.notEqual(exportSource, undefined);
    const exportDirectory = join(root, "offline-exports");
    mkdirSync(exportDirectory);
    const exported = await service.exportOfflinePreview({
      caseId: created.caseId,
      sourceId: exportSource?.sourceId ?? "",
      targetPath: join(exportDirectory, "张三手机-预览.html"),
    });
    const exportedHtml = readFileSync(exported.path, "utf8");
    assert.equal(exported.fileName, "张三手机-预览.html");
    assert.equal(exported.sizeBytes, statSync(exported.path).size);
    assert.match(exportedHtml, /wafc-offline-preview\/1/u);
    assert.match(exportedHtml, /张三手机/u);
    assert.match(exportedHtml, /第一台手机\\n带换行/u);
    assert.match(exportedHtml, /现场工作社群/u);
    assert.match(exportedHtml, /iVBORw0KGgo/u, "图片与头像应内嵌到单文件 HTML");
    assert.match(exportedHtml, /connect-src 'none'/u);
    assert.equal(exportedHtml.includes("wafc-media://"), false);
    assert.equal(exportedHtml.includes(root), false, "导出文件不应包含案件或媒体绝对路径");

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

test("contact phone numbers import and existing cases backfill from retained raw chat data", async () => {
  const root = mkdtempSync(join(tmpdir(), "wafc-core-contact-phone-"));
  const payload = join(root, "payload");
  const cases = join(root, "cases");
  const session = join(root, "session");
  mkdirSync(payload);
  mkdirSync(cases);
  mkdirSync(session);
  writePayload(payload);
  writeSyntheticSession(session, { specimenName: "联系人号码检材" });
  const nativeId = "259567069958235@lid";
  writeFileSync(
    join(session, "chats", "1_family@g.us", "chat.json"),
    `${JSON.stringify({
      id: nativeId,
      title: "JJ",
      kind: "chat",
      isGroup: false,
      contactId: nativeId,
      lidId: nativeId,
      phoneId: "8615880921237@c.us",
      phoneNumber: "8615880921237",
      formattedPhoneNumber: "+8615880921237",
    })}\n`,
  );
  writeFileSync(
    join(session, "contacts.csv"),
    [
      "id,lidId,phoneId,phoneNumber,devicePhoneId,displayName,savedName,pushName,name,formattedPhoneNumber",
      `${nativeId},${nativeId},8615880921237@c.us,8615880921237,,JJ,JJ,,,+8615880921237`,
    ].join("\n"),
  );

  const service = new WorkstationService({
    dataRoot: join(root, "data"),
    collectorPayloadRoot: payload,
  });
  try {
    const created = await service.createCase({ name: "号码案件", parentDirectory: cases });
    const received = await service.receiveResults({
      caseId: created.caseId,
      selectedPath: session,
    });
    const sourceId = received[0]?.source?.sourceId ?? "";
    assert.equal(received[0]?.accepted, true);

    const database = new DatabaseSync(join(created.path, "case.sqlite"));
    const imported = database.prepare(`
      SELECT phone_number, formatted_phone_number
      FROM chats WHERE source_id = ? AND native_id = ?
    `).get(sourceId, nativeId) as Record<string, unknown>;
    assert.equal(imported.phone_number, "8615880921237");
    assert.equal(imported.formatted_phone_number, "+8615880921237");
    database.prepare(`
      UPDATE chats SET phone_number = NULL, formatted_phone_number = NULL
      WHERE source_id = ? AND native_id = ?
    `).run(sourceId, nativeId);
    database.close();

    const chat = service.listChats(created.caseId, {
      sourceId,
      search: "",
      cursor: null,
      limit: 20,
    }).items[0];
    assert.equal(chat?.phoneNumber, "8615880921237");
    assert.equal(chat?.formattedPhoneNumber, "+8615880921237");

    const exported = await service.exportOfflinePreview({
      caseId: created.caseId,
      sourceId,
      targetPath: join(root, "联系人号码预览.html"),
    });
    const html = readFileSync(exported.path, "utf8");
    assert.match(html, /电话号码/u);
    assert.match(html, /\+8615880921237/u);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("community roots stay internal while the main chat uses the community identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "wafc-core-community-topology-"));
  const payload = join(root, "payload");
  const cases = join(root, "cases");
  const session = join(root, "session");
  mkdirSync(payload);
  mkdirSync(cases);
  mkdirSync(session);
  writePayload(payload);
  writeSyntheticSession(session, {
    specimenName: "社群检材",
    includeCommunityTopology: true,
  });
  const service = new WorkstationService({
    dataRoot: join(root, "data"),
    collectorPayloadRoot: payload,
  });
  try {
    const created = await service.createCase({ name: "社群拓扑案件", parentDirectory: cases });
    const received = await service.receiveResults({
      caseId: created.caseId,
      selectedPath: session,
    });
    assert.equal(received[0]?.accepted, true);
    const source = service.listSources(created.caseId)[0];
    assert.notEqual(source, undefined);

    const firstPage = service.listChats(created.caseId, {
      sourceId: source?.sourceId ?? "",
      search: "",
      cursor: null,
      limit: 1,
    });
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0]?.nativeId, "family@g.us");
    assert.notEqual(firstPage.nextCursor, null);
    const secondPage = service.listChats(created.caseId, {
      sourceId: source?.sourceId ?? "",
      search: "",
      cursor: firstPage.nextCursor,
      limit: 1,
    });
    const mainChat = secondPage.items[0];
    assert.equal(mainChat?.nativeId, "announcements@g.us");
    assert.equal(mainChat?.title, "现场工作社群");
    assert.equal(mainChat?.community?.role, "announcement");
    assert.equal(mainChat?.avatarUrl, mainChat?.community?.avatarUrl);
    assert.equal(secondPage.nextCursor, null);

    const internalSearch = service.listChats(created.caseId, {
      sourceId: source?.sourceId ?? "",
      search: "社群内部信息",
      cursor: null,
      limit: 20,
    });
    assert.deepEqual(internalSearch.items, []);
    assert.equal(internalSearch.nextCursor, null);
    const workspace = service.getSourceWorkspace(created.caseId, source?.sourceId ?? "");
    assert.equal(workspace.visibleChatCount, 2);

    const exported = await service.exportOfflinePreview({
      caseId: created.caseId,
      sourceId: source?.sourceId ?? "",
      targetPath: join(root, "社群预览.html"),
    });
    const html = readFileSync(exported.path, "utf8");
    assert.equal(html.includes("社群内部信息"), false);
    assert.equal(html.includes("社群公告"), false);
    assert.match(html, /社群主对话/u);
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
