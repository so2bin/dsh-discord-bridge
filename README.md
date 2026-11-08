# dsh-discord-bridge

> **English summary**: A Cordis/DSH host plugin that bridges a
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) session
> to a Discord text channel. Assistant replies and turn outcomes are pushed to
> Discord; messages typed in the channel become real user prompts on the same
> session. Inbound PNG/JPEG/WebP/GIF images are admitted as DSH attachments.
> Not affiliated with DeepSeek or Discord.

把 DeepSeek Harness（DSH）会话接到 Discord：**按需**给某个会话开一个专属频道，手机上就能看它的实时进度、下指令、开新会话。

- **同步是开关，不是默认**：会话默认不推任何东西；`!sync` 才给它建专属频道并开始同步，`!unsync` 关掉。
- **往外推**：助手回复、每一轮的结束（✅/⏹/❌），都从 `session/event` 里取，不做二次加工；工具调用默认不推（`pushTools: false`）。
- **往里收**：频道里发的文本会变成那个会话真实的一条 user message（`agent.followup()`），和你在界面里打字完全等价。
- **PC 端发起的对话一样推**：推送绑定的是会话 id，和你在哪个窗口打字无关。
- **删频道 ≠ 删会话**：频道被删只会解除绑定；要归档会话必须显式发 `!archive`。
- 会话日志仍是唯一事实来源：插件不新增事件类型，也不落自己的对话状态。

## 安装

要求：Node.js **22.12+**，已有一个可用的 DSH profile。

### 从 GitHub 安装

```bash
dsh plugin --profile <profile> add github:so2bin/dsh-discord-bridge
```

### 本地开发

```bash
git clone https://github.com/so2bin/dsh-discord-bridge.git
cd dsh-discord-bridge
npm install
npm test
dsh plugin --profile <profile> add /absolute/path/to/dsh-discord-bridge
```

安装后重启该 profile，或让 DSH 热重载插件。插件运行在 DSH Host 进程里，不需要单独的 bot 进程。

## 配置

在 profile 的 `cordis.patch.yml` 里增加/覆盖 `discord-bridge` 配置行：

```yaml
- id: discord-bridge
  config:
    botToken: ''                 # 或使用 DISCORD_BOT_TOKEN 环境变量
    channelId: ''                # 绑定频道 / 上线问候语频道
    proxy: ''                    # 或使用 DISCORD_PROXY
    sessionId: ''
    newSessionCwd: ''
    dedicatedChannels: true
    autoRename: true
    guildId: ''
    allowUserIds: []
    allowChannelIds: []
    pushAssistant: true
    pushTools: false
    pushTurnEnd: true
    pushTyping: true
    replyToPrompt: true
    storeFile: ''
```

**不要把真实 token 写进公开仓库。** 推荐只写空 `botToken`，用环境变量注入：

```bash
export DISCORD_BOT_TOKEN='...'
export DISCORD_PROXY='http://127.0.0.1:7890'
```

| 字段 | 说明 |
|---|---|
| `botToken` | Discord Bot Token。**必需**（也可用 `DISCORD_BOT_TOKEN`） |
| `dedicatedChannels` | 允许 `!sync` 建专属频道（需要 bot 有「管理频道」权限） |
| `guildId` | 建频道所在的服务器；留空则取网关里第一个服务器 |
| `channelCategoryId` | 新频道放进哪个分类（可选） |
| `channelNamePrefix` | 频道名前缀，默认空 |
| `autoRename` | 会话标题出来时自动改一次频道名 |
| `channelId` | 上线问候语发到哪个频道 |
| `proxy` | 访问 Discord 的代理，例如 `http://127.0.0.1:7890`（也可用 `DISCORD_PROXY`） |
| `newSessionCwd` | `!new` 建会话的工作目录 |
| `allowUserIds` / `allowChannelIds` | 白名单；空 = 不限制 |
| `pushAssistant` / `pushTools` / `pushTurnEnd` / `pushTyping` | 推送开关 |
| `storeFile` | 绑定表位置，默认 `$DSH_HOME/plugins/dsh-discord-bridge.json` |

## Discord 侧准备

