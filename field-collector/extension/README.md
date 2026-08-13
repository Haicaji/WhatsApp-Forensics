# WAFC 只读取证扩展

这是 Field Collector 的浏览器连接器，不是独立取证工具。它只能由操作者在当前
`https://web.whatsapp.com/` 标签页点击启动，并使用 Collector 显示的一次性配对码连接
`127.0.0.1:17653`。

扩展只申请 `activeTab` 与 `debugger`：前者把授权限定为用户点击时的当前标签页，后者把现有
Collector 所需的固定 `Runtime`/`Page` 命令转发到该标签页。扩展和 Rust 网关都拒绝 `Network`、
`Storage`、`DOM`、`Input`、任意 JavaScript、任意 URL 和任意文件访问。

扩展本身不决定采集范围。它只接受 Workstation 已签名任务所对应的固定命令：快速被动快照，
或综合只读采集。综合模式可能通过 WhatsApp 自身 Store loader/媒体读取器产生网络同步和缓存
变化；两种模式都不点击聊天、不发送消息、不建群，也不修改联系人、群组、频道或社群。

`src/` 是稳定外壳源码，其中 `src/modules/protocol.js`、`adapter-loader.js` 和
`command-policy.js` 分别负责协议常量、版本化 Adapter 加载和固定命令策略；主 service worker
只保留会话、转发与生命周期编排。`dist/` 由 `scripts/Build-Extension.ps1` 按固定顺序机械拼成
浏览器可加载的单一 worker，并加入当前版本化 Adapter 与 `adapter-manifest.json`。现场只加载
发行包中的 `extension/`，不要直接加载 `src/`。
Collector 会逐字节核对外壳、popup、Adapter 和清单；任一文件变化都会在连接前失败关闭。
外壳版本、Adapter 摘要、页面桥协议和控制器版本还会绑定到固定命令；浏览器仍在运行旧扩展时，
Collector 会在读取聊天前停止并提示重新加载本次 U 盘中的 `extension/`，不会继续猜测兼容。
签名任务中的媒体策略、恢复检查点和所有嵌套字段只在可信扩展 Realm 中完成一次严格校验；页面
控制器仅再次绑定协议、控制器版本和固定顶层命令形状。这样既不放宽 Collector 到扩展的命令
白名单，也避免 WhatsApp 的不可信 MAIN World 对同一合法参数重复校验并产生误拒绝。
Collector 与扩展每 15 秒交换一次无内容心跳，连续两个心跳未响应才判定通道中断，避免把一次
短暂调度延迟误报为断线；心跳不包含配对码、页面数据或账号标识。媒体下载由 Adapter 后台任务
执行，每次桥调用仍应快速返回进度，因此心跳/短通信截止时间不承担媒体下载计时。popup 每
500 毫秒读取后台真实状态，通道关闭后不得继续显示过期的“已连接”。

扩展 service worker 被浏览器回收或本机通道中断时，不自行保存证据状态，也不猜测是否已经写盘。
勘察员重新点击扩展完成一次性配对后，由 Rust Collector 从口令加密检查点恢复，并重新核对同一
任务、Profile、WhatsApp 页面来源和 Adapter 媒体计划；通过前不会续写旧 staging。扩展只提供
新的短生命周期转发会话，不能绕过 Collector 的恢复校验。

加载未打包扩展会改变原 Profile 的扩展配置，WhatsApp 页面也可能自行同步或更新缓存。因此
Field Collector 必须记录这一影响，不能声称绝对无痕。采集完成后是否移除扩展由现场程序给出
明确提示并由操作者决定，程序不会偷偷修改浏览器配置。
