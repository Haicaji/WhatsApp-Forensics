# Main World 宿主拉取式桥协议 v0.1

本目录包含现场采集器通过 CDP `Runtime.evaluate` 注入 WhatsApp Web Main
World 的只读控制器。`src/collector.ts` 本身是合法 TypeScript，同时不依赖任何
TypeScript 运行时语法；`dist/collector.iife.js` 与它逐字节一致。发行程序应嵌入
`dist` 文件及其固定 SHA-256，不得从网络加载脚本。

## 安全模型

- IIFE 的计算结果就是 CDP remote object，不向 `window` 或 `globalThis` 写入属性。
- 宿主只能调用 `dispatch("probe")`、`dispatch("start_t0")`、`next()`、
  `ack(sequence)`、固定的 `checkAccountBinding()` 和 `cancel()`；协议不存在脚本文本、
  模块名、DOM selector、URL 或任意参数入口。
- `probe` 仅匹配 `wa-private-collections-v1` 的固定私有模块和集合结构签名。
  不匹配的 WhatsApp build 返回 `supported: false`，`start_t0` 随后以
  `unsupported_build` 关闭失败。
- T0 只读取当前客户端已经可观察到的 account、contact、chat 和 message
- 页面异常只映射为固定白名单原因码；私有模块或 getter 的原始异常文本不得进入桥帧
  collection，不调用历史加载、媒体下载、发送消息、建群、点击或 DOM 写入功能。
- 序列化器逐字段构造新对象，不使用模型的 `toJSON()`，避免把未知私有字段带出
  页面。T0 结论仅代表本地被动快照，不代表账号全量记录。
- IIFE 每次创建 controller 时生成一个从不输出的 32 字节随机 secret，内部 binding 为
  `SHA-256(domain || secret || 当前原生账号 ID)`。它只存在于本次 attached session 的
  易失内存和桥帧中，用于同次一致性检查；不是公开指纹，不能跨次关联，也不证明账号真实性。

## 调用顺序

```text
Runtime.evaluate(IIFE, returnByValue=false)
  -> controller remote object
dispatch("probe")
  -> next() -> probe_result frame -> host validates -> ack("0")
  -> host displays one-time visual-confirmation challenge
  -> operator confirms -> checkAccountBinding() -> host constant-time validates
dispatch("start_t0")
  -> next() -> stream_start -> ack
  -> next() -> records ... -> ack each frame
  -> next() -> stream_end -> ack
  -> checkAccountBinding() -> host final constant-time validation
  -> Runtime.releaseObject -> detach -> confirmed transport close
```

人工拒绝、EOF、输错或 120 秒超时发生在 `start_t0` 之前；宿主必须释放 remote object、
detach 并确认关闭 transport，且不得解锁签名密钥或创建 Evidence Bag/staging。

`next()` 在 ACK 前始终返回同一冻结帧。`ack()` 接受规范十进制字符串；对最后一次
ACK 的重复调用返回 `true`，其他乱序 ACK 返回 `false`。`cancel()` 立即清除页面端
引用并使会话进入终态。

## 严格帧 DTO

```json
{
  "protocol": "wafc-bridge/1",
  "sessionId": "UUID",
  "sequence": "2",
  "stream": "record",
  "kind": "records",
  "encoding": "utf8_json",
  "payloadBytes": 1234,
  "payloadSha256": "64 lowercase hex characters",
  "recordCount": 20,
  "payload": "{\"dataset\":\"messages\",\"records\":[...]}"
}
```

枚举约束：

| 字段 | 允许值 |
|---|---|
| `stream` | `control`、`record`、`media` |
| `kind` | `probe_result`、`stream_start`、`records`、`media_chunk`、`stream_end`、`error`、`cancelled` |
| `encoding` | `utf8_json`、`base64` |
| `dataset` | `accounts`、`contacts`、`chats`、`messages` |

`sequence` 必须是 `"0"` 或不以零开头的无符号十进制字符串。`payloadBytes` 和
`payloadSha256` 均针对解码后的 payload 字节；Base64 必须采用 RFC 4648 标准带
padding 的规范形式。Rust DTO 全部使用 `deny_unknown_fields`。

## 硬限额

| 边界 | 上限 |
|---|---:|
| control frame 解码 payload | 64 KiB |
| record/media frame 解码 payload | 256 KiB |
| 单个 record frame | 256 records |
| 页面 ready queue | 2 MiB |

v0.1 控制器只保留一个未 ACK 帧，实际 ready queue 不超过 256 KiB。媒体帧类型和
宿主校验已在协议中固定，但被动 T0 adapter 明确报告 `media: false`，本版不会读取
或发出媒体内容。

## 宿主验证规则

`page-bridge` crate 在 ACK 前验证协议、session、枚举组合、规范序号、解码字节数、
SHA-256、JSON 结构、recordCount、逐帧上限和队列上限。当前序号的完全相同重投被
视为合法 redelivery；元数据或摘要不同的同序号帧、跳号帧以及提前 ACK 均被拒绝。
