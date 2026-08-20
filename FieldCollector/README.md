# FieldCollector 提取验证原型

这是一个与旧 `field-collector/` 完全隔离的新原型。它连接操作者当前打开并已登录的
WhatsApp Web 页面，将当前客户端可观察、可加载的数据写成普通 JSON、CSV 和原始媒体文件，并在
原生 egui 界面中直接查看。它不使用 SQLite 或其他结果数据库，也不生成 SQL、ZIP、Evidence
Bag、签名或加密封装。

## 当前能力

- Chrome 优先，扩展清单同时兼容 Edge Chromium；
- 原生程序内置可再发行的 Noto Sans CJK SC，不依赖 Windows 的微软雅黑字体文件；
- 一次性配对码连接当前激活的 `https://web.whatsapp.com/` 标签页；
- 通过固定 MAIN World 提取器读取 WhatsApp 私有模型；
- 优先调用 `WAWebChatLoadMessages.loadEarlierMsgs`，不可用时按会话 ID 打开并滚动；
- 对消息按原生 ID 去重，并为每个会话写出历史完整性报告；
- 记录 22 类数据的 `supported` / `unavailable` 能力状态；
- 社群优先读取专用集合，并以群元数据和 `community_create`、`sub_group_link` 等已观察群事件回退重建社群—公告群—子群关系；
- 会话内置顶优先读取 `WAWebPinInChatCollection`，并保留可观察消息协议事件的回退结果；
- 动态通过 `WAWebStatusCollection` 主动同步并按发布者保存条目，不调用已读接口；
- 历史通话优先通过 `WAWebDBMessageFindLocal.msgFindCallLog` 分页读取，并兼容新版内部 `Map` 集合；
- 已加入频道会刷新 newsletter 成员身份元数据，排除明确的 `guest`，并在可配置滚动时间窗内加载频道消息；默认提取最近 15 天；
- 频道消息中的图片、视频、音频和文档与聊天附件使用同一套原件、预览和失败状态，并可独立关闭；
- 会话和复杂事件保留去除重复集合与无意义未定义字段后的 JSON 安全 `raw` 快照；消息、联系人、成员和回执使用紧凑 CSV；
- 原始媒体通过 `ReadableStream` 或 Blob 流按 128 KiB 块传给 Rust 落盘，不要求预先知道附件总大小；
- 附件完成后统一计算 SHA-256，跨聊天和频道内容相同的附件只保留一个物理对象；每次引用仍保留各自的原始文件名；
- 原件失败时仍可保存明确标记为 `preview` 的预览引用，旧版 HKDF/AES-CBC 回退会标为需整段缓冲；
- 头像只请求实际出现在会话、频道、群成员、消息发送者/接收者或当前账号中的 ID；没有头像 URL 时直接跳过；
- 单个头像连接等待最多 15 秒、总耗时最多 30 秒、连续 10 秒无数据即记为不可用并继续；
- 提取前可配置是否采集动态、通话、频道、聊天附件、频道附件和头像，以及频道天数和单附件大小上限；`0 MiB` 表示不限制附件总大小；
- 每个结构化批次和媒体块同步写入 `.partial` 后才向页面 ACK；
- 查看会话、消息引用、事件、反应、回执、投票、成员、JSON/CSV 全局数据集、图片缩略图和原文件。

“全部”只表示采集期间此 WhatsApp Web 客户端能观察和加载到的内容。服务端已删除、尚未同步、
权限不可见或 WhatsApp 当前构建不再暴露的类型会明确记录为不可用，不能据此推断账号级绝对全量。

## 目录和数据流

```text
egui 程序
  ↕ 127.0.0.1:17654 + 一次性配对码
MV3 扩展（activeTab + debugger + 用户点击后读取剪贴板）
  ↕ 固定 CDP Runtime 命令
MAIN World 提取器（probe/start_full/next/ack/cancel）
  ↓ 有序 JSON 帧与媒体块
SessionWriter → exports/<时间>_<随机ID>[.partial]/
```

Rust 只有一个 crate：`transport.rs` 负责扩展连接，`acquisition.rs` 负责拉取/ACK，`storage/`
负责合法 JSON、CSV 和源文件，`viewer/` 只读取输出目录。`extractor/src/` 中的模块会被构建脚本按固定
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
5. 在界面填写必填的检材名称，确认输出目录并开始提取；检材名称会保存到
   `manifest.json` 的 `evidenceItem.name`；提取结束后切换到“查看数据与源文件”。

每次修改 `extractor/src` 或 `extension/src` 后必须重新运行 `npm run build`。Rust 使用
`include_str!` 编译嵌入 `extractor/dist/collector.iife.js`，扩展发布相同内容。

