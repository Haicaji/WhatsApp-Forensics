import assert from "node:assert/strict";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { deflateSync } from "node:zlib";

import { WorkstationService } from "../packages/workstation-core/dist/index.js";

const analysisRoot = resolve(import.meta.dirname, "..");
const allowedRoot = resolve(analysisRoot, ".e2e-data");
const supplied = process.argv[2];
assert.ok(supplied && isAbsolute(supplied), "必须提供绝对测试数据目录");
const dataRoot = resolve(supplied);
const relativePath = relative(allowedRoot, dataRoot);
assert.ok(
  relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`),
  "视觉夹具只能写入 AnalysisWorkstation/.e2e-data 的子目录",
);

const MESSAGE_HEADERS = [
  "id", "chatId", "senderId", "recipientId", "fromMe", "timestamp", "type", "text",
  "caption", "quotedMessageId", "isForwarded", "isStarred", "isRevoked", "acknowledgement",
  "hasMedia", "mediaMimeType", "mediaFileName", "mediaSize", "mediaDurationSeconds",
];
const FIXTURE_PNG = createFixturePng(360, 220);
const AVATAR_FIXTURES = [
  { contactId: "me@c.us", fileName: "account.png", colors: [[101, 75, 232], [255, 255, 255]] },
  { contactId: "project-team@g.us", fileName: "project-team.png", colors: [[20, 36, 70], [255, 255, 255]] },
  { contactId: "8613664182073@c.us", fileName: "logistics.png", colors: [[35, 132, 126], [255, 255, 255]] },
  { contactId: "family@g.us", fileName: "family.png", colors: [[180, 86, 120], [255, 255, 255]] },
  { contactId: "field-team@g.us", fileName: "field-team.png", colors: [[83, 101, 135], [255, 255, 255]] },
  { contactId: "field-notice@newsletter", fileName: "field-notice.png", colors: [[204, 27, 27], [255, 255, 255]] },
];

rmSync(dataRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });
const payload = join(dataRoot, "fixture-payload");
const cases = join(dataRoot, "fixture-cases");
const usb = join(dataRoot, "fixture-usb");
mkdirSync(join(payload, "extension"), { recursive: true });
mkdirSync(cases);
mkdirSync(usb);
writeFileSync(join(payload, "Field Collector.exe"), "synthetic visual fixture");
writeFileSync(join(payload, "extension", "manifest.json"), "{}\n");
writeFileSync(join(payload, "payload-manifest.json"), "{}\n");
writeFileSync(join(payload, "LICENSE"), "fixture\n");
writeFileSync(join(payload, "THIRD_PARTY_NOTICES.md"), "fixture\n");

const service = new WorkstationService({ dataRoot, collectorPayloadRoot: payload });
try {
  const caseSummary = await service.createCase({
    name: "浦江路移动终端调查",
    parentDirectory: cases,
  });
  await service.assignTask({
    caseId: caseSummary.caseId,
    taskName: "第一批现场手机提取",
    usbRoot: usb,
  });

  const firstSession = join(dataRoot, "fixture-session-one");
  const secondSession = join(dataRoot, "fixture-session-two");
  writeSession(firstSession, "Alex 的 Android 手机", "complete", 0);
  writeSession(secondSession, "商务沟通备用机", "cancelled", 40);
  await service.receiveResults({ caseId: caseSummary.caseId, selectedPath: firstSession });
  await service.receiveResults({ caseId: caseSummary.caseId, selectedPath: secondSession });
  const exportSource = service.listSources(caseSummary.caseId)
    .find((source) => source.specimenName === "Alex 的 Android 手机");
  assert.ok(exportSource, "视觉夹具缺少要导出的 WhatsApp 账号");
  const exportDirectory = join(dataRoot, "fixture-exports");
  mkdirSync(exportDirectory);
  const offlinePreview = await service.exportOfflinePreview({
    caseId: caseSummary.caseId,
    sourceId: exportSource.sourceId,
    targetPath: join(exportDirectory, "Alex-WhatsApp-离线预览.html"),
  });
  process.stdout.write(`${JSON.stringify({
    dataRoot,
    caseId: caseSummary.caseId,
    caseName: caseSummary.name,
    specimenName: "Alex 的 Android 手机",
    offlinePreviewPath: offlinePreview.path,
  }, null, 2)}\n`);
} finally {
  service.close();
}

function writeSession(root, specimenName, status, minuteOffset) {
  mkdirSync(join(root, "chats"), { recursive: true });
  mkdirSync(join(root, "global"), { recursive: true });
  mkdirSync(join(root, "global", "channel-media"), { recursive: true });
  mkdirSync(join(root, "media", "objects", "aa"), { recursive: true });
  mkdirSync(join(root, "media", "objects", "avatars"), { recursive: true });
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify({
    schemaVersion: "field-collector-session/5",
    status,
    startedAt: new Date(Date.UTC(2026, 7, 20, 1, minuteOffset)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 7, 20, 1, minuteOffset + 12)).toISOString(),
    evidenceItem: { name: specimenName },
    chatCount: 4,
  }, null, 2)}\n`);
  writeFileSync(join(root, "account.json"), `${JSON.stringify({
    id: "me@c.us",
    displayName: "现场账号",
    about: "移动终端采集账号",
    formattedPhoneNumber: "+86 139 0000 0000",
  }, null, 2)}\n`);
  const avatars = AVATAR_FIXTURES.map((avatar, index) => {
    const relativePath = `media/objects/avatars/${avatar.fileName}`;
    const image = createAvatarPng(96, avatar.colors[0], avatar.colors[1], index);
    writeFileSync(join(root, relativePath), image);
    return {
      contactId: avatar.contactId,
      mimeType: "image/png",
      originalFileName: avatar.fileName,
      relativePath,
      status: "available",
    };
  });
  writeFileSync(join(root, "media", "avatars.json"), `${JSON.stringify(avatars, null, 2)}\n`);
  writeFileSync(join(root, "capabilities.json"), `${JSON.stringify({
    datasets: {
      calls: { status: "supported", recordCount: 2 },
      statuses: { status: "supported", recordCount: 1 },
      channels: { status: "supported", recordCount: 1 },
      communities: { status: "supported", recordCount: 1 },
    },
  }, null, 2)}\n`);
  writeFileSync(join(root, "global", "calls.json"), `${JSON.stringify([
    {
      id: `call-${minuteOffset}-1`,
      peerId: "8613664182073@c.us",
      timestamp: new Date(Date.UTC(2026, 7, 20, 8, minuteOffset + 5)).toISOString(),
      durationSeconds: 87,
      direction: "incoming",
      isVideo: false,
      isGroup: false,
      state: "completed",
    },
    {
      id: `call-${minuteOffset}-2`,
      peerId: "project-team@g.us",
      timestamp: new Date(Date.UTC(2026, 7, 20, 9, minuteOffset + 8)).toISOString(),
      durationSeconds: 242,
      direction: "outgoing",
      isVideo: true,
      isGroup: true,
      state: "completed",
    },
  ], null, 2)}\n`);
  writeFileSync(join(root, "global", "statuses.json"), `${JSON.stringify([
    {
      id: "lin@c.us",
      contactId: "lin@c.us",
      timestamp: new Date(Date.UTC(2026, 7, 20, 7, minuteOffset)).toISOString(),
      totalCount: 2,
      items: [
        {
          id: `status-${minuteOffset}-1`,
          timestamp: new Date(Date.UTC(2026, 7, 20, 7, minuteOffset)).toISOString(),
          type: "image",
          caption: "现场入口已经封闭",
        },
        {
          id: `status-${minuteOffset}-2`,
          timestamp: new Date(Date.UTC(2026, 7, 20, 7, minuteOffset + 4)).toISOString(),
          type: "chat",
          text: "设备清点完成",
        },
      ],
    },
  ], null, 2)}\n`);
  writeFileSync(join(root, "global", "channels.json"), `${JSON.stringify([
    {
      id: "field-notice@newsletter",
      title: "现场通知频道",
      description: "现场工作节点通知",
      subscribersCount: 16,
      unreadCount: 0,
      historyComplete: true,
    },
  ], null, 2)}\n`);
  writeFileSync(join(root, "global", "channel-events.json"), `${JSON.stringify([
    {
      id: `channel-event-${minuteOffset}-1`,
      channelId: "field-notice@newsletter",
      timestamp: new Date(Date.UTC(2026, 7, 20, 9, minuteOffset + 4)).toISOString(),
      type: "chat",
      text: "第一批设备已完成编号登记，现场记录同步归档。",
    },
    {
      id: `channel-event-${minuteOffset}-2`,
      channelId: "field-notice@newsletter",
      timestamp: new Date(Date.UTC(2026, 7, 20, 9, minuteOffset + 18)).toISOString(),
      type: "image",
      caption: "现场采集设备和数据线已按编号摆放。",
      hasMedia: true,
      media: {
        mimeType: "image/png",
        fileName: "频道现场设备.png",
        size: FIXTURE_PNG.length,
      },
    },
    {
      id: `channel-event-${minuteOffset}-3`,
      channelId: "field-notice@newsletter",
      timestamp: new Date(Date.UTC(2026, 7, 20, 9, minuteOffset + 33)).toISOString(),
      type: "chat",
      text: "第二阶段采集已开始",
    },
    {
      id: `channel-event-${minuteOffset}-4`,
      channelId: "field-notice@newsletter",
      timestamp: new Date(Date.UTC(2026, 7, 20, 10, minuteOffset + 2)).toISOString(),
      type: "chat",
      text: "现场复核完成，等待接收端确认结果。",
      isForwarded: true,
    },
  ], null, 2)}\n`);
  writeFileSync(join(root, "global", "channel-media", "index.json"), `${JSON.stringify([
    {
      scope: "channel",
      channelId: "field-notice@newsletter",
      chatId: "field-notice@newsletter",
      messageId: `channel-event-${minuteOffset}-2`,
      type: "image",
      mimeType: "image/png",
      originalFileName: "频道现场设备.png",
      relativePath: "media/objects/aa/visual-fixture.png",
      byteLength: FIXTURE_PNG.length,
      status: "available",
    },
  ], null, 2)}\n`);
  writeFileSync(join(root, "global", "communities.json"), `${JSON.stringify([
    {
      id: "field-team@g.us",
      title: "现场工作社群",
      description: "现场协同群组集合",
      createdAt: new Date(Date.UTC(2026, 7, 18, 3, 0)).toISOString(),
      source: "WAWebCommunityCollection",
    },
    {
      id: "standalone-group@g.us",
      title: "独立普通群聊",
      source: "WAWebGroupMetadataCollection",
      raw: { isParentGroup: false, defaultSubgroup: false },
    },
  ], null, 2)}\n`);
  writeFileSync(join(root, "global", "community-relations.json"), `${JSON.stringify([
    {
      id: "field-team:announcement:project-team",
      relationKind: "community_announcement_group",
      fromId: "field-team@g.us",
      toId: "project-team@g.us",
    },
    {
      id: "field-team:child:family",
      relationKind: "community_child_group",
      fromId: "field-team@g.us",
      toId: "family@g.us",
    },
    {
      id: "legacy-invalid-default-subgroup",
      relationKind: "community_announcement_group",
      fromId: "standalone-group@g.us",
      toId: "false",
    },
  ], null, 2)}\n`);
  writeFileSync(
    join(root, "contacts.csv"),
    [
      "id,lidId,phoneId,phoneNumber,devicePhoneId,displayName,savedName,pushName,name,formattedPhoneNumber",
      "lin@c.us,,,,,林若衡,林若衡,,,+8613912748321",
      "zhou@c.us,,,,,周砚秋,周砚秋,,,+8613664182073",
      "8613664182073@c.us,,8613664182073@c.us,8613664182073,,物流对接,物流对接,,,+8613664182073",
    ].join("\n"),
  );
  const chats = [
    { id: "project-team@g.us", title: "项目协调群", kind: "group", count: 34 },
    { id: "8613664182073@c.us", title: "物流对接", kind: "chat", count: 12 },
    { id: "family@g.us", title: "家人", kind: "group", count: 9 },
    { id: "field-team@g.us", title: "社群内部信息", kind: "group", count: 1 },
  ];
  chats.forEach((chat, chatIndex) => writeChat(root, chat, chatIndex, minuteOffset));
  writeFileSync(join(root, "media", "index.json"), "[]\n");
}

