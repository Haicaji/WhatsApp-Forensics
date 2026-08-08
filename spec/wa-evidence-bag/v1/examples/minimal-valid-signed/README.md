# Minimal valid signed fixture

本目录由 `tools/build-minimal-example.mjs` 生成。Evidence Bag 内只包含固定的合成账号、
联系人、会话、系统消息、文本消息、一像素 PNG 和完整的封印材料。

默认验证状态应为 `valid_untrusted`，因为包内公钥只能证明数学一致性。显式把
`expected-verify.json` 中的测试指纹加入 trust policy 后，状态才是 `valid_trusted`。

禁止把此 fixture 的测试私钥用于任何生产采集。

