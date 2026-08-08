# `waeb-verify`

WA Evidence Bag v1 的独立、只读 Rust 校验器。它不链接 Field Collector 的 writer、
采集状态机或分析端代码；可信 v1 Schema 在编译时嵌入可执行文件。

```powershell
cargo run --release -- <waeb-directory>
cargo run --release -- <waeb-directory> --trusted-fingerprint sha256:<64-hex>
```

标准输出始终为一个 JSON 文档。成功状态为 `valid_untrusted` 或 `valid_trusted`；
失败状态为 `invalid` 且进程退出码为 1。包内公钥只证明签名数学有效，可信状态必须来自
调用方提供的指纹。

校验范围不仅包含目录安全、BagIt 清单和 Ed25519 签名，还包含：内嵌 v1 JSON
Schema、18 个规范化 NDJSON 数据集、白名单 raw 记录及 provenance、数据集计数与
字节数、采集日志哈希链、每聊天完整性覆盖、媒体索引/CAS/附件引用，以及
`evidenceId`/`sourceId` 跨文件一致性。因此，即使攻击者重新生成清单并用合法测试密钥
重新签名，语义不一致的包仍会判为 `invalid`。

跨记录引用还会按固定 v1 类型矩阵检查；媒体 source 与 normalized 资产引用必须双向
对应（缩略图等次级资产可通过 `relatedAssetIds` 关联到直接引用的主资产）；capability
探针与 inventory/request/result 必须因果一致；每个 chat 的 `finalMessageCount` 必须等于
实际归入该 chat 的 normalized message 数。

校验器当前只接受目录式 v1 Evidence Bag。压缩运输容器应由另一个具有限额、路径冲突和
压缩比防护的解包层先解包到隔离目录，再调用本工具。
