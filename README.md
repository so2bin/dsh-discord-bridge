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

### 常用命令

| 命令 | 作用 |
|---|---|
| `!status` | 查看会话列表并绑定 |
| `!use <序号或 id 前缀>` | 把当前频道绑到指定会话 |
| `!new [首条指令]` | 新建会话并绑定当前频道 |
| `!sync` / `!unsync` | 开 / 关专属频道同步 |
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

目前不会。工具审批、`ask_user_question` 这类交互仍然在 DSH 界面里完成。

## 安全建议

- Discord Bot Token 等价于密码，不要提交到公开仓库、截图或发到聊天里；泄露后立刻在 Discord Developer Portal 重置。
- 多人服务器建议配置 `allowUserIds` / `allowChannelIds`，只允许自己使用。
- 插件运行在 DSH 里，拥有 DSH 的工具与会话权限；建议使用专用服务器和专用 bot。

## License

[MIT](./LICENSE) © 2026 so2bin