1. https://discord.com/developers/applications → New Application → Bot → Reset Token。
2. **Privileged Gateway Intents → 打开 `MESSAGE CONTENT INTENT`**（否则收到的消息内容为空）。
3. OAuth2 URL Generator：scopes 勾 `bot`，权限勾 `Send Messages` / `Read Message History` / `View Channels` 把 bot 拉进服务器。
4. 服务器设置 → 角色 → 给 bot 的角色加上 **管理频道**（`!sync` 建频道用）。
5. 频道 ID 可以让 bot 自己报：`!here`。

## 同步开关

| 动作 | 效果 |
|---|---|
| `!sync [序号\|id前缀]` | 给该会话建专属频道（名字取会话标题，topic 记 `dsh:<sessionId>`）并开启同步；不带参数 = 当前频道绑定的会话 |
| `!unsync` | 关闭本频道同步；如果这是插件自动建的专属频道，会把它一并删掉 |
| 在 Discord 里直接删频道 | 只解除绑定，会话完全不受影响 |
| `!archive` | 显式归档本频道绑定的会话（DSH 的"删除会话"就是归档） |

专属频道会在标题生成后自动改名一次（`autoRename`）。

## 命令

| 输入 | 作用 |
|---|---|
| 任意文本 | 作为新指令交给本频道绑定的会话 |
| `!status` | 会话看板（标题 + 工作区 + 状态 + id，附一键绑定按钮） |
| `!use 2` / `!use <id 前缀>` | 把本频道绑到那个会话（多会话手动切换时用） |
| `!sync` / `!unsync` | 开 / 关专属频道同步 |
| `!new [首条指令]` | 新建会话并绑定本频道 |
| `!archive` | 归档本频道绑定的会话 |
| `!unbind` / `!id` / `!here` / `!help` | 解绑 / 当前绑定 / 频道 id / 帮助 |

## 入站图片

Discord 消息里的 **PNG / JPEG / WebP / GIF** 会经配置的代理下载，按 magic bytes 校验格式，再通过 DSH 的 `ctx.attachments.saveImage` 写成 durable image reference，作为真正的 `image` 消息块交给绑定会话。纯图片消息（没有文字）也会被转发，不再被丢弃。

- 单条数量/大小沿用 DSH 的 attachment 限制；超限、格式不支持或下载失败会跳过，并在频道里提示「图片没有传进来」。
- 其他附件（PDF / zip / 视频等）暂不转发。
- 模型能不能"看懂"图片取决于当前会话模型是否支持视觉；纯文本模型只会拿到 DSH 生成的图片占位文本/路径，需要视觉模型或读图工具才能理解画面内容。

## 安全

- **Bot token 等价于密码**。不要提交到仓库、截图或发到聊天里；泄露后立刻在 Discord Developer Portal 重置。
- 优先使用 `DISCORD_BOT_TOKEN` 环境变量，而不是把 token 写进 profile 文件。
- `allowUserIds` / `allowChannelIds` 为空表示**服务器内不限制**。多人服务器建议填白名单。
- 插件运行在 DSH Host 进程里，拥有 DSH 的工具与会话权限。建议使用专用 Discord 服务器/专用 bot，不要把它当公网多租户服务。
- 安全问题请通过 GitHub 的 **Security → Report a vulnerability** 私下报告，不要公开 issue。

## 已知限制

- 审批卡片（approval）与提问问卷（user questions）目前**不会**转发到 Discord。
- 工具调用默认不推送；需要时把 `pushTools` 打开。
- 非图片附件暂不转发。
- 入站图片能否被模型理解，取决于当前会话模型是否支持视觉。

## 开发

```bash
npm install
npm test
```

项目结构：

```text
dsh-discord-bridge/
├── index.js             # Cordis 插件入口：会话绑定、命令、入站/出站
├── discord.js           # 轻量 Discord REST + Gateway 客户端
├── cordis.patch.yml     # bundle 默认挂载与空配置
├── locale/              # en / zh 文案
├── test/                # node:test 单元测试
├── icon.svg
├── README.md
├── SECURITY.md
└── LICENSE
```

## License

[MIT](./LICENSE) © 2026 so2bin
