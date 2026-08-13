# WAFC Field Collector

`field-collector` 是放在取证 U 盘上的现场快速勘察工具；Analysis Workstation 是实验室高算力
计算机上的案件分析软件。二者是两套独立产品，只通过语言无关的 Evidence Bag 与便携配置规范
协作。Collector 不包含案件数据库、查看器、MCP、Agent、报告、消息发送或建群能力。

新实现可以参考 ZAPiXWEB 的取证手法，但不兼容其 ZIP、字段、脚本或测试，不为旧格式承担运行时
负担。

## 面向现场人员的使用方式

现场人员只需双击 `field-collector.exe`，然后完成五件事：

1. 确认 Workstation 下发的勘察员身份与案件任务；
2. 输入一次勘察员密钥口令并确认已获授权；
3. 选择本机原有 Chrome/Edge Profile；可由程序正常打开 WhatsApp Web，也可确认对应页面已经打开而不重复打开；随后按中文向导加载 U 盘扩展；
4. 在当前 WhatsApp 页面点击扩展、输入一次性配对码并确认后，等待任务指定的只读采集完成；
5. 查看独立校验与交接结果。

现场界面不再要求填写输出目录、密钥文件、操作者 ID、机构、案件引用、密钥 ID、可信指纹、
语言区域、时区或第二遍口令，也不提供首次密钥生成入口。身份、密钥和任务均由 Analysis
Workstation 预先下发；Evidence Bag 自动保存到 U 盘固定目录。

Windows GUI 启用 AccessKit 无障碍桥，按钮、勾选框和输入框可被系统读屏与键盘辅助识别；
密码框额外处理标准 `SetValue` 动作，并执行与手工输入相同的至少 8 字符、至多 1024 个
UTF-8 字节的解锁边界校验。新密钥的“大写字母＋小写字母＋数字＋符号”强度规则由 Analysis
Workstation 在下发时执行，Collector 只负责解锁，因而既有合法 U 盘不会被追溯判为无效。该设计
既方便非专业勘察员，也让现场验收能够按控件语义执行，而不是依赖屏幕坐标盲点。

## Workstation 下发的 U 盘结构

```text
WAFC-USB/
├─ field-collector.exe
├─ waeb-verify.exe
├─ extension/
│  ├─ manifest.json
│  ├─ service-worker.js
│  └─ adapter/{adapter-manifest.json,collector.iife.js}
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

所有路径都从当前 `field-collector.exe` 的真实父目录解析。盘符由 `E:` 变成 `F:` 不影响语义；
程序不会扫描其他磁盘、使用 AppData 保存身份或口令、接受绝对输出路径、跟随 symlink/junction/
reparse point，或回退到未签名配置。

便携配置契约位于 `spec/wafc-portable-bundle/v1`。`portable-config` 的 `provisioning` feature
提供 Workstation 侧的创建函数；该 feature 不会进入生产 Collector 构建。函数负责生成每名
勘察员独立的 Ed25519 证据签名密钥、以 Argon2id + XChaCha20-Poly1305 加密私钥、签署任务和
配置清单，并把勘察员公钥与可信指纹返回给 Workstation 登记。Workstation 私钥和勘察员明文
私钥都不会复制到 Collector 发行物。

## 双重密钥与信任

- Workstation 配置签名密钥签署便携配置清单和每个任务，用于发现介质损坏、局部替换和未授权修改。
- 勘察员证据签名密钥签署其采集的 Evidence Bag；每名勘察员使用独立密钥。

`workstation-trust.json` 不能自证可信。加密的 `operator-key.enc` 内部还绑定
`operatorId`、`keyId` 和 Workstation 公钥指纹。Field Collector 先做文件哈希和签名初检，
再在页面确认后解锁密钥并核对这三项绑定以及实际勘察员公钥指纹；任何不一致都失败关闭。

同盘自带公钥不能独立解决信任自举。知道 operator 口令并能用自定义工具替换整棵目录的
恶意人员，仍可能重打包另一套密钥和任务；实验室接收必须以 Workstation 本地任务登记表与
勘察员公钥再次核验。若现场也要抵抗该威胁，应使用不随盘交付的组织根证书、智能卡或硬件
密钥，而不能仅增加另一个同盘公钥。

口令、私钥和完整公钥材料不得进入日志、Evidence Bag 或 handoff。Evidence Bag 只记录
bundle ID、任务 ID、清单/任务摘要和允许交接的公钥指纹。

## v0.2 采集边界

- 一次只绑定一个已确认的 WhatsApp page/account，生成一个 source/Evidence Bag；两个测试账号
  必须分别采集，随后由 Workstation 归入同一案件。
- Collector 只读解析 Chromium 的 `Local State` Profile 索引，由勘察员选择原 Profile；不会读取
  Cookie、密码、历史记录或浏览器存储，也不会复制 Profile、结束浏览器或模拟 F12。
- “浏览器是否运行”只按 Chrome/Edge 产品进程观察，不伪装成能够仅凭进程精确判断某个 Profile
  是否已经打开。勘察员可选择“页面已打开，直接继续”；该路径不会再次启动或导航浏览器，当前
  WhatsApp 标签页仍须通过扩展的一次性配对确认。
- 扩展只申请 `activeTab` 与 `debugger`，仅在操作者当前点击的 `https://web.whatsapp.com/`
  标签页获得临时权限；传输只走固定端口的一次性配对本机通道。
