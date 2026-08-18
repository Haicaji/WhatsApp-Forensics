# FieldCollector JSON 提取验证原型

这是一个与旧 `field-collector/` 完全隔离的新原型。它连接操作者当前打开并已登录的
WhatsApp Web 页面，将当前客户端可观察、可加载的数据写成普通 JSON 和原始媒体文件，并在
原生 egui 界面中直接查看。它不使用 SQLite 或其他结果数据库，也不生成 SQL、ZIP、Evidence
Bag、签名或加密封装。

## 当前能力

- Chrome 优先，扩展清单同时兼容 Edge Chromium；
- 一次性配对码连接当前激活的 `https://web.whatsapp.com/` 标签页；
- 通过固定 MAIN World 提取器读取 WhatsApp 私有模型；
- 优先调用 `WAWebChatLoadMessages.loadEarlierMsgs`，不可用时按会话 ID 打开并滚动；
- 对消息按原生 ID 去重，并为每个会话写出历史完整性报告；
- 记录 22 类数据的 `supported` / `unavailable` 能力状态；
- 每条结构化记录同时保留 JSON 安全的 `raw` / `toJSON` 快照；
- 原始媒体通过 `ReadableStream` 或 Blob 流按 128 KiB 块传给 Rust 落盘，不要求预先知道附件总大小；
- 下载失败时把预览放入独立目录并明确标记，旧版 HKDF/AES-CBC 回退会标为需整段缓冲；
- 头像只请求实际出现在会话、群成员、消息发送者/接收者或当前账号中的 ID；没有头像 URL 时直接跳过；
- 单个头像连接等待最多 15 秒、总耗时最多 30 秒、连续 10 秒无数据即记为不可用并继续；
- 每个结构化批次和媒体块同步写入 `.partial` 后才向页面 ACK；
- 查看会话、消息引用、事件、反应、回执、投票、成员、全局数据集、格式化 JSON、图片缩略图和原文件。

“全部”只表示采集期间此 WhatsApp Web 客户端能观察和加载到的内容。服务端已删除、尚未同步、
权限不可见或 WhatsApp 当前构建不再暴露的类型会明确记录为不可用，不能据此推断账号级绝对全量。

## 目录和数据流

```text
egui 程序
  ↕ 127.0.0.1:17654 + 一次性配对码
MV3 扩展（activeTab + debugger）
  ↕ 固定 CDP Runtime 命令
MAIN World 提取器（probe/start_full/next/ack/cancel）
  ↓ 有序 JSON 帧与媒体块
SessionWriter → exports/<时间>_<随机ID>[.partial]/
```

Rust 只有一个 crate：`transport.rs` 负责扩展连接，`acquisition.rs` 负责拉取/ACK，`storage/`
负责合法 JSON 和源文件，`viewer/` 只读取输出目录。`extractor/src/` 中的模块会被构建脚本按固定
顺序合成一个 IIFE；扩展拒绝 Rust 发送任何与该 IIFE 字节不相等的表达式。

## 构建与运行

```powershell
cd .\FieldCollector
npm run build
npm test
cargo test --locked
cargo run --locked
```

首次使用 Chrome：

1. 打开 `chrome://extensions`，启用“开发者模式”；
2. 点击“加载已解压的扩展程序”，选择界面显示的 `FieldCollector\extension\dist`；
3. 打开并登录 `https://web.whatsapp.com/`；
4. 启动 Rust 程序，将界面的一次性配对码输入扩展；
5. 确认输出目录并开始提取；提取结束后切换到“查看 JSON 与源文件”。

每次修改 `extractor/src` 或 `extension/src` 后必须重新运行 `npm run build`。Rust 使用
`include_str!` 编译嵌入 `extractor/dist/collector.iife.js`，扩展发布相同内容。

媒体缓存读取和 `downloadMedia` 参数兼容逻辑参考了 Apache-2.0 许可的
[whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js) `resolveMediaBlob` 实现；
FieldCollector 仍只保存页面当前能够获取的原件或明确标记的预览。
重新构建后还需要在 `chrome://extensions` 对 FieldCollector 点击“重新加载”，并关闭、重启
正在运行的 Rust 程序，否则浏览器或程序仍会使用旧的固定提取器字节。

若旧版本出现 CDP `Object reference chain is too long`，说明 Chrome 尝试直接遍历某条记录的
深层 `raw` 对象。当前版本会先在页面端序列化为 JSON 文本，并按序列化大小拆批，避免触发该限制。

提交前可运行完整检查：

```powershell
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
npm test
```

## 输出结构

```text
exports/<session>/
├─ manifest.json
├─ capabilities.json
├─ account.json
├─ contacts.json
├─ chat-lists.json
├─ global/*.json
├─ avatars/{index.json, 原头像文件}
├─ chats/<序号>_<安全会话ID>/
│  ├─ chat.json
│  ├─ history.json
│  ├─ participants.json
│  ├─ messages.json
│  ├─ message-events.json
│  ├─ reactions.json
│  ├─ receipts.json
│  ├─ poll-votes.json
│  ├─ group-events.json
│  ├─ media-albums.json
│  ├─ pins.json
│  └─ media/{index.json,original/,preview/}
└─ logs/extraction.json
```

采集期间目录带 `.partial`。完整结束后 Rust 原子去掉该后缀；失败或取消时保留 `.partial`，其中
已经提交的 JSON 和文件仍可人工检查。原型暂不支持断点续采。

界面会分别显示“正在请求媒体”“媒体响应已建立”和实际已接收字节数。请求阶段长时间没有
`media_start` 表示仍在等待 WhatsApp/其 CDN；进入保存阶段后则会持续显示落盘进度。

## 安全与副作用边界

- 扩展只申请 `activeTab` 和 `debugger`，并再次核对标签页 origin；
- 扩展只接受固定的 Runtime 命令、函数声明和参数结构，不提供任意 JavaScript 执行接口；
- 本机通道只监听 `127.0.0.1`，并要求 10 位一次性配对码；
- 16 MiB 只限制单条 WebSocket JSON 消息；附件由不限数量的 128 KiB 原始数据块组成；
- 全历史加载会打开/滚动会话、触发 WhatsApp 同步和附件下载，可能产生已读、缓存与网络副作用；
- 首版是功能验证原型，不包含案件授权、证据签名、加密、封存、恢复或生产级规模保证。

提取思路参考了仓库中的 GPL-3.0 ZAPiXWEB 归档；来源与许可说明见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。归档代码不是运行时依赖。
