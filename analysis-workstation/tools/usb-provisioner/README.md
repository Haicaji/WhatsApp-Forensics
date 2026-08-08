# WAFC USB Provisioner

这是 Analysis Workstation 的现场 U 盘下发后端，不是 Field Collector 的现场命令，也不会被
打包进 Collector 发行 ZIP。它负责维护 Workstation 配置签名密钥、生成每名勘察员独立的
Evidence Bag 密钥、签发 `passive_t0` 任务、组装固定 U 盘目录，并只在实验室登记勘察员公钥。

当前 v0.1 提供可测试的 CLI/库入口，后续 Electron 界面通过受限 IPC 调用同一后端：

```powershell
wafc-usb-provisioner init-workstation --state D:\WAFC-State `
  --workstation-id lab-workstation-001 --key-id workstation-config-key-001

wafc-usb-provisioner provision-usb --state D:\WAFC-State --usb-root E:\WAFC-USB `
  --operator-template operator-template.json --assignment assignment-001.json
```

两条命令都通过隐藏输入读取口令。初始化时重复输入 Workstation 密钥口令；下发时输入一次
Workstation 口令和两次新的勘察员密钥口令。口令不得通过参数、环境变量或 JSON 文件传入。

`usb-root` 必须是已经放入经过核验的 `field-collector.exe` 与 `waeb-verify.exe` 的真实目录；
工具不会下载二进制、覆盖已有配置或跟随符号链接/reparse point。成功后，Workstation 状态区
新增非秘密的 operator/assignment registry 和 provisioning receipt；不保存勘察员私钥明文，
也不默认备份其加密私钥副本。

模板示例：

```json
{
  "schemaVersion": "wafc-operator-template/1",
  "operatorId": "operator-a",
  "displayName": "现场勘察员 A",
  "organization": "某大学取证实验室",
  "keyId": "operator-key-001"
}
```

```json
{
  "schemaVersion": "wafc-assignment-template/1",
  "assignmentId": "CASE-2026-001",
  "authorizationReference": "AUTH-2026-001",
  "sourceOrganization": "某大学取证实验室",
  "issuedAtUtc": "2026-08-08T00:00:00Z",
  "validFromUtc": "2026-08-08T00:00:00Z",
  "validUntilUtc": "2026-08-15T00:00:00Z",
  "targetDescription": "经授权的 WhatsApp Web 只读 T0 勘察"
}
```

Workstation 状态目录不应放在取证 U 盘上，应由实验室访问控制、备份和恢复制度保护。当前
软件口令加密是 MVP；正式机构部署可把 Workstation 签名操作替换为 HSM/智能卡 provider。
