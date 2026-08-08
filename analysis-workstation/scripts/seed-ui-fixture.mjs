import assert from "node:assert/strict";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  EvidenceIntakeService,
  WorkstationCatalog,
} from "../packages/workstation-core/dist/index.js";

const analysisRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(analysisRoot, "..");
const suppliedRoot = process.argv[2];
assert.ok(suppliedRoot && isAbsolute(suppliedRoot), "必须提供绝对测试数据目录");
const dataRoot = resolve(suppliedRoot);
const relativeToAllowedRoot = relative(
  resolve(analysisRoot, ".e2e-user-data"),
  dataRoot,
);
assert.ok(
  relativeToAllowedRoot &&
    relativeToAllowedRoot !== ".." &&
    !relativeToAllowedRoot.startsWith(`..${sep}`),
  "测试种子只能写入 analysis-workstation/.e2e-user-data 的子目录",
);

const catalog = new WorkstationCatalog(dataRoot);
try {
  if (!catalog.getCase("case-fixture")) {
    catalog.createCase(
      {
        caseId: "case-fixture",
        name: "合成证据导入案件",
        authorizationReference: "SYNTHETIC-FIXTURE-AUTHORIZATION",
        organization: "Synthetic Fixture Lab",
        description: "仅用于桌面界面验收，不含真实账号或聊天信息",
      },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    catalog.registerAssignment({
      assignmentId: "assignment-synthetic-fixture",
      caseId: "case-fixture",
      operatorId: "fixture_operator",
      operatorKeyId: "fixture-key-001",
      operatorFingerprint:
        "sha256:17f1694d3f0457248236d70a2346d7eece8862bab742a05d60d0dc1d9dc87591",
      bundleId: "99999999-9999-4999-8999-999999999999",
      authorizationReference: "SYNTHETIC-FIXTURE-AUTHORIZATION",
      validFromUtc: "2026-01-15T00:00:00.000Z",
      validUntilUtc: "2026-01-16T00:00:00.000Z",
      operatorDisplayName: "合成操作者",
      operatorOrganization: "Synthetic Fixture Lab",
      operatorPublicKeySpkiBase64: "synthetic-public-key-for-ui-test",
      receiptJson: "{}",
      registeredAtUtc: "2026-01-01T00:00:00.000Z",
    });
  }
  const intake = new EvidenceIntakeService({
    catalog,
    verifierExecutable: resolve(
      repositoryRoot,
      "tools/verify-cli/target/release/waeb-verify.exe",
    ),
  });
  const result = await intake.importEvidence(
    "case-fixture",
    resolve(
      repositoryRoot,
      "spec/wa-evidence-bag/v1/examples/minimal-valid-signed/waeb-11111111-1111-4111-8111-111111111111",
    ),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  catalog.close();
}
