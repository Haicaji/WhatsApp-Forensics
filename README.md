# WhatsApp Forensics

本仓库包含两个本地取证组件：

- `ZAPiXWEB/`：在已登录的 WhatsApp Web 页面中运行的只读提取 hook。
- `ShowMesssage/`：离线打开 ZAPiXWEB ZIP 的本地只读查看器。

“提取全部聊天”会优先通过 WhatsApp Web 当前的历史消息加载接口同步未展开、
尚未下载到当前页面的较早消息；接口不可用时才回退到自动打开聊天并上翻。
每个聊天的加载方式、轮次、完整性和失败诊断都会写入导出清单。
新导出还会把 Hook 构建号写入 `extraction_manifest.json` 和
`export_metadata.json`；查看器可在“ZIP 文件信息 → 历史同步诊断”中核对版本与加载结果。

## 测试

需要 Node.js 20 或更高版本。测试不需要联网：

```powershell
npm test
npm run test:coverage
```

也可以分别运行：

```powershell
node --test ZAPiXWEB/tests/hook-regression.test.cjs
node --test ShowMesssage/tests/app-behavior.test.cjs ShowMesssage/tests/datetime.test.cjs ShowMesssage/tests/parser.test.cjs
```

测试夹具和回归测试属于源码的一部分；`tmp/` 中的真实导出包仅用于本地验证，不应提交。

详细使用方式见 [ZAPiXWEB/README.md](ZAPiXWEB/README.md) 与 [ShowMesssage/README.md](ShowMesssage/README.md)。
