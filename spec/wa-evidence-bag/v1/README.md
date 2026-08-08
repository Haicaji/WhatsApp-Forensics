# WA Evidence Bag v1 数据包模板

> 状态：`1.0.0-draft.1`（毕业设计实现基线，尚未冻结）  
> 定位：Field Collector 与 Analysis Workstation 之间唯一稳定的数据契约  
> 隐私：示例数据完全由固定种子合成，不来自任何真实案件样本或已登录账号

## 1. 这份模板解决什么问题

本目录把“聊天导出 ZIP”提升为可独立校验的现场证据包规范。它不兼容
ZAPiXWEB 的平铺 ZIP、文件名关联或宽松对象结构，也不把旧测试作为发布门禁。
旧原型只用于识别可能存在的对象、失败方式和采集边界。

根目录必须使用 `waeb-<evidence-id>/`，不能使用 `case-<id>/`。Evidence Bag
表示一次封存的采集来源；案件由 Analysis Workstation 建立，一个案件可以导入多个
Evidence Bag。

## 2. 浏览器观察形成的对象边界

2026-08-07 对两个已授权、已登录的 WhatsApp Web Chrome 实例进行了只读结构观察。
观察时没有发送消息、读取或保存聊天正文，也没有调用历史同步：

- 两个实例都呈现“对话、通话、动态、频道、社群”五个一级入口。
- 对话列表呈现“所有、未读、特别关注、群组、自定义列表”等过滤能力。
- 会话列表结构可观察到标题、摘要、时间、未读数和消息状态等槽位。
- 一个已经无未读标记的测试会话呈现系统消息、普通消息容器、消息元信息及视频媒体
  `pending` 状态，说明“媒体尚未完成获取”必须作为正式状态，而不是静默丢失。
- 浏览器控制扩展的隔离执行环境看不到 WhatsApp Main World 的内部模块；正式 Collector
  必须通过经授权的 CDP Main World 注入器做能力探测，不能把扩展隔离环境当成采集实现。

这些观察只证明当前客户端存在相应入口和可观察结构，不证明账号历史中一定存在对应
对象，也不证明 WhatsApp 服务端数据已经全部同步到 Web 客户端。

## 3. 规范目录

```text
waeb-<evidence-id>/
├─ bagit.txt
├─ bag-info.txt
├─ manifest-sha256.txt
├─ manifest-sha512.txt
├─ tagmanifest-sha256.txt
├─ schemas/
│  ├─ index.json
│  ├─ common-1.0.schema.json
│  ├─ acquisition-1.0.schema.json
│  ├─ dataset-inventory-1.0.schema.json
│  ├─ completeness-1.0.schema.json
│  ├─ evidence-record-1.0.schema.json
│  ├─ raw-record-1.0.schema.json
│  ├─ media-record-1.0.schema.json
│  ├─ acquisition-event-1.0.schema.json
│  ├─ chat-completeness-1.0.schema.json
│  ├─ capabilities-1.0.schema.json
│  ├─ signer-1.0.schema.json
│  ├─ seal-1.0.schema.json
│  └─ records/*.schema.json
├─ signatures/
│  ├─ signer.json
│  ├─ seal.json
│  └─ seal.ed25519
└─ data/
   ├─ acquisition.json
   ├─ dataset-inventory.json
   ├─ completeness.json
   ├─ normalized/
   │  ├─ accounts.ndjson
   │  ├─ contacts.ndjson
   │  ├─ chats.ndjson
   │  ├─ chat-lists.ndjson
   │  ├─ participants.ndjson
   │  ├─ messages.ndjson
   │  ├─ message-events.ndjson
   │  ├─ reactions.ndjson
   │  ├─ receipts.ndjson
   │  ├─ poll-votes.ndjson
   │  ├─ group-events.ndjson
   │  ├─ statuses.ndjson
   │  ├─ calls.ndjson
   │  ├─ channels.ndjson
   │  ├─ channel-events.ndjson
   │  ├─ communities.ndjson
   │  ├─ community-relations.ndjson
   │  └─ presence-snapshots.ndjson
   ├─ completeness/chats.ndjson
   ├─ raw/
   │  ├─ baseline/<provider>/*.ndjson
   │  └─ enriched/<provider>/*.ndjson
   ├─ media/sha256/<前两位>/<64 位小写 SHA-256>
   ├─ indexes/media.ndjson
   ├─ logs/acquisition.ndjson
   └─ diagnostics/capabilities.json
```

所有规范化数据集文件始终存在。零条记录时文件为零字节，由
`dataset-inventory.json` 区分 `empty`、`not_requested`、`unsupported`、`partial`
和 `failed`；不得通过“文件不存在”猜测语义。空目录则没有强制保留要求。
v1 的 18 个数据集名称、路径、记录类型和顺序由 Schema 固定，名称与路径不得重复。
未请求的数据集必须是零字节且带原因码；已请求但能力不支持时只能标记
`unsupported`；`complete_as_observed` 只用于至少含一条记录且具有观察窗口的受支持
数据集，零条成功结果使用 `empty`，中途获得部分记录使用 `partial`。

