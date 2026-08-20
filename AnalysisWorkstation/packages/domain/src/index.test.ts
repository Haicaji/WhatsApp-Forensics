import assert from "node:assert/strict";
import test from "node:test";

import {
  assignTaskInputSchema,
  caseSummarySchema,
  portableTaskSchema,
} from "./index.js";

test("portable task accepts the language-neutral contract", () => {
  const parsed = portableTaskSchema.parse({
    schemaVersion: "wafc-portable-task/1",
    taskId: "4fc165ec-e67b-46ea-a88d-3f7f97c4e48e",
    caseId: "a5e26f98-d91a-4aa8-92ee-a0681c344442",
    caseName: "浦江路案件",
    taskName: "现场手机提取",
    createdAtUtc: "2026-08-20T01:02:03.000Z",
    resultDirectory: "results",
  });
  assert.equal(parsed.resultDirectory, "results");
});

test("task input trims names and rejects empty roots", () => {
  const parsed = assignTaskInputSchema.parse({
    caseId: "a5e26f98-d91a-4aa8-92ee-a0681c344442",
    taskName: "  一号采集  ",
    usbRoot: "  D:\\\\  ",
  });
  assert.equal(parsed.taskName, "一号采集");
  assert.equal(parsed.usbRoot, "D:\\\\");
});

test("case summaries require portable UUID identifiers", () => {
  assert.equal(
    caseSummarySchema.safeParse({
      caseId: "not-a-uuid",
      name: "测试案件",
      path: "C:\\\\Cases\\\\case",
      createdAtUtc: "2026-08-20T01:02:03.000Z",
      updatedAtUtc: "2026-08-20T01:02:03.000Z",
      lastOpenedAtUtc: null,
      sourceCount: 0,
      taskCount: 0,
      chatCount: 0,
      messageCount: 0,
    }).success,
    false,
  );
});
