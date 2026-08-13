# Windows 便携发行说明

Field Collector 与 Analysis Workstation 是两套独立软件。本说明只构建现场 U 盘使用的
`field-collector.exe`（正式发行只开放原生中文 GUI）、随包只读取证扩展 `extension/`，以及独立
校验器 `waeb-verify.exe`。发行包不包含分析端、Node.js、Python、Electron、浏览器 Profile、测试
私钥、勘察员配置、案件任务或调试产物。

软件发行 ZIP 不是可直接出现场的完整 U 盘。Analysis Workstation 必须把两个已核验二进制、
原样扩展目录与 `wafc-portable.json`、签名配置、加密勘察员私钥、签名任务及固定 evidence/handoff 目录
组装成现场介质。缺少或篡改这些配置时，Collector 必须拒绝启动正式采集。

## 构建边界

发行脚本分别进入两个独立 Cargo workspace，并各自执行一次：

```text
field-collector/  -> cargo build --release --locked
tools/verify-cli/ -> cargo build --release --locked
```

这两个 workspace 必须各自保留并冻结 `Cargo.lock`。校验器不链接采集端 writer、页面
注入器或采集状态机，避免“自己生成、自己证明”的循环依赖。

## 构建条件

- Windows x86-64；
- Rust 1.89 或项目冻结的更高兼容版本，host 必须为
  `x86_64-pc-windows-msvc`；
- Visual Studio Build Tools/MSVC x64 linker；脚本优先使用当前 PATH，找不到 `dumpbin.exe`
  时会通过官方 `vswhere.exe` 自动定位最新 x64 工具集，不要求手工切换 Developer Shell；
- Git，用于记录 commit、工作树状态和确定性源码树摘要；
- Windows PowerShell 5.1 或 PowerShell 7；
- 与锁文件匹配的 Cargo crates（可来自本地缓存或构建时下载）。

正式发行应从干净的、HEAD 已有精确 tag 的源码树构建。脚本默认同时拒绝脏工作树与
未标记的 HEAD，并将经过保守 ASCII 校验、数量有界且按 ordinal 排序的 HEAD tag 列表
写入来源记录。先进行不构建
二进制、不写发行输出的检查；该检查会报告 commit、dirty 状态和源码树摘要：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\field-collector\scripts\Build-PortableRelease.ps1 -PlanOnly
```

构建时应显式使用该源码提交的 Unix 时间作为 `SOURCE_DATE_EPOCH`。例如：

```powershell
$releaseEpoch = [long](git log -1 --format=%ct)
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\field-collector\scripts\Build-PortableRelease.ps1 `
  -SourceDateEpoch $releaseEpoch
```

没有传入时，脚本使用 ZIP 可表示的最早时间 `315532800`（1980-01-01T00:00:00Z）。
固定默认值便于本地复现，但正式制品应记录发布源码提交的 epoch。

仅为本地集成测试，可显式传入 `-AllowDirty`。无论工作树是否恰好 clean，这类制品都记录
`publishable=false`；dirty 或 untagged 状态、commit、精确 HEAD tag 列表和实际源码树
SHA-256 也会写入 `SOURCE.md`/`SOURCE_PROVENANCE.json`。此开关不得用于正式版本。

## 输出

所有输出均写入已忽略的 `field-collector/out/`：

```text
out/
├─ whatsapp-field-collector-v<version>-windows-x86_64/
│  ├─ field-collector.exe
│  ├─ waeb-verify.exe
│  ├─ extension/
│  │  ├─ manifest.json
│  │  ├─ popup.html
│  │  ├─ popup.js
│  │  ├─ service-worker.js
│  │  ├─ styles.css
│  │  └─ adapter/
│  │     ├─ adapter-manifest.json
│  │     └─ collector.iife.js
│  ├─ LICENSE
│  ├─ README.md
│  ├─ SBOM.cdx.json
│  ├─ SOURCE.md
│  ├─ SOURCE_PROVENANCE.json
│  ├─ THIRD_PARTY_LICENSES.txt
│  ├─ THIRD_PARTY_NOTICES.md
│  └─ release-manifest.json
└─ whatsapp-field-collector-v<version>-windows-x86_64.zip
```

这是 17 个文件、两个固定子目录的严格白名单，不复制 `target/` 目录、PDB/ILK/LIB、DLL、测试密钥、Node/Python
脚本或任何用户数据。脚本在复制前检查两个二进制的 Windows PE `MZ` 头，并用 `dumpbin`
拒绝 VCRUNTIME、MSVCP、MSVCR、UCRTBASE 和 `api-ms-win-crt-*` 动态导入；发行构建通过
`+crt-static` 静态链接 MSVC CRT。压缩前再次核对全部文件名，出现额外文件时立即失败。
最终 ZIP 必须严格小于 50 MiB（52,428,800 字节）。

`release-manifest.json` 对自身以外的 16 个有效载荷文件记录字节数和 SHA-256，并记录扩展及
Adapter 版本/摘要、两个
`Cargo.lock` 的 SHA-256、组件版本、PE 导入、静态 CRT 策略、Rust 版本、目标平台、归档
epoch、源码仓库、commit、HEAD tags、dirty/publishable 状态和源码树 SHA-256。清单不对自身递归哈希，这是其
`manifestScope` 明确声明的边界。