### Analysis Workstation 便携任务模式

当可执行文件旁存在有效的 `task.json` 时，程序进入便携任务模式：

- 扩展目录固定为同级 `extension\`；
- 结果目录固定为同级 `results\`，界面不允许修改；
- 界面显示案件名称、任务名称和任务编号；
- session 使用 `field-collector-session/6`，并在 `manifest.json` 写入 `sessionId` 和任务引用。

如果相邻的 `task.json` 已存在但损坏，程序会显示阻断错误，不会静默回退到独立模式。没有
`task.json` 时继续使用当前源码目录下的 `extension\dist` 和 `exports`，输出仍为
`field-collector-session/5`，不改变现有独立使用方式。

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
├─ contacts.csv
├─ chat-lists.json
├─ global/
│  ├─ statuses.json
│  ├─ calls.json
│  ├─ channels.json
│  ├─ channel-events.json
│  ├─ channel-media/index.json
│  └─ 其他全局数据集.json
├─ media/
│  ├─ index.json
│  ├─ avatars.json              # 头像与联系人/频道 ID 的引用关系
│  ├─ objects/<SHA256前两位>/<SHA256>.<首次观察到的扩展名>
│  └─ incoming/                 # 仅采集中间文件或失败后保留的部分文件
├─ chats/<序号>_<安全会话ID>/
│  ├─ chat.json
│  ├─ history.json
│  ├─ participants.csv
│  ├─ messages.csv
│  ├─ message-events.json
│  ├─ reactions.json
│  ├─ receipts.csv
│  ├─ poll-votes.json
│  ├─ group-events.json
│  ├─ media-albums.json
│  ├─ pins.json
│  └─ media/index.json          # 指向顶层 media/objects 的引用
└─ logs/extraction.csv
```

会话目录开头的数字是本次采集发现会话的顺序号，不属于 WhatsApp 会话 ID。新结果使用自然长度的
`1_`、`2_`、…、`10000_`，不再固定为四位或补前导零，因此会话数量没有四位数限制。

提取日志使用 CSV 固定列保存常用上下文，未归类的少量诊断数据以紧凑 JSON 放在 `detail` 单元格，
不再生成逐条缩进的 `extraction.json`。查看器仍兼容旧结果中的 JSON 日志。

`media/index.json` 是按 SHA-256 组织的全部媒体对象目录，聊天附件、频道媒体和头像都使用这里的
同一物理仓库。对象使用哈希作为物理文件名，避免不同来源重复保存同一内容；目录中的
`originalFileNames` 收集所有观察到的文件名，各聊天、频道和头像引用的索引也继续记录各自的
`media/index.json` 也继续记录该次引用自己的 `originalFileName`、消息 ID、角色、MIME、大小和
相对路径。因此，同一个 SHA-256 即使在不同消息中使用了不同文件名，也不会丢失名称关系。

附件大小策略对有声明大小或 HTTP `Content-Length` 的附件会在下载前跳过；大小未知时仍采用流式
读取，但在下一块会超过上限前停止，并将记录标为 `skipped`。策略跳过不计入下载失败。频道时间
窗是采集时向前计算的滚动天数；WhatsApp 私有加载器无法继续提供更早记录时，能力与频道记录会
保留明确的完整性原因，而不会以空数组伪装成功。

采集期间目录带 `.partial`。完整结束后 Rust 原子去掉该后缀；失败或取消时保留 `.partial`，其中
已经提交的 JSON、CSV 和文件仍可人工检查。原型暂不支持断点续采。

界面会分别显示“正在请求媒体”“媒体响应已建立”和实际已接收字节数。请求阶段长时间没有
`media_start` 表示仍在等待 WhatsApp/其 CDN；进入保存阶段后则会持续显示落盘进度。

## 安全与副作用边界

- 扩展只申请 `activeTab`、`debugger` 和 `clipboardRead`，剪贴板仅在点击“粘贴”后读取，并再次核对标签页 origin；
- 扩展只接受固定的 Runtime 命令、函数声明和参数结构，不提供任意 JavaScript 执行接口；
- 本机通道只监听 `127.0.0.1`，并要求 10 位一次性配对码；
- 16 MiB 只限制单条 WebSocket JSON 消息；附件由不限数量的 128 KiB 原始数据块组成；
- 全历史加载会打开/滚动会话、触发 WhatsApp 同步和附件下载，可能产生已读、缓存与网络副作用；
- 首版是功能验证原型，不包含案件授权、证据签名、加密、封存、恢复或生产级规模保证。

提取思路参考了仓库中的 GPL-3.0 ZAPiXWEB 归档；来源与许可说明见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。归档代码不是运行时依赖。
