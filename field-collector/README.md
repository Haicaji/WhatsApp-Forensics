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
3. 选择本机原有 Chrome/Edge Profile，正常打开 WhatsApp Web，并按中文向导加载 U 盘扩展；
4. 在当前 WhatsApp 页面点击扩展、输入一次性配对码并确认后，等待只读 T0 采集完成；
5. 查看独立校验与交接结果。

现场界面不再要求填写输出目录、密钥文件、操作者 ID、机构、案件引用、密钥 ID、可信指纹、
语言区域、时区或第二遍口令，也不提供首次密钥生成入口。身份、密钥和任务均由 Analysis
Workstation 预先下发；Evidence Bag 自动保存到 U 盘固定目录。

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

## v0.1 采集边界

- 一次只绑定一个已确认的 WhatsApp page/account，生成一个 source/Evidence Bag；两个测试账号
  必须分别采集，随后由 Workstation 归入同一案件。
- Collector 只读解析 Chromium 的 `Local State` Profile 索引，由勘察员选择原 Profile；不会读取
  Cookie、密码、历史记录或浏览器存储，也不会复制 Profile、结束浏览器或模拟 F12。
- 扩展只申请 `activeTab` 与 `debugger`，仅在操作者当前点击的 `https://web.whatsapp.com/`
  标签页获得临时权限；传输只走固定端口的一次性配对本机通道。
- 只执行当前客户端可观察的 accounts、contacts、chats、messages 被动 T0。
- 不加载历史、不下载媒体、不点击聊天、不改变已读状态，不启用 Network/Storage/Input/DOM 写入。
- Main World 只运行编译时固定 IIFE；宿主拉取有界帧，逐帧校验并落盘后 ACK，页面不构造 ZIP。
- 使用固定 18 个 NDJSON 数据集、媒体 CAS 契约、能力诊断、完整性分级和哈希链日志。
- 使用 `.partial` staging 封存；只有独立 `waeb-verify.exe` 完成结构、Schema、语义、哈希与签名
  校验并绑定本次 evidence ID、manifest root、签名指纹后，才原子晋升到 `evidence/sealed`。
- 交接摘要自动写入 `handoff/`，不含聊天正文、JID、手机号、target ID 或浏览器 endpoint。
- 未知 WhatsApp build 或能力探测失败时不解锁密钥、不生成正式 Evidence Bag，并尝试在
  `diagnostics/` 写入不含聊天内容的版本/Adapter 诊断。

结论只能表述为“采集时段内该 WhatsApp Web 客户端可观察到的数据”，不能宣称账号级绝对全量。

## 浏览器与扩展说明

现场 GUI 只有普通操作：选择 Profile、打开 WhatsApp、打开扩展管理页和扩展文件夹、等待扩展
连接。勘察员不填写端口，不理解 CDP，不打开 F12，也不粘贴脚本。扩展外壳只转发 Rust 核心
固定需要的 `Runtime`/`Page` 命令；`Network`、`Storage`、`DOM`、`Input`、任意 JavaScript、
任意 URL 和非 WhatsApp 页面均在扩展与 Rust 两侧失败关闭。

扩展通过浏览器调试 API 把发行包中经 SHA-256 核对的版本化 Adapter 注入当前 WhatsApp 页的
MAIN World。扩展外壳、传输协议和 Evidence Bag 保持稳定；WhatsApp 更新时原则上只更新
Adapter，并在两个授权测试账号上重跑消息类型矩阵后发布新版扩展。正式发行版只启动 GUI，
不接受 endpoint、端口、target ID、Profile 路径或任意脚本参数；旧直连命令仅在 debug 构建中
保留给回归测试。

打开原 Profile、加载未打包扩展、WhatsApp 网络同步和浏览器缓存更新都可能改变现场计算机。
采集日志和 `acquisition.json` 明确记录浏览器产品原始运行状态、Profile 的非路径摘要、打开时间、
扩展加载/激活方式、浏览器/扩展/Adapter 版本及可能影响，不作“无痕”承诺。

## 工程结构

```text
field-collector/
├─ crates/
│  ├─ field-collector-app/   # 原生现场 GUI、校验/交接编排
│  ├─ collector-core/        # 只读 T0 状态机、目标锁、审计
│  ├─ browser-cdp/           # 严格回环 CDP 与 WhatsApp target 过滤
│  ├─ browser-profile/       # 原 Chrome/Edge Profile 只读发现与正常打开
│  ├─ extension-transport/   # 一次性本机配对与最小 CDP facade
│  ├─ page-bridge/           # 有界桥协议
│  ├─ portable-config/       # 签名配置/任务加载；可选 Workstation provisioning API
│  ├─ portable-keystore/     # 便携加密密钥解锁；生成能力仅限 provisioning/test
│  └─ waeb-writer/           # Evidence Bag staging、清单、seal 与晋升
├─ extension/                # MV3 稳定外壳、中文 popup、发行 Adapter
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

## 尚未完成

- 两个授权测试账号各自的真实只读 T0 Evidence Bag；
- 原 Profile 中人工加载发行扩展后的 Chrome/Edge 全流程实机矩阵；
- 无开发环境的干净 Windows VM、移动介质和普通用户整套验收；
- Status、通话、频道、社区、历史、媒体字节和断点恢复；
- Analysis Workstation 的完整 Electron GUI 和案件库；U 盘下发的独立安全后端/CLI 已完成，
  尚待通过受限 IPC 接入正式界面。

生产 Collector 永远保持只读。使用 Chrome 测试插件在两个授权账号之间构造合成私聊和双人群组
消息，只是独立测试准备动作，不属于 Collector，也不得扩展到第三账号。
