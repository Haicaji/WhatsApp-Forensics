# ShowMesssage

一个纯本地、只读的 ZAPiXWEB WhatsApp ZIP 聊天查看器. 

它只静态展示提取包中的数据, 并非原始 WhatsApp 网页镜像. 

## 使用方式

### 直接双击

双击 `frontend/index.html`, 然后选择或拖入完整的 ZAPiXWEB `.zip` 导出包. 所有解析都在浏览器内完成, 文件不会被上传. 

### 本地服务

在本目录运行：

```powershell
python serve.py
```

服务只监听 `127.0.0.1`, 静态文件根目录限定为 `ShowMesssage/frontend`, 不会暴露测试、启动脚本或项目说明. 浏览器打开后保持空白, 选择或拖入 ZIP 才会载入；更换 ZIP 时会立即清除上一份记录. 

不希望自动打开浏览器时使用：

```powershell
python serve.py --no-open
```

## 功能

- 会话列表、搜索、筛选、切换与消息滚动
- 大型会话按窗口渲染；全局和会话内搜索显示完整命中数, 并可分页载入全部结果
- 全局搜索对话与消息；会话内搜索、WhatsApp 风格日历跳转, 以及滚动时出现、静止后淡出的日期提示. 正文日期进入顶部时浮动日期会自动避让；所有可见日期统一显示完整年月日, 不使用“今天/昨天”
- 日历中的历史日期均可点击, 无消息日期会跳到最近消息, 未来日期禁用
- 默认按东八区（`Asia/Shanghai`）显示时间；可在顶部“设置”中切换 IANA 时区, 正文和浮动日期会直接标注对应的 `UTC±HH:MM`
- 当前用户姓名与手机号（新导出字段优先、旧包可从标准 ZIP 文件名恢复）；联系人手机号优先使用新导出字段, 旧包仅在 LID 与号码联系人可唯一配对时恢复
- 联系人详情, 以及当前聊天右侧的影音内容、文档和链接面板；面板底部可进入全部聊天媒体库
- 文本、安全的 `http/https` 链接、图片、视频、语音、文档、投票和活动
- 聊天气泡、联系人预览和媒体库都会直接显示经过校验的图片/视频缩略图；视频缩略图包含播放标记和时长
- 图片/视频查看器支持上一项、下一项按钮与左右方向键, 显示当前序号, 并始终下载当前展示项目的原文件
- 顶部“设置”中可切换深浅主题与显示时区；选择会保存在 `localStorage`
- 桌面三栏布局与窄屏单栏切换
- 通过“打开 ZIP”旁的文件信息按钮查看来源、大小、账户标识和完整 SHA-512
- 读取 `extraction_manifest.json`, 在导入提示、会话列表和文件信息中标明完整、未验证、不完整或数量不一致
- 在“ZIP 文件信息 → 历史同步诊断”中展示新版 Hook 的构建版本、Store 加载方式、轮次、返回/新增数量、空批次、停滞、回退原因和界面打开阶段；诊断对象只按白名单归一化, 不展示观察到的聊天 ID、标题或原始 DOM/Store 对象
- 每次更换 ZIP 时释放上一个导出包产生的全部 Blob URL

页面不连接 WhatsApp, 不修改 ZIP, 也不包含发送、编辑、远程同步或导出功能. 未手动导入 ZIP 时内容区保持空白. 

旧版导出包没有 `extraction_manifest.json`, 查看器只能展示其中已有的数据, 不能据此证明聊天历史完整；这类包会显示“未包含完整性清单”. 

## 测试

`tests/` 只存放 Node.js 回归测试, 不会被本地静态服务发布, 也不是前端运行依赖：

- `datetime.test.cjs`：验证默认时区、跨时区日期分组、夏令时偏移、日期标签和闰日处理. 
- `parser.test.cjs`：验证 ZAPiXWEB ZIP 解析、完整性清单、分片合并去重、账号和联系人字段归一化、附件匹配、经过文件头校验的内嵌缩略图、SHA-512、聊天排序以及损坏包错误处理. 
- `app-behavior.test.cjs`：验证显示层搜索、URL、完整性提示、缩略图来源、媒体序列和导航边界、完整年月日, 以及 ZIP/头像/媒体异步竞态保护. 

需要本机 Node.js. 测试不启动浏览器：

```powershell
node --test tests/app-behavior.test.cjs tests/datetime.test.cjs tests/parser.test.cjs
```

## 目录结构

```text
ShowMesssage/
├─ frontend/          # 可直接发布或双击运行的全部前端文件
│  ├─ index.html
│  ├─ app.js
│  ├─ parser.js
│  ├─ datetime.js
│  ├─ styles.css
│  ├─ assets/
│  └─ vendor/
├─ tests/             # Node.js 回归测试, 不随前端发布
├─ serve.py           # 仅发布 frontend/ 的本地服务器
└─ README.md
```

第三方组件许可证位于 `frontend/vendor/JSZIP_LICENSE.md` 和 `frontend/assets/ROBOTO_LICENSE.txt`. 
