# AnalysisWorkstation

WAFC 的便携案件管理、Field Collector 任务下发和聊天结果预览桌面端。

## 本阶段边界

- 直接进入案件管理，不包含登录、人员认证、签名或完整性结论。
- 支持 Field Collector 独立模式 v5 和便携任务模式 v6 结果。
- 导入只执行结构校验、安全复制和派生索引。导入成功不代表证据真实性或完整性已经验证。
- 运行数据固定写入程序同目录的 `AnalysisWorkstationData`。开发时写入本工程同名目录。

## 开发

```powershell
pnpm install
pnpm check
pnpm dev
```

Windows x64 便携构建使用 `pnpm package:portable`。构建会先编译 FieldCollector 和扩展，再把固定载荷放入 Workstation 资源。