- 固定支持两种由 Workstation 签名下发、现场不可修改的模式：快速被动快照只读当前已驻留
  数据；综合只读采集还会调用固定 Store loader 和媒体读取器，可能触发 WhatsApp 网络同步与
  缓存变化。
- 统一输出 accounts、contacts、chats、chat_lists、participants、messages、message_events、
  reactions、receipts、poll_votes、group_events、statuses、calls、channels、channel_events、
  communities、community_relations、presence_snapshots 共 18 类数据；不可访问的类型必须明确
  标为 `unsupported`/`degraded`，不得静默省略。
- 历史补全优先使用版本化 Adapter 的 WhatsApp Store loader；没有新增记录时，可使用固定的
  本地消息数据库方向查询作为只读回退。两者都设置批量、轮次、超时和稳定无增长终止条件；
  没有打开聊天、滚动页面或其他 DOM fallback，不主动改变已读状态。当前聊天集合为空时还会
  核对全局只读消息 Store；若聊天元数据明确指向末条消息而所有来源仍为零，则标为部分/失败，
  不伪装成完整空聊天。
- 综合模式中的媒体使用非阻塞 `MediaJob`：Adapter 的每次 `next()` 都快速返回状态或数据块，
  下载等待时间与 10 秒短通信截止时间完全分离。Rust Collector 依据签名 `mediaPolicy` 决定缓存
  等待、网络尝试、重试、无进度/总时限、单文件/总量和磁盘余量，重新计算 SHA-256/SHA-512、
  识别文件魔数并写入无扩展名 CAS。一次下载达到无进展时限且任务仍有剩余次数时，会重新发起
  当前媒体尝试；只有允许次数全部用完后才记为 `media_no_progress_timeout`。单个附件失败只降低
  媒体完整性并继续后续任务。
- 媒体消息模型中可识别的 Base64 缩略图/预览字节不会被当作用户聊天正文；Adapter 保留真实
  caption 与媒体元数据，并用 `media_inline_preview_omitted` 明确记录预览字节未进入结构化文本。
- 反应和回执会合并消息自身字段与已物化的固定 Reactions/MsgInfo 集合，记录群成员级反应、
  送达、已读和语音播放时间；不会主动调用回执查询接口。
- 认证名称、联系人 About、群成员元数据、标签/收藏夹、置顶、StatusV3 与通话只读取当前页面
  已经物化的固定集合。文本 About 不会被当成 Status 动态；置顶父消息不可见时保留遗漏原因，
  不猜测或合成聊天内容。
- 已驻留的标签关联、历史群成员、社区/频道嵌套元数据、群通话参与者与时长，以及 Presence
  在线/输入状态也会进入固定数据集；不会为了补齐这些信息主动订阅 Presence、请求频道成员或
  修改任何本地模型。