## 4. 数据集与可采集对象矩阵

| 数据集 | 主要内容 | 典型来源 | 范围限制 |
|---|---|---|---|
| accounts | 当前账号身份、显示名、业务账号标志、设备观察信息 | Store/页面能力 adapter | 仅当前登录 Web 客户端 |
| contacts | 联系人身份别名、通讯录/验证状态、头像媒体引用 | Store、头像 provider | 联系人缺失不等于账号不存在 |
| chats | 单聊、群聊、归档/置顶/静音/消失消息设置 | Chat collection | 仅已发现会话集合 |
| chat_lists | 特别关注、自定义列表及成员关系 | 当前 UI/Store | 未读、群组等可计算过滤器不必重复固化 |
| participants | 群、频道或社群参与关系与角色 | Group/community adapter | 成员列表可能部分可见 |
| messages | 文本、引用、媒体、位置、投票、活动、撤回占位等 | Message Store/IndexedDB | 历史范围由每聊天完整性单独描述 |
| message_events | 编辑、撤回、协议通知、媒体状态变化 | Store/协议消息 | 不覆盖原消息，只追加事件 |
| reactions | 表情反应及其操作者、时间 | Reaction Store | 删除的反应可能不可观察 |
| receipts | 发送、送达、已读、播放状态 | Receipt/ack 数据 | 群回执可能受权限或保留期限制 |
| poll_votes | 投票选择及变化 | Poll vote Store | 必须引用投票创建消息 |
| group_events | 入群、退群、改名、管理员变化等 | Protocol/system message | 未知事件保留 `nativeType` |
| statuses | 当前可见动态条目及媒体引用 | Status adapter | 只表示观察窗口内当前可见快照 |
| calls | 独立通话日志 | Call Store | 与聊天中的 call system event 分开 |
| channels | 频道实体、关注与验证信息 | Newsletter/channel adapter | 不能推断全部频道历史 |
| channel_events | 频道消息、媒体和协议事件 | Newsletter message Store | 与普通 chat message 分开建模 |
| communities | 社群实体 | Community adapter | 可能只观察到已加入社群 |
| community_relations | 社群—公告群—子群关系 | Community/group metadata | 关系缺失必须可标记 unresolved |
| presence_snapshots | 在线、最后上线等瞬时状态 | Presence Store | 只作采集时刻快照，不作历史事实 |
| media index | 原件、缩略图、可观察解密字节及失败状态 | Media provider | CAS 字节与声明 MIME 分开验证 |
| raw | 白名单原始对象与可选受限 IndexedDB 逻辑快照 | Store/IndexedDB | 默认不导入分析库、不交给 Agent |

## 5. 公共记录信封

规范化记录均使用 `evidence-record-1.0.schema.json`：

```json
{
  "schemaVersion": "1.0.0",
  "recordType": "message",
  "recordId": "msg_7f2e8c70c5a9429a",
  "sourceId": "22222222-2222-4222-8222-222222222222",
  "capturedAtUtc": "2026-01-15T08:00:03.000Z",
  "provenance": [
    {
      "provider": "store",
      "phase": "baseline",
      "rawRef": {
        "path": "data/raw/baseline/store/messages.ndjson",
        "recordId": "raw_msg_alpha_001",
        "contentSha256": "<64 位小写十六进制>"
      }
    }
  ],
  "contentSha256": "<RFC 8785/JCS 规范化 data 对象的 SHA-256>",
  "data": {}
}
```

`recordId` 必须由 `sourceId + recordType + 稳定原生键` 经带域分隔符的 SHA-256
派生并截取，不得直接写入 JID、电话号码、标题或正文。64 位原生整数和单调时钟使用
十进制字符串，避免跨 JavaScript/Rust 精度丢失。

记录内容、原始记录、日志事件和 `manifestRootSha256` 的结构化哈希统一使用
RFC 8785 JSON Canonicalization Scheme（JCS）后再编码为 UTF-8。输入必须满足 I-JSON；
非有限数字、孤立 UTF-16 代理项和无法无损表示的原生 64 位整数不得进入待规范化对象。
跨语言实现必须通过 `test-vectors/jcs/` 中的同一组向量。

## 6. 媒体 CAS

媒体字节只按实际内容寻址：

```text
data/media/sha256/ab/ab12...（总计 64 位，无扩展名）
```

- `kind`、声明 MIME、魔数检测 MIME、检测器版本、建议扩展名和原文件名只写入
  `indexes/media.ndjson`。
- 原件、缩略图、传输密文和解密后可观察字节是不同 asset，通过关系字段关联。
- `full`/`thumbnail` 必须存在 CAS；`missing`、`expired`、`decrypt_error`、
  `not_requested` 不得创建伪造空文件。