function writeChat(root, chat, chatIndex, minuteOffset) {
  const directory = join(root, "chats", `${chatIndex + 1}_${chat.id}`);
  mkdirSync(join(directory, "media"), { recursive: true });
  writeFileSync(join(directory, "chat.json"), `${JSON.stringify({
    id: chat.id,
    title: chat.title,
    kind: chat.kind,
    isGroup: chat.kind === "group",
    ...(chat.kind === "chat" ? {
      contactId: chat.id,
      phoneId: chat.id,
      phoneNumber: "8613664182073",
      formattedPhoneNumber: "+8613664182073",
    } : {}),
  }, null, 2)}\n`);
  writeFileSync(
    join(directory, "participants.csv"),
    "id,chatId,role,name\nlin@c.us,project-team@g.us,member,林若衡\nzhou@c.us,project-team@g.us,admin,周砚秋\n",
  );
  const rows = [MESSAGE_HEADERS.join(",")];
  const media = [];
  for (let index = 0; index < chat.count; index += 1) {
    const messageId = `${chat.id}-message-${index}`;
    const dayOffset = chatIndex === 0 ? Math.floor(index / 12) - 2 : 0;
    const image = chatIndex === 0 && index === 6;
    const document = chatIndex === 0 && index === 13;
    const missingAudio = chatIndex === 0 && index === 19;
    const system = chatIndex === 0 && index === 2;
    const revoked = chatIndex === 0 && index === 10;
    const type = system ? "gp2" : image ? "image" : document ? "document" : missingAudio ? "ptt" : "chat";
    const text = system
      ? "周砚秋创建了项目协调群"
      : revoked
        ? "这条内容稍后被撤回"
        : chatIndex === 0 && index === 17
          ? "现场复核地址：https://example.test/review/field-device"
        : index % 5 === 0
          ? "收到，材料已经核对。下一批文件预计下午三点前完成。"
          : index % 3 === 0
            ? "请把原始清单和现场照片一起发过来，我按编号复核。"
            : `第 ${index + 1} 条合成聊天记录，仅用于界面验收。`;
    rows.push(csvRow([
      messageId,
      chat.id,
      index % 2 === 0 ? "lin@c.us" : "me@c.us",
      index % 2 === 0 ? "me@c.us" : "lin@c.us",
      index % 2 === 1 ? "true" : "false",
      String(Date.UTC(2026, 7, 20 + dayOffset, 8 + chatIndex, minuteOffset + index) / 1000),
      type,
      image || document || missingAudio ? "" : text,
      image ? "现场采集设备照片" : document ? "清单文档" : "",
      index === 15 ? `${chat.id}-message-12` : "",
      index === 8 ? "true" : "false",
      index === 4 ? "true" : "false",
      revoked ? "true" : "false",
      index % 2 === 1 ? "3" : "2",
      image || document || missingAudio ? "true" : "false",
      image ? "image/png" : document ? "text/plain" : missingAudio ? "audio/ogg" : "",
      image ? "现场设备.png" : document ? "材料清单.txt" : missingAudio ? "语音消息.ogg" : "",
      image ? String(FIXTURE_PNG.length) : document ? "84" : "",
      "",
    ]));
    if (image) {
      const path = "media/objects/aa/visual-fixture.png";
      writeFileSync(
        join(root, path),
        FIXTURE_PNG,
      );
      media.push({
        scope: "chat",
        chatId: chat.id,
        messageId,
        type: "image",
        mimeType: "image/png",
        originalFileName: "现场设备.png",
        relativePath: path,
        byteLength: FIXTURE_PNG.length,
        status: "available",
      });
    }
    if (document) {
      const path = "media/objects/aa/material-list.txt";
      writeFileSync(join(root, path), "合成材料清单\n01 手机\n02 数据线\n03 现场记录\n");
      media.push({
        scope: "chat",
        chatId: chat.id,
        messageId,
        type: "document",
        mimeType: "text/plain",
        originalFileName: "材料清单.txt",
        relativePath: path,
        byteLength: 84,
        status: "available",
      });
    }
  }
  writeFileSync(join(directory, "messages.csv"), `${rows.join("\n")}\n`);
  writeFileSync(join(directory, "media", "index.json"), `${JSON.stringify(media, null, 2)}\n`);
}

