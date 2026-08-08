# WAFC Portable Bundle v1

本规范定义 Analysis Workstation 向 Field Collector U 盘下发身份、密钥和任务时使用的
语言无关契约。现场采集器只读取自身可执行文件所在目录，不扫描其他磁盘，也不接受配置中
提供的绝对输出路径。

## 固定目录

```text
WAFC-USB/
├─ field-collector.exe
├─ waeb-verify.exe
├─ wafc-portable.json
├─ config/
│  ├─ operator-profile.json
│  ├─ operator-key.enc
│  ├─ workstation-trust.json
│  └─ bundle-manifest.json
├─ assignments/
│  └─ assignment-<id>.json
├─ evidence/
│  ├─ staging/
│  └─ sealed/
├─ handoff/
└─ diagnostics/
```

所有路径都相对于 `field-collector.exe` 的真实父目录解析。实现必须逐级拒绝符号链接、
Windows reparse point、路径穿越、备用数据流和大小写/NFC 冲突。盘符不是身份的一部分，
因此同一目录树从 `E:` 移到 `F:` 不改变配置语义。

## 信任链

`workstation-trust.json` 本身不能成为自证信任根，否则攻击者可以同时替换 Workstation
公钥、清单和任务。v1 使用以下闭环：

1. Workstation 创建勘察员 Ed25519 密钥时，把 `operatorId`、`keyId` 和 Workstation
   公钥指纹一并放进 `operator-key.enc` 的认证加密明文；
2. `bundle-manifest.json` 由该 Workstation 密钥签名，并逐文件绑定便携标记、勘察员
   资料、加密私钥、Workstation 公钥和全部任务；
3. 每个 `assignment-*.json` 还单独由同一 Workstation 密钥签名；
4. Field Collector 可以先做结构、哈希和签名的预检，但只有操作者输入口令、成功解密
   `operator-key.enc`，并确认其中绑定的 Workstation 指纹、勘察员和密钥 ID 全部一致后，
   配置才成为已认证配置；
5. 任一步失败都不得开始正式采集或回退到未签名配置。

该闭环防止普通介质损坏、局部替换和不知道口令的第三方重签，但不能把 U 盘内自带公钥
描述为独立的组织信任锚：已经知道 operator 口令、能替换整棵目录且能运行自定义工具的人，
理论上可以生成另一套 Workstation/勘察员密钥并重打包。实验室接收时必须以 Analysis
Workstation 本地登记的任务摘要和勘察员公钥再次核验。若制度要求在现场也抵抗这种恶意
持密钥者，必须增加不随 U 盘交付的组织根证书、智能卡或硬件密钥；仅增加另一个同盘公钥
不能解决信任自举问题。

Workstation 默认长期保存勘察员公钥，不默认保存勘察员私钥。是否托管私钥属于独立制度。
Workstation 完整公钥只存在于 U 盘配置区；口令、私钥和 Workstation 公钥不得进入采集日志、
Evidence Bag 或现场交接摘要。Evidence Bag 只记录任务/配置摘要和签名密钥指纹。

## 签名字节

所有 payload 先按 RFC 8785/JCS 规范化，且禁止浮点数和超出 I-JSON 安全整数范围的数值。

- Bundle manifest：
  `Ed25519("WAFC-BUNDLE-MANIFEST-v1\0" || UTF8(JCS(payload)))`
- Assignment：
  `Ed25519("WAFC-ASSIGNMENT-v1\0" || UTF8(JCS(payload)))`

签名对象中的 `payloadSha256` 是上述 JCS payload（不含域分隔前缀）的 SHA-256。
文件清单必须按 UTF-8 路径字节升序排列，路径唯一，且不得包含
`config/bundle-manifest.json` 自身。

## Schema

- `portable-root-1.0.schema.json`
- `operator-profile-1.0.schema.json`
- `workstation-trust-1.0.schema.json`
- `assignment-1.0.schema.json`
- `bundle-manifest-1.0.schema.json`

Schema 是交换契约；生产实现还必须执行文件系统安全、Ed25519、期限、归属和密钥绑定等
跨文件语义检查。