- 文件名、JID、消息 ID 和账号信息不进入任何磁盘路径。

## 7. 完整性与数据包完整性必须分开

`verify` 只能证明 BagIt 结构、文件字节、签名、引用和计数自洽，不能证明 WhatsApp
服务端没有更多数据。`completeness.json` 只描述采集覆盖范围：

- `localSnapshot`: `verified | partial | failed`
- `historyScope`: `terminal_observed | stable_no_growth | limit_reached | loader_error | not_run`
- `mediaScope`: `complete | partial | not_requested`
- `accountScope`: 固定为 `unverifiable`
- `overall`: `complete_as_observed | partial | failed`

每个聊天的加载轮次、初始/最终计数、最早/最晚时间、终止依据和原因码写入
`data/completeness/chats.ndjson`。

## 8. 日志链与封印顺序

日志事件哈希固定为：

```text
SHA-256(
  UTF8("WAEB-LOG-v1\0") ||
  previousEventHashBytes（genesis 使用 32 个零字节） ||
  UTF8(JCS(eventWithoutEventHash))
)
```

封包顺序必须避免循环依赖：

1. 关闭所有 payload 文件和采集日志。
2. 生成 `manifest-sha256.txt` 与 `manifest-sha512.txt`。
3. 生成 schema、`bag-info.txt` 与 `signer.json`。
4. 生成 `seal.json`，列出 payload manifests 和核心 tag/schema 的摘要。
5. 对 `seal.json` 的原始 UTF-8 字节生成 Ed25519 detached signature。
6. 最后生成覆盖以上 tag 文件但不覆盖自身的 `tagmanifest-sha256.txt`。

v1 seal 必须按规范顺序恰好覆盖两份 payload manifest，以及 `bagit.txt`、
`bag-info.txt`、完整的 v1 Schema 集和 `signatures/signer.json`；重复、缺少或额外路径
均为无效。`seal.json` 与 `seal.ed25519` 由最终 tag manifest 覆盖，但不反向写入 seal，
从而避免摘要循环。

独立验证器必须内置或随自身可信发布 v1 的 Schema 文件集合与摘要、18 个数据集和
19 项 capability 契约；包内附带的 Schema 只用于自描述和审计，不能反过来扩展验证器
接受的格式。包内 Schema 与验证器的可信副本逐字节不一致时必须失败关闭。

WA Evidence Bag v1 只有完成 Ed25519 签名后才算封存；未配置或无法解锁密钥时，
Collector 只能保留明确标记的 staging 目录，不能生成可交接的 v1 包。包内公钥只能证明
签名数学有效，不能自行证明操作者身份。验证结果区分 `valid_trusted`、
`valid_untrusted` 和 `invalid`；可信指纹来自交接单、`--trusted-key` 或实验室 trust store。

## 9. 生成与验证合成示例

在仓库根目录运行：

```powershell
node spec/wa-evidence-bag/v1/tools/build-minimal-example.mjs
node spec/wa-evidence-bag/v1/tools/verify-example.mjs
python spec/wa-evidence-bag/v1/tools/validate-schemas.py
node spec/wa-evidence-bag/v1/tools/test-negative-fixtures.mjs
node spec/wa-evidence-bag/v1/tools/test-jcs.mjs
```

生成结果位于：

```text
spec/wa-evidence-bag/v1/examples/minimal-valid-signed/
```

测试私钥仅用于逐字节可复现 fixture，保存在 `test-vectors/keys/`，任何生产构建都必须
拒绝加载该目录。示例中的人名、JID、UUID、时间和媒体均为人工合成。

`validate-schemas.py` 还包含 7 个 Schema 反例；`test-negative-fixtures.mjs` 会重新生成
密码学自洽但契约错误的临时包，证明示例验证器拒绝重复 manifest、缺失核心 tag、
重复数据集、非法状态组合、重复 capability、额外嵌入 Schema 和被篡改的 Schema index。
二者仅是规范开发/CI 工具，前者依赖
`requirements-dev.txt`，不会进入
Field Collector 发行包。`verify-example.mjs` 验证 BagIt、双 manifests、tag manifest、
CAS、引用、数据集计数、日志链、seal 和 Ed25519；正式 Rust verify CLI 还必须实现
运输容器限额、重复 JSON key、压缩炸弹、Unicode/大小写路径冲突及外部 trust policy。

## 10. Collector 与 Analysis Workstation 的职责

- Field Collector 负责生成记录、流式写 CAS、关闭 payload、生成 manifests 和签名。
- 独立 `verify` 实现只共享本规范、JSON Schema 和测试向量，不链接 Collector writer。
- Analysis Workstation 只导入通过策略验证的 v1+ Evidence Bag，不读取旧 ZAPiXWEB ZIP。
- SQLite、全文/向量索引、缩略图、标注、Agent 结果和报告均是派生数据，不写回本包。
