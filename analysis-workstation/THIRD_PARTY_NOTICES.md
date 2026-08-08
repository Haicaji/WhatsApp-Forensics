# Third-party notices

WAFC Analysis Workstation 新代码采用 `AGPL-3.0-only`。发行和再分发时还应遵守下列直接依赖及其传递依赖的许可证；锁定版本以 `pnpm-lock.yaml` 和两个 Cargo.lock 为准。

- Electron 43.3.0 — MIT；发行运行时同时携带 Chromium 与 Node.js 的许可证文件。
- React / React DOM 19.2.8 — MIT。
- Lucide React 1.30.0 — ISC。
- Zod 4.4.3 — MIT。
- Vite 8.2.1、TypeScript 7.0.2、pnpm 11.16.0 — 构建期工具，许可证见各自发布包。
- Rust USB Provisioner 的 Argon2、XChaCha20-Poly1305、Ed25519、serde 等依赖 — 许可证见 `tools/usb-provisioner/Cargo.lock` 对应源码包。
- 独立 WA Evidence Bag 校验器及 Field Collector 携带各自的 LICENSE、NOTICES、SBOM 和发行清单；Analysis Workstation 不改变其许可证声明。

模型权重不属于 v0.1 发行物。未来接入本地或云端模型时必须单独审核模型权重、推理运行时和服务条款，不能仅依据本项目的 AGPL 许可证推定可分发。
