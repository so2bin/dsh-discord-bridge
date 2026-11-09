# dsh-discord-bridge

[简体中文](./README.md) | English

Bridge a **DeepSeek Harness (DSH)** session to Discord. Chat with your DSH session from a Discord channel, receive assistant replies and turn results in Discord, and turn messages typed in the channel into real prompts on the same session.

Typical uses:

- Continue a DSH task from your phone while away from the computer;
- Give each session its own Discord channel and follow its progress;
- Start a new DSH session, send instructions, or send images from Discord;
- Share one session between the desktop app and Discord without copying context.

> This project is not affiliated with DeepSeek or Discord.

## Before you start

- DSH is installed and can be started (desktop app or `dsh web`);
- You have a Discord server and permission to create a bot and manage channels;
- If Discord requires a proxy on your network, have the proxy address ready.

## 1. Install the plugin

```bash
dsh plugin --profile <profile> add github:so2bin/dsh-discord-bridge
```

Replace `<profile>` with your DSH profile: usually `desktop` for the desktop app, `web` for `dsh web`.

Restart DSH, or reload that profile, after installation.

## 2. Create a Discord bot

1. Open <https://discord.com/developers/applications> → **New Application**.
2. Open **Bot** → **Reset Token**, then copy the token (it is shown only once).
3. On the same page, enable **Privileged Gateway Intents → MESSAGE CONTENT INTENT**. Without it the bot receives empty message content.
4. Open **OAuth2 → URL Generator**:
   - Scopes: `bot`;
   - Bot Permissions: `View Channels`, `Send Messages`, `Read Message History`, `Embed Links`;
   - Add `Manage Channels` if you want `!sync` to create dedicated channels automatically.
5. Open the generated invite URL and add the bot to your server.
6. In Discord settings → **Advanced → Developer Mode**, then right-click a channel/server → **Copy Channel ID / Server ID**. You will need these below.

## 3. Configure

Edit your profile config file:

```text
~/.dsh/profiles/<profile>/cordis.patch.yml
```

Add or override the `discord-bridge` entry:

```yaml
- id: discord-bridge
  config:
    botToken: 'YOUR_BOT_TOKEN'
    channelId: 'CHANNEL_ID_FOR_ONLINE_NOTICE'
    proxy: ''                    # e.g. http://127.0.0.1:7890 if needed
    dedicatedChannels: true      # allow !sync to create channels
    guildId: 'YOUR_SERVER_ID'    # optional; recommended with multiple servers
    relayQuestions: true         # forward questions to Discord
    relayApprovals: true         # forward approvals to Discord
```

To avoid putting the token in a file, use environment variables instead (restart DSH after setting them):

```powershell
$env:DISCORD_BOT_TOKEN = 'YOUR_BOT_TOKEN'
$env:DISCORD_PROXY = 'http://127.0.0.1:7890'
```

Common options:

| Option | Purpose |
|---|---|
| `botToken` | Discord bot token; required. Can use `DISCORD_BOT_TOKEN` instead |
| `channelId` | Channel for the online notice; defaults to the first bound channel |
| `proxy` | Proxy for Discord access; can use `DISCORD_PROXY` |
| `dedicatedChannels` | Allow `!sync` to create dedicated channels; default `false` |
| `guildId` | Server used for channel creation; defaults to the first server |
| `allowUserIds` | Discord user IDs allowed to use the bot; empty = everyone |
| `allowChannelIds` | Channel IDs allowed to use the bot; empty = every channel |
| `pushTools` | Also push tool calls to Discord; default `false` |
| `newSessionCwd` | Working directory for sessions created with `!new` |
| `autoRename` | Rename a dedicated channel after the session title; default `true` |
| `relayQuestions` / `relayApprovals` | Forward questions / approvals to Discord; default `true` |

Save the file and restart DSH. When the bot connects, it posts an online notice in `channelId`.

## 4. Use it

### Bind an existing session

In a Discord channel, send:

```text
!status
```

The bot lists your DSH sessions. Click a button, or send:

```text
!use 2
```

to bind this channel to session 2. Any text you send in the channel afterwards becomes a new prompt for that session.

### Start a new session from Discord

```text
!new Summarize today's work log
```

