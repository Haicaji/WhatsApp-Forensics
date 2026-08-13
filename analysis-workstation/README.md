# WAFC Analysis Workstation v0.1

Analysis Workstation 是整套 WhatsApp Web 快速取证系统中的实验室分析端，与 U 盘中的 Field Collector 是两套独立软件。Field Collector 负责现场采集、签名与封存；Analysis Workstation 负责创建任务、登记信任、接收 Evidence Bag、建立案件索引并浏览证据。

## v0.1 已完成的闭环

1. 初始化工作站配置签名身份。
2. 创建案件。
3. 在案件中创建勘察员、独立证据签名密钥和签名任务。
4. Workstation 发行包内置经过清单校验的 Field Collector、独立校验器和浏览器扩展；在指定 U 盘根目录下只新增 `Field Collector/`，不要求用户另找文件，也不删除或覆盖原有文件。
5. U 盘插回后，可从案件列表使用“自动接收取证 U 盘”。程序对每个 Evidence Bag 先运行独立校验器，再按签名任务自动匹配案件。
6. 已经签发任务的 U 盘可使用“更新取证 U 盘”原位升级。Workstation 会先验证配置签名、任务与现有发行清单，再通过暂存、备份、复核和提交更新 Collector、独立校验器、扩展及 Adapter；勘察员密钥、任务、Evidence Bag、交接摘要和诊断数据均保持不变。中断或校验失败会自动回滚，不允许把其他 Workstation 签发或软件目录已被修改的 U 盘静默覆盖。
6. 原始 Evidence Bag 只读归档到对应案件的 `sources/`；结构化数据幂等导入该案独立的 `case.sqlite`。
7. 通过案件列表、聊天列表、消息视图、中文连续子串检索和完整性页面浏览结果。

现场任务编号可直接按案件习惯填写；Workstation 会在签名和落盘前自动规范为
`assignment-<任务编号>.json`，不要求使用者手工输入 `assignment-` 前缀。

本版本不包含静态导出、MCP、Agent、报告生成、OCR/ASR 或 llama.cpp。这些模块以后只依赖稳定的 `EvidenceRepository`，不会直接读取或修改原始 Evidence Bag。

## 工程结构

```text
analysis-workstation/
├─ apps/desktop/                    Electron + React + TypeScript
├─ packages/domain/                 语言内领域类型与运行时校验
├─ packages/evidence-repository/    稳定只读 Repository + SQLite 实现
├─ packages/workstation-core/       案件、U 盘配置、可信导入与归档
├─ tools/usb-provisioner/           Rust 密钥/配置签名后端
├─ scripts/                         桌面验收与便携发行脚本
└─ design-system/                   UI 设计规范
```

Electron 渲染器启用 `sandbox`、`contextIsolation`，禁用 Node integration、导航、新窗口、WebView 和所有权限请求。Preload 被打成单文件，仅暴露固定 IPC 方法；主进程使用自定义安全协议和 CSP。口令只经有界 IPC 与 Rust RPC 的 stdin 传递，不进入 argv、环境变量、日志或数据库。

新建 Workstation 配置密钥或勘察员证据密钥时，口令至少为 8 个字符，并同时包含 ASCII 大写字母、小写字母、数字和符号。解锁既有密钥时只执行 8 字符与 1024 UTF-8 字节上限检查，以兼容此前已下发的合法 U 盘。强度规则只在 Analysis Workstation 创建新密钥时执行，现场 Collector 不要求勘察员理解或重复配置规则。

## 数据布局

全局数据库只保存案件入口、任务、公钥指纹和接收审计，不保存聊天正文：

```text
workstation-data/
├─ workstation.sqlite
├─ provisioning/
└─ cases/<case-id>/
   ├─ case.sqlite
   ├─ sources/     原始、已验证 Evidence Bag
   ├─ derived/
   ├─ reports/
   └─ audit/
```

`case.sqlite` 使用 SQLite FTS5 trigram 索引支持中文连续子串。语义向量不是 v0.1 的证据事实源。

## 开发与验证

环境：Windows 11、Node.js 22.12+、pnpm 11.16、Rust 1.89+、Visual Studio C++ Build Tools。

```powershell
cd analysis-workstation
pnpm install --frozen-lockfile
pnpm check
pnpm start
```

`pnpm check` 会执行 TypeScript 类型检查、领域/Repository/导入纵向测试、Rust release 构建和 Electron 三部分构建。独立校验器来自仓库 `tools/verify-cli`，Field Collector 发行物来自仓库 `field-collector/out`。

桌面视觉回归使用合成 Evidence Bag，产物写入已忽略的 `.e2e-artifacts/`：

```powershell
node scripts/electron-cdp-smoke.mjs --port=9333 --mode=onboarding
node scripts/electron-cdp-smoke.mjs --port=9333 --mode=review
```

## Windows 便携发行

```powershell
pnpm package:portable
```

当前修订版输出为 `out/wafc-analysis-workstation-v0.1.8-windows-x64/` 及同名 ZIP。公开发布只有在源码树干净、HEAD 精确带 `analysis-workstation-v0.1.8` 标签，且内置 Field Collector 自身为 publishable 时才会在清单中标记 `publishable: true`；开发构建仍可运行，但不得冒充正式发行。

便携包中的下发载荷位于 `resources/field-collector-portable/`，包含 `field-collector.exe`、`waeb-verify.exe`、`extension/` 和发行清单。用户只需运行 Workstation，在案件中点击“生成完整取证 U 盘”；程序会校验内置载荷并复制到 U 盘的 `Field Collector/`，同时签发配置、勘察员密钥和任务。

更新已有 U 盘时，应先关闭该 U 盘中的 Field Collector，再在案件列表点击“更新取证 U 盘”。界面只要求选择 U 盘并确认关闭程序，不要求勘察员选择文件或理解清单。更新记录会尽力写入 `diagnostics/software-updates/`；配置签名、任务有效期和 Evidence Bag 内容不会因软件更新而重签或改写。

## 取证边界

- 只接受目录式 WA Evidence Bag v1；解包 ZIP 不属于 v0.1 导入器职责。
- 未登记签名者、数学签名无效、任何字节篡改、任务/案件/勘察员/有效期不匹配均拒绝归档。
- “已验证”表示包内清单、签名、Schema 和跨文件语义通过，且签名公钥与工作站登记一致；不表示 WhatsApp 服务端账号级绝对全量或司法认证。
- 原始 Evidence Bag 永不由分析端修改。SQLite、FTS5、缩略图和后续 Agent 结果均是可重建派生数据。
- 每个浏览器 Profile 与 WhatsApp 账号必须由 Field Collector 分别生成 Evidence Bag，再由工作站归入同一案件。

完整验收证据见 [docs/v0.1-acceptance.md](docs/v0.1-acceptance.md)。
