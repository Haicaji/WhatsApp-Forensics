# WAFC 只读取证扩展

这是 Field Collector 的浏览器连接器，不是独立取证工具。它只能由操作者在当前
`https://web.whatsapp.com/` 标签页点击启动，并使用 Collector 显示的一次性配对码连接
`127.0.0.1:17653`。

扩展只申请 `activeTab` 与 `debugger`：前者把授权限定为用户点击时的当前标签页，后者把现有
Collector 所需的固定 `Runtime`/`Page` 命令转发到该标签页。扩展和 Rust 网关都拒绝 `Network`、
`Storage`、`DOM`、`Input`、任意 JavaScript、任意 URL 和任意文件访问。

`src/` 是稳定外壳源码；`dist/` 由 `scripts/Build-Extension.ps1` 机械生成，并加入当前版本化
Adapter 与 `adapter-manifest.json`。现场只加载发行包中的 `extension/`，不要直接加载 `src/`。

加载未打包扩展会改变原 Profile 的扩展配置，WhatsApp 页面也可能自行同步或更新缓存。因此
Field Collector 必须记录这一影响，不能声称绝对无痕。采集完成后是否移除扩展由现场程序给出
明确提示并由操作者决定，程序不会偷偷修改浏览器配置。