This creates a new DSH session and binds it to the current channel.

### Give a session its own channel

```text
!sync
```

Creates a dedicated Discord channel for the bound session and mirrors its progress there. Requires `dedicatedChannels: true` and the bot's `Manage Channels` permission.

Turn it off with:

```text
!unsync
```

### Send images

Send a PNG / JPEG / WebP / GIF directly in Discord, with or without text. The image is forwarded to the bound DSH session as an attachment.

Whether the model can understand the image depends on the model used by that session. Text-only models only receive placeholder information.

Inbound Discord messages currently handle images only; PDF / zip / video attachments are not forwarded into DSH automatically. Use `!file` below to send remote files to your phone.

## View / share generated files

In a channel bound to a session, send files from the remote machine to Discord:

```text
!file color-secrets-class/animation/film/out/v4-paper-voice.mp4
!file color-secrets-class/animation/film/out/compare-v4.png
!show color-secrets-class/README.md
```

- `!file <path>` uploads a workspace file as a Discord attachment. Images and videos are previewed inline, so you can watch them on your phone without saving them to the gallery first. PDFs, archives, and other files are sent as attachments too.
- `!show <path>` posts Markdown / text content directly into the chat, which is convenient for read-and-close.
- Paths are relative to the bound session workspace; files outside the workspace are rejected.
- The current limit follows Discord's **10 MB** upload cap for unboosted servers; larger files are refused with a hint to compress or transcode.
- Discord does not render Markdown tables; `!show` displays them as raw pipe-separated text.

## Remote questions and approvals

When a bound session calls `ask_user_question` or requests tool approval, the bridge sends the question and buttons to the corresponding Discord channel:

- **Questions**: click an option, or reply with its number/text; multiple questions are sent one at a time.
- **Approvals**: click **Allow** or **Deny**.
- After answering, the local DSH popup closes and the task continues.
- Only **bound channels** receive these prompts; unbound sessions still use the local DSH UI.
- Set `relayQuestions` / `relayApprovals` to `false` to opt out.

### Commands

| Command | Purpose |
|---|---|
| `!status` | List sessions and bind one |
| `!use <index or id prefix>` | Bind this channel to a session |
| `!new [first prompt]` | Create a session and bind this channel |
| `!sync` / `!unsync` | Enable / disable a dedicated channel |
| `!file <path>` | Upload a workspace file; images/videos preview inline |
| `!show <path>` | View Markdown / text in chat |
| `!archive` | Archive the session bound to this channel |
| `!unbind` | Unbind this channel |
| `!id` | Show the bound session id |
| `!here` | Show this channel id |
| `!help` | Show help |

## Troubleshooting

**The bot is online but does not answer**

- Make sure `MESSAGE CONTENT INTENT` is enabled;
- Make sure the bot has `View Channels`, `Send Messages`, and `Read Message History`;
- If a proxy is configured, verify it works;
- If `allowUserIds` / `allowChannelIds` are set, make sure your ID is included.

**`!status` works but normal messages do nothing**

Send `!status` and confirm the channel is bound to a session. If not, use `!use <index>` or `!new`.

**`!sync` does nothing or reports a permission error**

- Set `dedicatedChannels: true`;
- Give the bot's server role the `Manage Channels` permission;
- Set `guildId` when the bot is in multiple servers.

**Images are not forwarded**

- Only PNG / JPEG / WebP / GIF are supported;
- Check the image size against DSH's attachment limits;
- If a proxy is used, make sure the image can be downloaded through it;
- Text-only models may only see placeholder information; use a vision-capable model.

**Are approvals and questions forwarded to Discord?**

Yes. Bound channels receive the question/approval buttons automatically; after you click or reply, the local DSH popup closes and the task continues. Unbound sessions still use the local DSH UI.

## Security

- The Discord bot token is a password. Never commit it, screenshot it, or paste it into chat. Reset it in the Discord Developer Portal if exposed.
- On shared servers, set `allowUserIds` / `allowChannelIds` so only you can use the bot.
- The plugin runs inside DSH and inherits its tool and session permissions. Prefer a dedicated server and a dedicated bot.

## License

[MIT](./LICENSE) © 2026 so2bin