function csvRow(values) {
  return values
    .map((value) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value)
    .join(",");
}

function createFixturePng(width, height) {
  const rowBytes = width * 4 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * rowBytes;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const device = x > 88 && x < 272 && y > 20 && y < 200;
      const screen = x > 103 && x < 257 && y > 38 && y < 170;
      const accent = screen && ((y > 60 && y < 82) || (y > 118 && y < 131));
      const cable = y > 182 && y < 190 && x > 166 && x < 330;
      const color = accent
        ? [101, 75, 232]
        : screen
          ? [255, 255, 255]
          : device || cable
            ? [20, 36, 70]
            : [229, 232, 240];
      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
      raw[offset + 3] = 255;
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createAvatarPng(size, background, foreground, variant) {
  const rowBytes = size * 4 + 1;
  const raw = Buffer.alloc(rowBytes * size);
  const center = size / 2;
  const headCenterX = center + (variant % 3 - 1) * 3;
  const headCenterY = size * 0.36;
  const headRadius = size * 0.16;
  for (let y = 0; y < size; y += 1) {
    const row = y * rowBytes;
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = row + 1 + x * 4;
      const head = Math.hypot(x - headCenterX, y - headCenterY) <= headRadius;
      const shoulders = y >= size * 0.57
        && Math.pow((x - center) / (size * 0.31), 2) + Math.pow((y - size * 0.72) / (size * 0.19), 2) <= 1;
      const highlight = (x + y + variant * 13) % 41 < 3;
      const color = head || shoulders
        ? foreground
        : highlight
          ? background.map((channel) => Math.min(channel + 22, 255))
          : background;
      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
      raw[offset + 3] = 255;
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
