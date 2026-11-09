# dsh-discord-bridge

[简体中文](./README.md) | [English](./README.en.md)

把 **DeepSeek Harness（DSH）** 的会话接到 Discord：在 Discord 频道里和你的 DSH 会话对话，助手回复和每一轮结果会同步到 Discord；在频道里发消息，就等于给同一个会话下指令。

适合这些场景：

- 人不在电脑前，用手机在 Discord 里继续 DSH 的任务；
- 给每个会话开一个专属频道，随时看它跑到哪一步；
- 从 Discord 直接新建会话、发指令、发图片；
- 电脑端和 Discord 端共用同一个会话，不用复制粘贴上下文。

> 本项目与 DeepSeek、Discord 没有隶属关系。

## 开始前

- 已经安装并能启动 DSH（桌面端或 `dsh web`）；
- 有一个 Discord 服务器，你有创建 Bot、管理频道的权限；
- 如果你的网络需要代理才能访问 Discord，先准备好代理地址。

## 1. 安装插件

```bash
dsh plugin --profile <profile> add github:so2bin/dsh-discord-bridge
```

把 `<profile>` 换成你的 DSH profile：桌面端通常是 `desktop`，`dsh web` 通常是 `web`。

安装完成后重启 DSH，或在 DSH 里重新加载该 profile。

## 2. 创建 Discord Bot

1. 打开 <https://discord.com/developers/applications> → **New Application**。
2. 左侧 **Bot** → **Reset Token**，复制生成的 token（只显示一次，先保存好）。
3. 同一页打开 **Privileged Gateway Intents → MESSAGE CONTENT INTENT**，否则 bot 收不到消息内容。
4. 左侧 **OAuth2 → URL Generator**：
   - Scopes 勾选 `bot`；
   - Bot Permissions 勾选 `View Channels`、`Send Messages`、`Read Message History`、`Embed Links`；
   - 想让 bot 自动建专属频道（`!sync`）时，再勾 `Manage Channels`。
5. 打开生成的邀请链接，把 bot 拉进你的服务器。
6. 在 Discord 设置 → **高级 → 开发者模式** 打开后，右键频道/服务器 → **复制频道 ID / 服务器 ID**，后面配置会用到。

## 3. 配置

编辑你的 profile 配置文件：

```text
~/.dsh/profiles/<profile>/cordis.patch.yml
```

加入或覆盖 `discord-bridge` 这一行：

```yaml
- id: discord-bridge
  config:
    botToken: '你的 Bot Token'
    channelId: '接收上线通知的频道 ID'
    proxy: ''                    # 需要代理时填 http://127.0.0.1:7890
    dedicatedChannels: true      # 允许 !sync 自动建专属频道
    guildId: '你的服务器 ID'      # 可留空；多个服务器时建议填
    relayQuestions: true         # 把提问转发到 Discord
    relayApprovals: true         # 把审批转发到 Discord
```

不想把 token 写进文件时，可以改用环境变量（设置后需要重启 DSH）：

```powershell
$env:DISCORD_BOT_TOKEN = '你的 Bot Token'
$env:DISCORD_PROXY = 'http://127.0.0.1:7890'
```

常用配置：

| 配置 | 作用 |
|---|---|
| `botToken` | Discord Bot Token，必填；也可用 `DISCORD_BOT_TOKEN` |
| `channelId` | 上线通知发到哪个频道；留空则用第一个已绑定频道 |
| `proxy` | 访问 Discord 的代理；也可用 `DISCORD_PROXY` |
| `dedicatedChannels` | 是否允许 `!sync` 自动建专属频道，默认 `false` |
| `guildId` | 建频道所在的服务器；留空取第一个服务器 |
| `allowUserIds` | 允许使用 bot 的 Discord 用户 ID；空 = 不限制 |
| `allowChannelIds` | 允许使用的频道 ID；空 = 不限制 |
| `pushTools` | 是否把工具调用也推到 Discord，默认 `false` |
| `newSessionCwd` | `!new` 新建会话时使用的工作目录 |
| `autoRename` | 会话有标题后自动改专属频道名，默认 `true` |
| `relayQuestions` / `relayApprovals` | 是否把提问 / 审批转发到 Discord，默认 `true` |
| `offerFiles` | 自动识别助手回复里的工作区文件并附「查看」按钮，默认 `true` |

保存后重启 DSH。bot 上线时会在 `channelId` 对应的频道发一条上线消息。

## 4. 开始使用

### 绑定一个已有会话

在 Discord 频道里发：

```text
!status
```

bot 会列出当前 DSH 会话。点击按钮，或按提示发：

```text
!use 2
```

把这个频道绑定到第 2 个会话。之后在这个频道里发的任何文字，都会作为该会话的新指令。

### 从 Discord 新建会话

```text
!new 帮我整理今天的工作记录
```

会新建一个 DSH 会话并自动绑定当前频道。

### 给会话开专属频道

```text
!sync
```

给当前绑定的会话创建一个专属频道，会话的进展会同步到那里。需要配置 `dedicatedChannels: true`，并给 bot `Manage Channels` 权限。

