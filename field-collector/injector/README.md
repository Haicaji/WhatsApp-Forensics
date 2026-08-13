# Main World 宿主拉取式桥协议与 Adapter v0.2

本目录包含现场采集器通过 CDP `Runtime.evaluate` 注入 WhatsApp Web Main
World 的只读控制器。`src/collector.ts` 本身是合法 TypeScript，同时不依赖任何
TypeScript 运行时语法；`dist/collector.iife.js` 与它逐字节一致。发行程序应嵌入
`dist` 文件及其固定 SHA-256，不得从网络加载脚本。

## 安全模型

- IIFE 的计算结果就是 CDP remote object，不向 `window` 或 `globalThis` 写入属性。
- 宿主只能调用带固定 `protocol` 与 `controllerVersion` 的
  `dispatch({command: "probe", ...})`、`dispatch({command: "start_t0", ...})`、
  `dispatch({command: "start_comprehensive", mediaPolicy, ...})`、`next()`、
  `ack(sequence)`、固定的 `checkAccountBinding()`、`controlMedia()` 和 `cancel()`；协议不存在脚本文本、
  模块名、DOM selector、URL 或任意参数入口。
- `probe` 仅匹配 `wa-private-collections-v2` 的固定私有模块和集合结构签名。
  不匹配的 WhatsApp build 返回 `supported: false`，`start_t0` 随后以
  `unsupported_build` 关闭失败。
- 快速被动快照读取当前客户端已经可观察到的 18 类固定数据集，并合并每聊天消息集合与固定
  `WAWebMsgCollection`/`WAWebCollections.Msg` 全局只读 Store，不请求历史或媒体字节。
  综合模式优先调用固定 `WAWebChatLoadMessages` Store loader；Store 没有新增记录时可调用固定
  `WAWebDBMessageFindLocal.msgFindByDirection` 本地只读回退，并使用固定媒体 Blob/download
  读取器；它可能触发网络同步与缓存变化，但没有打开聊天、滚动页面或 DOM fallback。
- 已物化的 `WAWebReactionsCollection` 与 `WAWebMsgInfoCollection` 只按白名单字段展开；不会调用
  `find()` 或主动回执查询，因此未物化的成员回执必须保持不可观察，而不能推断补齐。
- 已物化的 `WAWebGroupMetadataCollection`、`WAWebLabelCollection`、`WAWebPinInChatCollection`、
  StatusV3、Call 与联系人文本状态集合也只按固定字段读取。联系人 About 与 Status 动态严格
  分流；置顶父消息不在本次快照中时仅输出固定遗漏原因，不尝试查询或猜测内容。
- `WAWebLabelItemCollection` 只接受指向本次已观察聊天的标签关联；群元数据中的活动/历史成员、
  社区描述，频道嵌套元数据、群通话参与者以及 Presence/Chatstate 也只展开已经驻留的模型。
  Adapter 不调用 Presence 订阅、频道成员查询或其他补全型网络接口。
- 页面异常只映射为固定白名单原因码；私有模块或 getter 的原始异常文本不得进入桥帧。
  Adapter 不包含发送消息、建群、联系人/群组修改、页面点击或 DOM 写入功能。
- 序列化器逐字段构造新对象，不使用模型的 `toJSON()`，避免把未知私有字段带出
  页面。T0 结论仅代表本地被动快照，不代表账号全量记录。
- IIFE 每次创建 controller 时生成一个从不输出的 32 字节随机 secret，内部 binding 为
  `SHA-256(domain || secret || 当前原生账号 ID)`。它只存在于本次 attached session 的
  易失内存和桥帧中，用于同次一致性检查；不是公开指纹，不能跨次关联，也不证明账号真实性。

## 调用顺序

```text
Runtime.evaluate(IIFE, returnByValue=false)
  -> controller remote object
dispatch({protocol: "wafc-bridge/2", controllerVersion: "0.2.5", command: "probe"})
  -> next() -> probe_result frame -> host validates -> ack("0")
  -> host displays one-time visual-confirmation challenge
  -> operator confirms -> checkAccountBinding() -> host constant-time validates
dispatch({protocol, controllerVersion, command: "start_t0", resume}
  | {protocol, controllerVersion, command: "start_comprehensive", mediaPolicy, resume})
  -> next() -> stream_start -> ack
  -> next() -> records ... -> ack each frame
  -> next() -> progress/media_start/media_chunk/media_end -> ack each frame
  -> next() -> stream_end -> ack
  -> checkAccountBinding() -> host final constant-time validation
  -> Runtime.releaseObject -> detach -> confirmed transport close
```

新的综合采集使用 `resume.existing=false` 和媒体起点 0。跨进程续采使用宿主从已认证检查点恢复的
固定数据集计数、媒体终态计数、媒体计划摘要和下一媒体序号；页面重新生成本次 controller 私有
secret，并以一次性挑战派生 `resumeBindingSha256`。宿主只有在当前页面账号绑定、媒体计划、起点
和已完成计数全部恒定时间核对一致后才允许追加。该绑定只存在于桥会话，不写入 Evidence Bag、
日志、GUI 或命令行，也不证明账号真实性。

人工拒绝、EOF、输错或 120 秒超时发生在 `start_t0` 之前；宿主必须释放 remote object、
detach 并确认关闭 transport，且不得解锁签名密钥或创建 Evidence Bag/staging。

`next()` 在 ACK 前始终返回同一冻结帧。`ack()` 接受规范十进制字符串；对最后一次
ACK 的重复调用返回 `true`，其他乱序 ACK 返回 `false`。`cancel()` 立即清除 Adapter
持有的页面引用并使桥会话进入终态；WhatsApp 内部已经启动且不支持取消的网络 Promise 可能继续，
所以该动作不宣称浏览器网络活动会瞬间停止。

## 严格帧 DTO

```json
{
  "protocol": "wafc-bridge/2",
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
| `kind` | `probe_result`、`progress`、`stream_start`、`records`、`media_start`、`media_chunk`、`media_end`、`stream_end`、`error`、`cancelled` |
| `encoding` | `utf8_json`、`base64` |
| `dataset` | WAEB v1 固定顺序的 18 个 normalized 数据集 |

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

v0.2 控制器只保留一个未 ACK 帧，实际 ready queue 不超过 256 KiB。媒体下载运行在后台
`MediaJob` 中；`next()` 不等待 WhatsApp 下载 Promise，而是立即返回 `progress` 并附带有界
`retryAfterMs`。缓存未命中、开始下载、重试、超时和停止队列均由 Rust 通过固定
`controlMedia()` 动作决定。Blob 就绪后以不超过 192 KiB 的原始字节块发出；页面只提供声明
信息和 Blob 字节，最终 SHA-256/SHA-512、魔数类型、CAS 路径、容量限制和完整性判断均由 Rust
宿主重新计算。每个聊天的历史轮次、增长、空轮次、终止证据和失败原因也作为结构化完整性数据返回。

## 宿主验证规则

`page-bridge` crate 在 ACK 前验证协议、session、枚举组合、规范序号、解码字节数、
SHA-256、JSON 结构、recordCount、逐帧上限和队列上限。当前序号的完全相同重投被
视为合法 redelivery；元数据或摘要不同的同序号帧、跳号帧以及提前 ACK 均被拒绝。