- 两种模式都不启用 CDP `Network`/`Storage`/`Input`/DOM 写入，不发送消息、不建群、不修改
  联系人、群组、频道或社群。
- Main World 只运行编译时固定 IIFE；宿主拉取有界帧，逐帧校验并落盘后 ACK，页面不构造 ZIP。
- 使用固定 18 个 NDJSON 数据集、媒体 CAS 契约、能力诊断、完整性分级和哈希链日志。
- 使用 `.partial` staging 封存；只有独立 `waeb-verify.exe` 完成结构、Schema、语义、哈希与签名
  校验并绑定本次 evidence ID、manifest root、签名指纹后，才原子晋升到 `evidence/sealed`。
- 综合采集在结构化快照完成后以及每个媒体边界写入两代口令加密、认证的检查点。程序重启或扩展
  重新连接后，GUI 会列出可安全继续的未完成采集；只有签名任务、Profile、浏览器、扩展、
  Adapter、WhatsApp build、当前页面来源和媒体计划全部重新核对一致，才会沿用原 evidence/source
  继续写入。核对失败不会改写原 staging 或检查点，也不会把半成品晋升为正式证据包。
- 交接摘要自动写入 `handoff/`，不含聊天正文、JID、手机号、target ID 或浏览器 endpoint。
- 未知 WhatsApp build 或能力探测失败时不解锁密钥、不生成正式 Evidence Bag，并尝试在
  `diagnostics/` 写入不含聊天内容的版本/Adapter 诊断。

结论只能表述为“采集时段内该 WhatsApp Web 客户端可观察到的数据”，不能宣称账号级绝对全量。

## 浏览器与扩展说明

现场 GUI 只有普通操作：选择 Profile、打开 WhatsApp 或确认页面已打开、打开扩展管理页和扩展
文件夹、等待扩展连接。勘察员不填写端口，不理解 CDP，不打开 F12，也不粘贴脚本。扩展外壳只转发 Rust 核心
固定需要的 `Runtime`/`Page` 命令；`Network`、`Storage`、`DOM`、`Input`、任意 JavaScript、
任意 URL 和非 WhatsApp 页面均在扩展与 Rust 两侧失败关闭。

本机通道每 15 秒交换一次无内容心跳；连续两个安静周期内既无心跳应答、也无通过校验的 CDP
响应或事件时，才判定通道中断。这样长媒体分块产生的有效通信本身也作为保活依据，不会因为专用
心跳应答被浏览器扩展延迟而误停。popup 持续显示后台实时状态，不把已经关闭的通道继续标为
“已连接”。普通 CDP 调用保持约 10 秒短截止时间；
媒体的缓存等待、网络尝试、无进度和单附件总时限由 Rust 独立计时，不再通过不断增大通信超时
掩盖慢媒体。

所有五个现场页面的正文区都有始终可见的纵向滚动条。采集页始终显示“核对、历史、记录、媒体、封存、校验”六阶段、阶段说明、当前数据类别、正在写入
的 Evidence Bag 相对路径、媒体类型、原文件名、媒体序号、尝试次数、当前/累计字节和耗时。
原文件名只用于本机实时界面，不进入进度 JSON、审计日志或交接摘要。失败页保留停止前最后进度，
避免勘察员面对空白页面。勘察员可以在封存前
请求安全取消：Collector 在已接收帧边界停止请求新媒体，保留 `.partial` staging 且不晋升正式包；
浏览器底层已经发起的网络活动可能无法立即停止，界面不得作相反承诺。

预检发现可继续的未完成综合采集时，界面默认显示“继续上次采集”，同时保留“开始新的采集”
选项。续采阶段会用普通中文提示正在核对任务、Profile、WhatsApp 页面和媒体清单；现场人员不需
理解检查点、CDP 或 WebSocket。旧 staging 不会因选择新采集而被静默覆盖。