`SOURCE_PROVENANCE.json` 列出构建相关实际源码文件的相对路径、长度和 SHA-256，并以
`WAFC-SOURCE-TREE-v1` 域分隔规则生成根摘要。范围仅包括 `LICENSE`、`field-collector/`、
`tools/verify-cli/`、协议 README 和生产二进制实际嵌入的可信 `schemas/`。它明确排除 `tmp/`、
规范 examples/test-vectors/开发工具、证据/样本/用户数据、用户删除的无关旧项目及
git-ignored 构建输出，因此不会把 test-only 私钥向量或示例 Evidence Bag 写进来源清单。
构建后及制品晋升前，脚本都会同时复核
源码树摘要和 commit、dirty、HEAD tags，任一状态变化都失败关闭。

`SBOM.cdx.json` 是 CycloneDX 1.5 JSON，由两个锁定 workspace 的 `cargo metadata`
依赖图确定性生成，只包含两个发行二进制可达的非 dev Cargo 组件与依赖边。旧式 Cargo
`MIT/Apache-2.0` 等表达式会严格规范化为 SPDX `OR`；缺失、未知、copyleft、
source-available、未审核 exception 或不在 allowlist 中的许可证会阻断发行。
`THIRD_PARTY_LICENSES.txt` 与同一图自动对账，并收录每个第三方 crate 的完整根级或声明
许可证、copyright 和 notice 文件；缺失、非 UTF-8、reparse 或异常大文件会失败关闭。

## 可复现性约束

脚本采取以下措施：

- 强制 `cargo build --release --locked`，防止隐式更新依赖；
- 固定 `SOURCE_DATE_EPOCH`，禁用 incremental，并清除外部 Cargo target 覆盖；
- 为 MSVC linker 设置 `/Brepro`，并使用 `+crt-static`；
- 将随包文本与 JSON 统一为 UTF-8（无 BOM、LF）；
- 按 ordinal 文件名顺序写 ZIP，并把所有条目设为同一 UTC 时间；
- 在发布前从同一目录生成第二个 ZIP，要求两个归档 SHA-256 完全一致。
- 所有发布写入和递归删除路径逐级拒绝 symlink/junction/reparse point，只允许处理
  `field-collector/out/` 的精确子项。

“可复现”要求源码、两个锁文件、Rust/MSVC/.NET 压缩实现、构建目标和 epoch 均一致。
脚本的双 ZIP 检查证明打包过程确定，不替代跨机器 reproducible-build 对比。正式版本应在
第二台干净 VM 重建，并比较最终 ZIP SHA-256；不同工具链的差异应视为待调查问题，不能
直接覆盖发布物。

脚本会暂时规范化相关 Cargo/Rust 环境变量，并在成功或失败后恢复调用者环境。它只清理
`field-collector/out/` 下由当前版本精确命名的旧制品和临时 staging 目录，不清理源码
workspace 的 `target/`。

## 发布前验收

1. 从干净 tag 构建两次并比较 ZIP SHA-256。
2. 在未安装 Node.js、Python、Electron、Rust、Visual Studio 和 VC++ Redistributable
   的干净 Windows 11 VM 中解压运行两个 EXE；验证 GUI 的 OpenGL 上下文、中文系统字体
   回退、无参数双击启动和 `--help`；正式版不得接受 endpoint/端口/target/Profile 路径参数。
3. 使用 PowerShell 重算目录内 16 个有效载荷文件的 SHA-256，并与
   `release-manifest.json` 逐项比较。
4. 用 `waeb-verify.exe` 校验已知有效、单字节篡改和错误签名 Evidence Bag。
5. 检查 ZIP 严格小于 50 MiB，且列表只有上述 17 个文件和两个目录，不含 PDB、私钥、测试 fixture
   或采集所得数据。
6. 在普通用户、无管理员权限环境完成 Chrome/Edge 原 Profile 发现、正常打开、人工加载扩展、
   当前 WhatsApp 标签页一次性配对、未知版本失败关闭和独立校验流程。
7. 核对 `SOURCE_PROVENANCE.json` 的 commit、精确 HEAD tag、`dirty=false`、
   `publishable=true` 和源码树摘要；发布对应 tag 的
   完整源码、两个 `Cargo.lock`、AGPLv3 文本及自动生成的第三方许可证包。

可用下面的只读命令快速查看 ZIP 内容；它不会解压文件：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead(
  '.\field-collector\out\whatsapp-field-collector-v0.2.6-windows-x86_64.zip'
)
try { $zip.Entries | Select-Object FullName, Length } finally { $zip.Dispose() }
```

## 现场介质注意事项

发行 ZIP 是软件制品，不是证据包，也不是 Workstation 下发的现场介质。Field Collector 不再
提供首次密钥生成或任意工作目录选择：Analysis Workstation 为每名勘察员生成独立密钥，将
私钥以 Argon2id + XChaCha20-Poly1305 加密后写入固定 `config/operator-key.enc`，并用
Workstation 配置密钥签署清单和任务。Workstation 默认只登记勘察员公钥；是否托管私钥由独立
制度决定。

每次现场工作前应核对软件发行清单，再由 Workstation 验证并下发完整 U 盘目录。现场结束后，
Collector 自动把 staging、正式 Evidence Bag 和 handoff 分别写入固定相对目录；不得把证据重新
塞回软件发行 ZIP。Workstation 接收 Evidence Bag 后，使用已登记的勘察员公钥进行可信校验。