关闭同步：

```text
!unsync
```

### 发图片

直接在 Discord 里发送图片（PNG / JPEG / WebP / GIF），可以只发图，也可以图 + 文字。图片会作为附件传给绑定的 DSH 会话。

模型能不能看懂图片取决于当前会话模型是否支持视觉；纯文本模型只能拿到图片占位信息。

Discord 入站目前只处理图片；PDF / zip / 视频等附件不会自动进入 DSH。需要把远程文件发到手机时，用下面的 `!file`。

## 查看 / 分享生成的文件

在绑定会话的频道里，可以直接把远程机器上生成的文件发到 Discord：

```text
!file color-secrets-class/animation/film/out/v4-paper-voice.mp4
!file color-secrets-class/animation/film/out/compare-v4.png
!show color-secrets-class/README.md
```

- `!file <路径>`：把工作区里的文件上传成 Discord 附件。图片和视频会直接内嵌预览，手机端点开即可在线看，不会先下载到相册；PDF、压缩包等也可以发，但会显示为附件。
- `!show <路径>`：把 Markdown / 文本内容直接发到聊天里，适合看完就关的场景。
- 路径相对当前会话的工作区；不能访问工作区外的文件。
- 当前按 Discord 未加成服务器的 **10 MB** 上传上限处理；超过会提示先压缩或转码。
- Discord 不渲染 Markdown 表格，`!show` 表格会以原始竖线文本显示。

## 自动识别回复里的文件

不用手动记路径：当助手回复里出现工作区内的文件（Markdown 链接、反引号路径或裸路径）时，bridge 会在回复下面自动加一行「查看」按钮。

- 点按钮才会真正上传/展示，**不会**自动把文件刷到频道里；
- 图片、视频 ≤10MB 点击后直接在 Discord 内嵌预览；
- Markdown/文本点击后直接发到聊天里；
- 只识别当前会话工作区内、确实存在、≤10MB 的文件，最多列 10 个；
- 识别错了或觉得吵，可以配置 `offerFiles: false` 关闭，仍可手动 `!file` / `!show`。

## 远程审批与提问

当绑定会话触发 `ask_user_question` 或工具审批时，bridge 会把问题和按钮发到对应 Discord 频道：

- **提问**：点选项按钮，或直接回复序号/文字；多道题会逐条发送。
- **审批**：点「允许」或「拒绝」。
- 回答后 DSH 本地的弹窗会自动关闭，任务继续执行。
- 只对**已绑定频道**生效；没有绑定会话时仍然走 DSH 本地弹窗。
- 不想转发时，把 `relayQuestions` / `relayApprovals` 设为 `false`。

### 常用命令

| 命令 | 作用 |
|---|---|
| `!status` | 查看会话列表并绑定 |
| `!use <序号或 id 前缀>` | 把当前频道绑到指定会话 |
| `!new [首条指令]` | 新建会话并绑定当前频道 |
| `!sync` / `!unsync` | 开 / 关专属频道同步 |
| `!file <路径>` | 上传工作区文件；图片/视频在线预览 |
| `!show <路径>` | 在聊天里查看 Markdown / 文本 |
| `!archive` | 归档当前频道绑定的会话 |
| `!unbind` | 解除当前频道的绑定 |
| `!id` | 查看当前频道绑定的会话 id |
| `!here` | 查看当前频道 id |
| `!help` | 查看帮助 |

## 常见问题

**bot 在线，但发消息没反应**

- 确认已经打开 `MESSAGE CONTENT INTENT`；
- 确认 bot 有 `View Channels`、`Send Messages`、`Read Message History` 权限；
- 如果配置了代理，确认代理可用；
- 如果填了 `allowUserIds` / `allowChannelIds`，确认你的 ID 在白名单里。

**`!status` 有响应，但普通消息不回复**

先发 `!status` 确认频道已经绑定到某个会话；没绑定时可以用 `!use <序号>` 或 `!new`。

**`!sync` 没反应或报权限错误**

- 配置里设置 `dedicatedChannels: true`；
- 给 bot 的服务器角色加上 `Manage Channels`；
- 多服务器时填写 `guildId`。

**图片没有传进来**

- 只支持 PNG / JPEG / WebP / GIF；
- 检查图片大小是否超过 DSH 的附件限制；
- 如果使用代理，确认图片能通过代理下载；
- 纯文本模型可能只能看到图片占位信息，需要视觉模型。

**审批和提问会同步到 Discord 吗？**

会。已绑定频道会自动收到问题/审批按钮；点选或回复文字后，DSH 本地弹窗会关闭并继续。没有绑定会话的交互仍然只在 DSH 本地界面出现。

## 安全建议

- Discord Bot Token 等价于密码，不要提交到公开仓库、截图或发到聊天里；泄露后立刻在 Discord Developer Portal 重置。
- 多人服务器建议配置 `allowUserIds` / `allowChannelIds`，只允许自己使用。
- 插件运行在 DSH 里，拥有 DSH 的工具与会话权限；建议使用专用服务器和专用 bot。

## License

[MIT](./LICENSE) © 2026 so2bin
