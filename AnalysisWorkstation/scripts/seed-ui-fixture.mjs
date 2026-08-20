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
  process.stdout.write(`${JSON.stringify({
    dataRoot,
    caseId: caseSummary.caseId,
    caseName: caseSummary.name,
    specimenName: "Alex 的 Android 手机",
  }, null, 2)}\n`);
} finally {
  service.close();
}

function writeSession(root, specimenName, status, minuteOffset) {
  mkdirSync(join(root, "chats"), { recursive: true });
  mkdirSync(join(root, "media", "objects", "aa"), { recursive: true });
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify({
    schemaVersion: "field-collector-session/5",
    status,
    startedAt: new Date(Date.UTC(2026, 7, 20, 1, minuteOffset)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 7, 20, 1, minuteOffset + 12)).toISOString(),
    evidenceItem: { name: specimenName },
    chatCount: 3,
  }, null, 2)}\n`);
  writeFileSync(join(root, "account.json"), '{"id":"me@c.us","displayName":"现场账号"}\n');
  writeFileSync(
    join(root, "contacts.csv"),
    [
      "id,lidId,phoneId,displayName,savedName,pushName,name,formattedPhoneNumber",
      "lin@c.us,,,林若衡,林若衡,,,+8613912748321",
      "zhou@c.us,,,周砚秋,周砚秋,,,+8613664182073",
    ].join("\n"),
  );
  const chats = [
    { id: "project-team@g.us", title: "项目协调群", kind: "group", count: 34 },
    { id: "logistics@c.us", title: "物流对接", kind: "chat", count: 12 },
    { id: "family@g.us", title: "家人", kind: "group", count: 9 },
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
  }, null, 2)}\n`);
  writeFileSync(
    join(directory, "participants.csv"),
    "id,chatId,role,name\nlin@c.us,project-team@g.us,member,林若衡\nzhou@c.us,project-team@g.us,admin,周砚秋\n",
  );
  const rows = [MESSAGE_HEADERS.join(",")];
  const media = [];
  for (let index = 0; index < chat.count; index += 1) {
    const messageId = `${chat.id}-message-${index}`;
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
      String(Date.UTC(2026, 7, 20, 8 + chatIndex, minuteOffset + index) / 1000),
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