扩展通过浏览器调试 API 把发行包中经 SHA-256 核对的版本化 Adapter 注入当前 WhatsApp 页的
MAIN World。扩展外壳、传输协议和 Evidence Bag 保持稳定；WhatsApp 更新时原则上只更新
Adapter，并在两个授权测试账号上重跑消息类型矩阵后发布新版扩展。正式发行版只启动 GUI，
不接受 endpoint、端口、target ID、Profile 路径或任意脚本参数；旧直连命令仅在 debug 构建中
保留给回归测试。

打开原 Profile、加载未打包扩展、WhatsApp 网络同步和浏览器缓存更新都可能改变现场计算机。
采集日志和 `acquisition.json` 明确记录浏览器产品原始运行状态、Profile 的非路径摘要、由程序请求
打开或由勘察员确认已打开的准备方式、页面就绪时间、扩展加载/激活方式、浏览器/扩展/Adapter
版本及可能影响，不作“无痕”承诺。

## 工程结构

```text
field-collector/
├─ crates/
│  ├─ field-collector-app/   # 原生现场 GUI、校验/交接编排
│  ├─ collector-core/        # 任务驱动只读状态机、目标锁、审计、媒体流
│  ├─ browser-cdp/           # 严格回环 CDP 与 WhatsApp target 过滤
│  ├─ browser-profile/       # 原 Chrome/Edge Profile 只读发现与正常打开
│  ├─ extension-transport/   # 一次性本机配对与最小 CDP facade
│  ├─ page-bridge/           # 有界桥协议
│  ├─ portable-config/       # 签名配置/任务加载；可选 Workstation provisioning API
│  ├─ portable-keystore/     # 便携加密密钥解锁；生成能力仅限 provisioning/test
│  └─ waeb-writer/           # Evidence Bag staging、清单、seal 与晋升
├─ extension/                # 模块化 MV3 外壳、中文 popup、发行 Adapter
│  └─ src/modules/           # 协议常量、Adapter 加载、固定命令策略
└─ injector/                 # 版本化 MAIN World Adapter → 固定单 IIFE
```

独立校验器位于 `tools/verify-cli`，不依赖 writer、采集状态机或页面注入器。
Workstation 侧的可执行 U 盘下发后端位于 `analysis-workstation/tools/usb-provisioner`，拥有独立
Cargo workspace/锁文件，不会进入 Field Collector 生产依赖或发行 ZIP。

## 构建与验证

```powershell
powershell.exe -NoProfile -File .\field-collector\scripts\Build-Extension.ps1
node .\field-collector\extension\test\security.test.mjs
cargo build --manifest-path .\field-collector\Cargo.toml --workspace --locked
cargo test --manifest-path .\field-collector\Cargo.toml --workspace --locked
cargo clippy --manifest-path .\field-collector\Cargo.toml `
  --workspace --all-targets --locked -- -D warnings
cargo test --manifest-path .\tools\verify-cli\Cargo.toml --locked
```

软件发行 ZIP 与可直接出现场的 U 盘配置包不是同一个概念：发行 ZIP 只包含 Collector、独立
verifier、许可证、SBOM 和来源信息；Analysis Workstation 再把二进制、勘察员配置、加密私钥和
签名任务组装为现场介质。公开正式制品仍要求 clean tree、精确 tag 和干净 VM 验收。

## 仍需实机与规模验收

- 两个授权测试账号各自的真实 v0.2 Evidence Bag，以及 18 类消息矩阵的逐项观察结果；
- 原 Profile 中人工加载发行扩展后的 Chrome/Edge 全流程实机矩阵；
- 无开发环境的干净 Windows VM、移动介质和普通用户整套验收；
- 10 万消息/10 GB 媒体规模、断电/拔盘等非正常中断矩阵和长期 WhatsApp build 兼容矩阵；
- Analysis Workstation 已具备案件创建、取证 U 盘下发、可信 Evidence Bag 接收、SQLite 幂等导入
  和基础聊天浏览；仍需继续完成大规模真实性能、更多可视化分析和 Agent/报告工作流验收。

生产 Collector 永远保持只读。使用 Chrome 测试插件在两个授权账号之间构造合成私聊和双人群组
消息，只是独立测试准备动作，不属于 Collector，也不得扩展到第三账号。
