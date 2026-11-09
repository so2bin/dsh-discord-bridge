/**
 * dsh-discord-bridge — drive Harness sessions from Discord channels.
 *
 * Every Discord text channel (or DM) the bot can see is a bridge endpoint:
 * the first time it is used it binds to one Session, and from then on
 *
 *   - outbound: committed `session/event`s of that Session become channel
 *     messages (assistant text, tool calls, turn outcome);
 *   - inbound: a message in the channel becomes a real user message on that
 *     same Session through `agent.followup()`.
 *
 * `!status` renders the live session catalog as an embed whose buttons bind
 * the channel with one click, and `!new` mints a fresh Session through the
 * same preset/bootstrap path the Web UI uses.
 *
 * @module dsh-discord-bridge
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { DiscordGateway, DiscordRest, INTENTS, chunkText, downloadAttachment } from './discord.js'

export const name = 'discord-bridge'
export const inject = ['agents']

const DEFAULTS = {
  botToken: '',
  channelId: '',
  proxy: '',
  sessionId: '',
  newSessionCwd: '',
  allowUserIds: [],
  allowChannelIds: [],
  pushAssistant: true,
  pushTools: false,
  pushTurnEnd: true,
  pushTyping: true,
  replyToPrompt: true,
  storeFile: '',
  dedicatedChannels: false,
  autoRename: true,
  guildId: '',
  channelCategoryId: '',
  channelNamePrefix: '',
  label: 'DSH',
}

const TYPING_MS = 6000
const MAX_BUTTONS = 20
const EMBED_COLOR = 0x5865f2

/** Discord's unboosted upload ceiling is 10 MiB; leave room for multipart overhead. */
const UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024 - 64 * 1024
const TEXT_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.srt', '.log', '.json', '.yaml', '.yml', '.csv'])
const MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.txt', 'text/plain'],
  ['.srt', 'text/plain'],
  ['.json', 'application/json'],
  ['.yaml', 'text/yaml'],
  ['.yml', 'text/yaml'],
  ['.csv', 'text/csv'],
  ['.pdf', 'application/pdf'],
])

function contentTypeFor(name) {
  return MIME_BY_EXTENSION.get(extname(String(name ?? '')).toLowerCase()) ?? 'application/octet-stream'
}

function isTextFile(name) {
  return TEXT_FILE_EXTENSIONS.has(extname(String(name ?? '')).toLowerCase())
}

/** Slash commands registered into the guild on connect. */
const SLASH_COMMANDS = [
  { type: 1, name: 'status', description: '会话看板：标题、工作区、状态，点按钮绑定或建同步频道' },
  {
    type: 1,
    name: 'use',
    description: '把本频道绑定到某个会话',
    options: [{ type: 3, name: 'session', description: '序号（看板里的数字）或会话 id 前缀', required: true }],
  },
  {
    type: 1,
    name: 'sync',
    description: '给会话建专属频道并开启同步',
    options: [{ type: 3, name: 'session', description: '序号或 id 前缀；留空 = 本频道绑定的会话', required: false }],
  },
  { type: 1, name: 'unsync', description: '关闭本频道同步（专属频道会删掉，会话不受影响）' },
  {
    type: 1,
    name: 'new',
    description: '新建一个会话并绑定本频道',
    options: [{ type: 3, name: 'prompt', description: '首条指令（可留空）', required: false }],
  },
  {
    type: 1,
    name: 'ask',
    description: '给本频道绑定的会话发一条指令',
    options: [{ type: 3, name: 'prompt', description: '指令内容', required: true }],
  },
  { type: 1, name: 'archive', description: '归档本频道绑定的会话' },
  { type: 1, name: 'help', description: '帮助' },
]

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/** One user-role message shaped exactly like a UI prompt (id/role/source/content). */
function userMessageParts(content) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    source: { kind: 'user' },
    content,
  })
}

function userMessage(text) {
  return userMessageParts([{ type: 'text', text }])
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Sniff the raster format from magic bytes; never trust the declared MIME alone. */
function sniffImageMediaType(bytes) {
  if (!bytes || bytes.length < 12) return undefined
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return undefined
}


function blockText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function clip(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

const shortId = (id) => String(id ?? '').replace(/^session-/, '').slice(0, 8)

function cwdBase(agent) {
  const cwd = String(agent?.session?.header?.cwd ?? '').replace(/[\\/]+$/, '')
  return cwd.split(/[\\/]/).pop() || 'session'
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  // Prefer environment variables so a bot token never has to live in a
  // profile file (and can never be committed by accident).
  cfg.botToken = cfg.botToken || process.env.DISCORD_BOT_TOKEN || ''
  cfg.proxy = cfg.proxy || process.env.DISCORD_PROXY || ''
  const log = (message) => ctx.logger.info(`[discord-bridge] ${message}`)
  const warn = (message) => ctx.logger.warn(`[discord-bridge] ${message}`)

  if (!cfg.botToken) {
    warn('botToken is empty — set it in cordis.patch.yml or DISCORD_BOT_TOKEN, then reload the profile.')
    return
  }

  let rest
  try {
    rest = new DiscordRest({ token: cfg.botToken, proxy: cfg.proxy || undefined })
  } catch (error) {
    warn(`invalid proxy "${cfg.proxy}": ${error?.message ?? error}`)
    return
  }

  const storePath =
    cfg.storeFile || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins', 'dsh-discord-bridge.json')

  /** channelId -> sessionId */
  const bindings = new Map()
  const loadStore = () => {
    try {
      const raw = JSON.parse(readFileSync(storePath, 'utf8'))
      for (const [channel, session] of Object.entries(raw?.channels ?? {})) {
        if (typeof channel === 'string' && typeof session === 'string') bindings.set(channel, session)
      }
    } catch {
      /* first run or unreadable store: start empty */
    }
  }
  const saveStore = () => {
    try {
      mkdirSync(dirname(storePath), { recursive: true })
      writeFileSync(storePath, JSON.stringify({ channels: Object.fromEntries(bindings) }, null, 2), 'utf8')
    } catch (error) {
      warn(`could not persist bindings to ${storePath}: ${error?.message ?? error}`)
    }
  }
  loadStore()
  if (bindings.size === 0 && cfg.channelId && cfg.sessionId) bindings.set(cfg.channelId, cfg.sessionId)

  const state = {
    selfId: '',
    appId: '',
    guildId: cfg.guildId || '',
    commandsRegistered: false,
    collect: null,
    channels: new Map(),
    gateway: undefined,
    typing: new Map(),
    resumed: new Map(),
    created: new Map(),
    creating: new Set(),
    renamed: new Set(),
    chanQueue: Promise.resolve(),
    disposed: false,
    queue: Promise.resolve(),
  }

  const sayTo = (channel, text, options) => {
    if (!channel || (!text && !options?.embeds)) return Promise.resolve()
    // Inside a slash-command handler the reply goes back as the interaction
    // response instead of a second channel message.
    if (state.collect && state.collect.channel === channel) {
      if (text) state.collect.lines.push(text)
      return Promise.resolve()
    }
    state.queue = state.queue.then(
      () => rest.sendMessage(channel, text, options).catch((error) => warn(`send failed: ${error?.message ?? error}`)),
      () => undefined,
    )
    return state.queue
  }

  const liveRoots = () => ctx.agents.list().filter((agent) => agent?.session?.header?.origin !== 'subagent')
  const channelsBoundTo = (sessionId) =>
    [...bindings].filter(([, session]) => session === sessionId).map(([channel]) => channel)

  /** Session title from the log-backed title service, falling back to the workspace name. */
  function displayTitle(agent) {
    try {
      const service = ctx.get('sessionTitle')
      const snapshot = service?.get?.(agent.session)
      if (snapshot?.title) return String(snapshot.title)
    } catch {
      /* title service unavailable: fall through */
    }
    return cwdBase(agent)
  }

  function describe(agent) {
    const status = agent?.status === 'running' ? '运行中' : '空闲'
    return `${clip(displayTitle(agent), 40)} · ${status} · ${shortId(agent?.id)}`
  }

  function autoTarget() {
    const roots = liveRoots()
    if (roots.length === 0) return undefined
    const running = roots.filter((agent) => agent.status === 'running')
    return (running.length > 0 ? running : roots).at(-1)
  }

  async function ensureAgent(sessionId) {
    if (!sessionId) return undefined
    const live = ctx.agents.get(sessionId)
    if (live) return live
    const loop = ctx.get('agentLoop')
    if (!loop) return undefined
    try {
      const handle = await loop.resume(ctx, { resumeSessionId: sessionId })
      state.resumed.set(sessionId, handle)
      log(`resumed cold session ${sessionId}`)
      return handle.agent
    } catch (error) {
      warn(`could not resume ${sessionId}: ${error?.message ?? error}`)
      return undefined
    }
  }

  function startTyping(channel) {
    if (!cfg.pushTyping || !channel || state.typing.has(channel)) return
    const tick = () => rest.typing(channel).catch(() => undefined)
    tick()
    const timer = setInterval(tick, TYPING_MS)
    timer.unref?.()
    state.typing.set(channel, timer)
  }

  function stopTyping(channel) {
    const timer = state.typing.get(channel)
    if (!timer) return
    clearInterval(timer)
    state.typing.delete(channel)
  }

  function bind(channel, sessionId) {
    bindings.set(channel, sessionId)
    saveStore()
  }

  const channelForSession = (sessionId) => [...bindings].find(([, session]) => session === sessionId)?.[0]

  /** Discord-safe channel name from the session title. */
  function channelName(agent) {
    const raw = `${cfg.channelNamePrefix}${displayTitle(agent)}`.toLowerCase()
    const slug = raw
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/-+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 48)
    return slug || `dsh-${shortId(agent.id)}`
  }

  /** Rebuild a binding from the `dsh:<sessionId>` topic Discord already stores. */
  function adoptChannel(channel) {
    const topic = String(channel?.topic ?? '')
    const match = topic.match(/dsh:(session-[0-9a-f-]{8,})/i)
    if (!match) return
    const sessionId = match[1]
    if (channelForSession(sessionId)) return
    bind(channel.id, sessionId)
    log(`adopted #${channel.name} -> ${shortId(sessionId)}`)
  }

  /** Serialized channel creation: Discord rate-limits guild channel creation hard. */
  function scheduleChannel(agent) {
    if (!cfg.dedicatedChannels || !agent) return Promise.resolve()
    const job = state.chanQueue.then(async () => {
      const created = await ensureChannelFor(agent)
      await new Promise((resolve) => setTimeout(resolve, 1200))
      return created
    })
    state.chanQueue = job.catch(() => undefined)
    return job
  }

  async function ensureChannelFor(agent) {
    if (!cfg.dedicatedChannels || !agent) return undefined
    const sessionId = agent.id
    if (!state.guildId) return undefined
    const existing = channelForSession(sessionId)
    if (existing) return existing
    if (state.creating.has(sessionId)) return undefined
    state.creating.add(sessionId)
    try {
      const name = channelName(agent)
      const created = await rest.createChannel(state.guildId, {
        name,
        type: 0,
        topic: `dsh:${sessionId}`,
        ...(cfg.channelCategoryId ? { parent_id: cfg.channelCategoryId } : {}),
      })
      state.channels.set(created.id, created)
      bind(created.id, sessionId)
      log(`created #${name} for ${shortId(sessionId)}`)
      await sayTo(
        created.id,
        [
          `🆕 会话 \`${shortId(sessionId)}\``,
          `　　\`${agent.session?.header?.cwd ?? ''}\``,
          '　　这是它的专属频道：在这里发消息 = 给这个会话下指令，它的回复也会同步到这里。',
          '　　`!unsync` 关闭同步；直接删频道**不会**动会话。',
        ].join('\n'),
      )
      return created.id
    } catch (error) {
      warn(`could not create a channel for ${shortId(sessionId)}: ${error?.message ?? error}`)
      throw error
    } finally {
      state.creating.delete(sessionId)
    }
  }

  async function archiveSession(channel) {
    const sessionId = bindings.get(channel)
    if (!sessionId) {
      await sayTo(channel, '本频道还没有绑定会话。')
      return
    }
    const registry = ctx.get('workspaceRegistry')
    if (!registry) {
      await sayTo(channel, '这个 profile 没有 workspace 注册表，无法归档。')
      return
    }
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
      const agent = ctx.agents.get(sessionId)
      if (agent?.status === 'running') agent.cancel({ kind: 'user' }, { keepInbox: true })
      await sayTo(channel, `🗄 已归档会话 \`${shortId(sessionId)}\`（频道保留，可手动删除）。`)
    } catch (error) {
      await sayTo(channel, `归档失败：${error?.message ?? error}`)
    }
  }

  // ---- status board ----------------------------------------------------

  function packRows(buttons, extraRow) {
    const rows = []
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push({ type: 1, components: buttons.slice(i, i + 5) })
    }
    if (extraRow) rows.push({ type: 1, components: extraRow })
    return rows.slice(0, 5)
  }

  function statusPayload(channel) {
    const roots = liveRoots()
    const bound = bindings.get(channel)
    const lines = []
    const buttons = []
    roots.slice(0, MAX_BUTTONS).forEach((agent, index) => {
      const number = index + 1
      const title = clip(displayTitle(agent), 60)
      const here = agent.id === bound
      const elsewhere = channelsBoundTo(agent.id).filter((id) => id !== channel).length
      const mark = here ? '→' : elsewhere > 0 ? '·' : '　'
      const status = agent.status === 'running' ? '🟢 运行中' : '⚪️ 空闲'
      lines.push(
        `${mark} **${number}.** ${title}\n　　　\`${cwdBase(agent)}\` · ${status} · \`${shortId(agent.id)}\`${
          elsewhere > 0 ? ` · 另 ${elsewhere} 个频道` : ''
        }`,
      )
      buttons.push({
        type: 2,
        style: here ? 3 : 2,
        label: clip(`#${number} ${title}`, 78),
        custom_id: `bind:${agent.id}`,
      })
    })

    if (roots.length === 0) lines.push('当前没有活着的会话。先用 `!new <指令>` 开一个。')

    return {
      embeds: [
        {
          title: '会话',
          color: EMBED_COLOR,
          description: lines.join('\n').slice(0, 4000) || '（空）',
          footer: {
            text: bound
              ? `本频道 → ${shortId(bound)} ｜ 点下面的按钮换会话，或发 !new 开新会话`
              : '本频道还没绑定 ｜ 点下面的按钮选会话，或发 !new 开新会话',
          },
        },
      ],
      components: packRows(buttons, [
        { type: 2, style: 1, label: '🔄 刷新', custom_id: 'refresh' },
        { type: 2, style: 4, label: '解绑本频道', custom_id: 'unbind' },
      ]),
    }
  }

  // ---- inbound ---------------------------------------------------------

  async function handleCommand(channel, text) {
    const [verb, ...restArgs] = text.slice(1).trim().split(/\s+/)
    const arg = restArgs.join(' ')

    if (verb === 'help') {
      await sayTo(
        channel,
        [
          '**dsh bridge** — 手机端遥控 Harness 会话',
          '直接发文本 = 给本频道绑定的会话下一条指令',
          '`!status` 会话看板(带按钮，点一下就切)',
          '`!use 2` / `!use <会话 id 前缀>` 把本频道绑到那个会话',
          '`!new [首条指令]` 开一个新会话并绑定本频道',
          '`!sync [序号|id]` 给某个会话建专属频道并**开启同步**（默认：本频道绑定的会话）',
          '`!unsync` 关闭本频道的同步（专属频道会被删掉，会话不受影响）',
          '`!archive` 归档本频道绑定的会话（删频道不会删会话）',
          '`!unbind` 解除本频道绑定',
          '`!stop` 停止本频道绑定的会话正在跑的这一轮',
          '`!file <路径>` 把工作区里的图片/视频/文件传到 Discord（≤10MB）',
          '`!show <路径>` 直接在 Discord 里查看 Markdown/文本文件',
          '`!id` 显示本频道绑定的会话',
          '`!here` 当前频道 id',
          '`!help` 显示这条帮助',
        ].join('\n'),
      )
      return
    }

    if (verb === 'here') {
      await sayTo(channel, `频道 id: \`${channel}\``)
      return
    }

    if (verb === 'status') {
      const payload = statusPayload(channel)
      await sayTo(channel, '', payload)
      return
    }

    if (verb === 'use') {
      const roots = liveRoots()
      const index = Number.parseInt(arg, 10)
      const needle = arg.replace(/^session-/, '')
      const picked =
        Number.isInteger(index) && index >= 1 && index <= roots.length
          ? roots[index - 1]
          : roots.find((agent) => agent.id === arg || String(agent.id).replace(/^session-/, '').startsWith(needle))
      if (!picked) {
        await sayTo(channel, `没有找到 "${arg}"。先发 \`!status\` 看列表。`)
        return
      }
      bind(channel, picked.id)
      await sayTo(channel, `本频道已绑定 ${describe(picked)}`)
      return
    }

    if (verb === 'new') {
      await handleNew(channel, arg)
      return
    }

    if (verb === 'file') {
      await handleFile(channel, arg)
      return
    }

    if (verb === 'show') {
      await handleShow(channel, arg)
      return
    }

    if (verb === 'archive') {
      await archiveSession(channel)
      return
    }

    if (verb === 'sync') {
      let agent
      if (arg) {
        const roots = liveRoots()
        const index = Number.parseInt(arg, 10)
        const needle = arg.replace(/^session-/, '')
        agent =
          (Number.isInteger(index) && index >= 1 && index <= roots.length ? roots[index - 1] : undefined) ??
          roots.find((a) => a.id === arg || String(a.id).replace(/^session-/, '').startsWith(needle))
      } else {
        const boundId = bindings.get(channel)
        agent = boundId ? await ensureAgent(boundId) : undefined
      }
      if (!agent) {
        await sayTo(channel, '用法：`!sync <序号|id 前缀>`；在已绑定会话的频道里可以直接 `!sync`。先 `!status` 看列表。')
        return
      }
      const existing = channelForSession(agent.id)
      if (existing) {
        await sayTo(channel, `这个会话已经有专属频道 <#${existing}>。`)
        return
      }
      try {
        const created = await scheduleChannel(agent)
        if (created) await sayTo(channel, `✅ 已建 <#${created}> 并开启同步。`)
        else await sayTo(channel, '没建成：检查 bot 是否还有「管理频道」权限，或看看自己是否已在同步。')
      } catch (error) {
        await sayTo(channel, `建频道失败：${error?.message ?? error}\n大概率是缺「管理频道」权限。`)
      }
      return
    }

    if (verb === 'unsync') {
      const sessionId = bindings.get(channel)
      if (!sessionId) {
        await sayTo(channel, '本频道没有绑定会话。')
        return
      }
      const dedicated = String(state.channels.get(channel)?.topic ?? '').startsWith('dsh:')
      bindings.delete(channel)
      saveStore()
      if (dedicated && (await rest.deleteChannel(channel).catch(() => false)) !== false) {
        log(`unsynced and deleted dedicated channel for ${shortId(sessionId)}`)
        return
      }
      await sayTo(channel, '已关闭同步（本频道保留为新频道，可重复使用或手动删除）。')
      return
    }

    if (verb === 'unbind') {
      bindings.delete(channel)
      saveStore()
      await sayTo(channel, '本频道已解除绑定。下一条指令会重新选一个会话。')
      return
    }

    if (verb === 'stop') {
      const sessionId = bindings.get(channel)
      const agent = sessionId ? ctx.agents.get(sessionId) : undefined
      if (!agent) {
        await sayTo(channel, '本频道还没有绑定活着的会话。')
        return
      }
      if (agent.status !== 'running') {
        await sayTo(channel, '绑定的会话现在是空闲的。')
        return
      }
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      await sayTo(channel, '已发送停止。')
      return
    }

    if (verb === 'id') {
      const sessionId = bindings.get(channel)
      await sayTo(channel, sessionId ? `本频道绑定: \`${sessionId}\`` : '本频道还没有绑定会话。')
      return
    }

    await sayTo(channel, `未知命令 \`!${verb}\`，发 \`!help\` 看可用命令。`)
  }

  /** Create a Session the same way the Web UI does: preset mount + default model. */
  async function handleNew(channel, firstText) {
    const sessionId = `session-${randomUUID()}`
    const workingDirectory = ctx.get('workingDirectory')
    const boundAgent = ctx.agents.get(bindings.get(channel))
    const cwd =
      cfg.newSessionCwd ||
      boundAgent?.session?.header?.cwd ||
      workingDirectory?.defaultDirectory ||
      process.cwd()
    try {
      mkdirSync(cwd, { recursive: true })
    } catch (error) {
      warn(`could not ensure cwd ${cwd}: ${error?.message ?? error}`)
    }

    const presets = ctx.get('agentPresets')
    let presetId
    let setup
    if (presets) {
      try {
        const resolved = await presets.resolve(undefined)
        presetId = resolved?.id
        setup = async (agentCtx) => {
          await presets.mount(agentCtx, presetId)
        }
      } catch (error) {
        warn(`preset resolve failed, creating a bare session: ${error?.message ?? error}`)
      }
    }

    const selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {}
    let handle
    try {
      handle = await ctx.agents.create({
        sessionId,
        agentOptions: {
          ...(selection.provider ? { provider: selection.provider } : {}),
          ...(selection.model ? { model: selection.model } : {}),
        },
        meta: { cwd, ...(presetId ? { agentPreset: presetId } : {}) },
        ...(setup ? { setup } : {}),
      })
    } catch (error) {
      await sayTo(channel, `新会话没建起来：${error?.message ?? error}`)
      return
    }

    state.created.set(sessionId, handle)
    bind(channel, sessionId)
    const agent = handle.agent
    await sayTo(channel, `🆕 新会话 \`${shortId(sessionId)}\`\n　　\`${cwd}\`\n　　本频道已绑定它。`)

    if (firstText.trim()) {
      try {
        agent.followup(userMessage(firstText.trim()))
        if (cfg.replyToPrompt) await sayTo(channel, `→ 已交给 ${describe(agent)}`)
      } catch (error) {
        await sayTo(channel, `首条指令没有排进去：${error?.message ?? error}`)
      }
    }
  }

  /**
   * Convert one Discord message into DSH prompt content.
   *
   * Images are downloaded over the same proxy as the gateway and admitted
   * through `ctx.attachments`, so the session log keeps a durable image
   * reference instead of raw bytes. Non-image attachments are ignored.
   */
  async function buildInboundParts(text, rawAttachments) {
    const parts = []
    if (text) parts.push({ type: 'text', text })
    if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) return parts

    const attachmentStore = ctx.get('attachments')
    if (!attachmentStore?.saveImage) {
      warn('attachment service is unavailable; Discord images were ignored')
      return parts
    }

    const limits = attachmentStore.imageLimits ?? {}
    const maxBytes = Number(limits.maxImageBytes) > 0 ? Number(limits.maxImageBytes) : 10 * 1024 * 1024
    const maxImages = Number(limits.maxImagesPerMessage) > 0 ? Number(limits.maxImagesPerMessage) : 10
    let images = 0

    for (const file of rawAttachments) {
      if (images >= maxImages) {
        warn(`too many images in one message; only the first ${maxImages} were forwarded`)
        break
      }
      const declared = String(file?.content_type ?? '').toLowerCase()
      if (declared && !declared.startsWith('image/')) continue
      const url = file?.url || file?.proxy_url
      if (!url) continue
      const declaredBytes = Number(file?.size)
      if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
        warn(`image ${file?.filename ?? file?.id ?? ''} is too large (${declaredBytes} bytes)`)
        continue
      }
      try {
        const data = await downloadAttachment(url, { proxy: cfg.proxy || undefined, maxBytes })
        const mediaType = sniffImageMediaType(data) ?? (IMAGE_MEDIA_TYPES.has(declared) ? declared : undefined)
        if (!mediaType) {
          warn(`image ${file?.filename ?? file?.id ?? ''} has an unsupported format`)
          continue
        }
        const ref = await attachmentStore.saveImage({
          data,
          mediaType,
          name: typeof file?.filename === 'string' ? file.filename : undefined,
        })
        parts.push({ type: 'image', attachment: ref })
        images += 1
        log(`inbound image ${ref.name ?? file?.id ?? ''} ${ref.mediaType} ${ref.bytes}B`)
      } catch (error) {
        warn(`image ${file?.filename ?? file?.id ?? ''} download failed: ${error?.message ?? error}`)
      }
    }
    return parts
  }

  async function handlePrompt(channel, content, messageId) {
    const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]
    let sessionId = bindings.get(channel)
    if (!sessionId) {
      const picked = autoTarget()
      if (!picked) {
        await sayTo(channel, '没有可用的会话：先用 `!status` 选一个，或 `!new` 开一个。')
        return
      }
      sessionId = picked.id
      bind(channel, sessionId)
      await sayTo(channel, `本频道自动绑定到 ${describe(picked)}`)
    }
    const agent = await ensureAgent(sessionId)
    if (!agent) {
      await sayTo(channel, '绑定的会话拉不起来（可能已被归档）。用 `!status` 换一个。')
      return
    }
    try {
      agent.followup(userMessageParts(parts))
    } catch (error) {
      await sayTo(channel, `指令没有排进去：${error?.message ?? error}`)
      return
    }
    if (cfg.replyToPrompt) await sayTo(channel, `→ 已交给 ${describe(agent)}`, { replyTo: messageId })
  }

  /** Resolve a user-supplied path inside the bound session's workspace. */
  function resolveWorkspacePath(agent, input) {
    const raw = String(input ?? '').trim().replace(/^["']|["']$/g, '')
    if (!raw) throw new Error('缺少文件路径')
    const root = realpathSync(resolve(agent?.session?.header?.cwd || cfg.newSessionCwd || process.cwd()))
    const target = isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
    const real = realpathSync(target)
    const rel = relative(root, real)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('只能访问当前会话工作区内的文件')
    return real
  }

  async function boundAgentForFiles(channel) {
    const sessionId = bindings.get(channel)
    if (!sessionId) return undefined
    return await ensureAgent(sessionId)
  }

  async function handleFile(channel, arg) {
    const agent = await boundAgentForFiles(channel)
    if (!agent) {
      await sayTo(channel, '这个频道还没有绑定会话：先发 `!status` 选一个，或 `!new`。')
      return
    }
    let filePath
    try {
      filePath = resolveWorkspacePath(agent, arg)
    } catch (error) {
      await sayTo(channel, `找不到文件：${error?.message ?? error}`)
      return
    }
    let info
    try {
      info = statSync(filePath)
    } catch (error) {
      await sayTo(channel, `读不到文件：${error?.message ?? error}`)
      return
    }
    if (!info.isFile()) {
      await sayTo(channel, `这不是一个文件：\`${arg}\``)
      return
    }
    if (info.size > UPLOAD_LIMIT_BYTES) {
      const mb = (info.size / 1024 / 1024).toFixed(1)
      await sayTo(channel, `文件 ${mb} MB，超过 Discord 当前 10 MB 上传上限。可以压缩/转码后再发。`)
      return
    }
    const name = basename(filePath)
    try {
      const data = readFileSync(filePath)
      await rest.upload(channel, { name, contentType: contentTypeFor(name), data }, `📎 ${name}`)
      log(`uploaded ${name} (${data.length}B) to ${channel}`)
    } catch (error) {
      await sayTo(channel, `上传失败：${error?.message ?? error}`)
    }
  }

  async function handleShow(channel, arg) {
    const agent = await boundAgentForFiles(channel)
    if (!agent) {
      await sayTo(channel, '这个频道还没有绑定会话：先发 `!status` 选一个，或 `!new`。')
      return
    }
    let filePath
    try {
      filePath = resolveWorkspacePath(agent, arg)
    } catch (error) {
      await sayTo(channel, `找不到文件：${error?.message ?? error}`)
      return
    }
    if (!isTextFile(filePath)) {
      await sayTo(channel, '`!show` 只支持 Markdown/文本文件；图片、视频请用 `!file`。')
      return
    }
    let info
    try {
      info = statSync(filePath)
    } catch (error) {
      await sayTo(channel, `读不到文件：${error?.message ?? error}`)
      return
    }
    if (info.size > 512 * 1024) {
      await sayTo(channel, '文本文件超过 512KB，建议用 `!file` 上传后查看，或先精简内容。')
      return
    }
    const text = readFileSync(filePath, 'utf8')
    if (!text.trim()) {
      await sayTo(channel, '文件是空的。')
      return
    }
    for (const chunk of chunkText(text, 1900)) await sayTo(channel, chunk)
  }

  async function onMessage(data) {
    if (!data || data.author?.bot) return
    if (state.selfId && data.author?.id === state.selfId) return
    const allowedUsers = Array.isArray(cfg.allowUserIds) ? cfg.allowUserIds.filter(Boolean) : []
    if (allowedUsers.length > 0 && !allowedUsers.includes(data.author?.id)) return
    const allowedChannels = Array.isArray(cfg.allowChannelIds) ? cfg.allowChannelIds.filter(Boolean) : []
    if (allowedChannels.length > 0 && !allowedChannels.includes(data.channel_id)) return

    const channel = data.channel_id
    const text = String(data.content ?? '').trim()
    const rawAttachments = Array.isArray(data.attachments) ? data.attachments : []
    if (!text && rawAttachments.length === 0) return
    try {
      if (text.startsWith('!')) {
        await handleCommand(channel, text)
        return
      }
      const parts = await buildInboundParts(text, rawAttachments)
      if (parts.length === 0) {
        if (rawAttachments.length > 0) {
          await sayTo(channel, '图片没有传进来：下载或格式校验失败，检查 bridge 日志。')
        }
        return
      }
      await handlePrompt(channel, parts, data.id)
    } catch (error) {
      warn(`inbound failed: ${error?.message ?? error}`)
      await sayTo(channel, `出错了：${error?.message ?? error}`)
    }
  }

  // ---- component interactions -----------------------------------------

  async function onApplicationCommand(data) {
    const channel = data.channel_id
    const name = String(data.data?.name ?? '')
    const arg = String((data.data?.options ?? []).find((option) => option.type === 3)?.value ?? '')
    const ack = (payload) =>
      rest
        .interactionCallback(data.id, data.token, payload)
        .catch((error) => warn(`interaction callback failed: ${error?.message ?? error}`))

    if (name === 'status') {
      await ack({ type: 4, data: statusPayload(channel) })
      return
    }

    // Defer first: `!sync` may create a channel and blow past the 3s window.
    const deferred = await rest
      .interactionCallback(data.id, data.token, { type: 5, data: { flags: 64 } })
      .then(() => true)
      .catch((error) => {
        warn(`interaction defer failed: ${error?.message ?? error}`)
        return false
      })

    state.collect = { channel, lines: [] }
    try {
      if (name === 'ask') await handlePrompt(channel, arg.trim() || '（空指令）')
      else await handleCommand(channel, `!${name}${arg ? ` ${arg}` : ''}`)
    } catch (error) {
      state.collect.lines.push(`出错了：${error?.message ?? error}`)
    }
    const lines = state.collect.lines
    state.collect = null
    const content = (lines.join('\n') || '完成').slice(0, 1900)

    if (deferred && state.appId) {
      await rest
        .editOriginalResponse(state.appId, data.token, { content })
        .catch((error) => warn(`interaction reply failed: ${error?.message ?? error}`))
      return
    }
    await sayTo(channel, content)
  }

  async function onInteraction(data) {
    if (data?.type === 2) {
      await onApplicationCommand(data)
      return
    }
    if (data?.type !== 3) return
    const channel = data.channel_id
    const customId = String(data.data?.custom_id ?? '')
    const reply = (payload) =>
      rest
        .interactionCallback(data.id, data.token, payload)
        .catch((error) => warn(`interaction callback failed: ${error?.message ?? error}`))

    if (customId === 'refresh') {
      await reply({ type: 7, data: statusPayload(channel) })
      return
    }
    if (customId === 'unbind') {
      bindings.delete(channel)
      saveStore()
      await reply({ type: 4, data: { content: '本频道已解绑。', flags: 64 } })
      return
    }
    if (customId.startsWith('bind:')) {
      const sessionId = customId.slice(5)
      const agent = ctx.agents.get(sessionId)
      if (!agent) {
        await reply({ type: 4, data: { content: '这个会话已经不在线了，先刷新。', flags: 64 } })
        return
      }
      bind(channel, sessionId)
      await reply({ type: 7, data: statusPayload(channel) })
      return
    }
    await reply({ type: 4, data: { content: '未知操作。', flags: 64 } })
  }

  // ---- outbound --------------------------------------------------------

  function onSessionEvent(session, event) {
    const channels = channelsBoundTo(session?.id)
    if (channels.length === 0) return
    const broadcast = (text) => {
      for (const channel of channels) sayTo(channel, text)
    }
    switch (event.type) {
      case 'assistant/message': {
        if (!cfg.pushAssistant) return
        const text = blockText(event.data?.message?.content)
        if (text) broadcast(text)
        return
      }
      case 'tool/call': {
        if (!cfg.pushTools) return
        const args = clip(String(event.data?.arguments ?? '').replace(/\s+/g, ' '), 180)
        broadcast(`🔧 **${event.data?.name ?? 'tool'}** ${args ? `\`${args}\`` : ''}`)
        return
      }
      case 'tool/result': {
        if (!cfg.pushTools || !event.data?.error) return
        const error = event.data.error
        broadcast(`⚠️ **${error.name ?? 'tool'}** 失败：${clip(error.reason ?? error.code ?? '', 200)}`)
        return
      }
      case 'session/title': {
        if (!cfg.dedicatedChannels || !cfg.autoRename) return
        const channel = channelForSession(session.id)
        if (!channel || state.renamed.has(channel)) return
        const agent = ctx.agents.get(session.id)
        if (!agent) return
        const wanted = channelName(agent)
        const current = state.channels.get(channel)
        if (!wanted || current?.name === wanted) return
        state.renamed.add(channel)
        rest
          .modifyChannel(channel, { name: wanted })
          .then((updated) => {
            if (updated) state.channels.set(channel, { ...(current ?? {}), ...updated })
            log(`renamed #${wanted}`)
          })
          .catch((error) => warn(`rename failed: ${error?.message ?? error}`))
        return
      }
      case 'turn/end': {
        if (!cfg.pushTurnEnd) return
        const kind = event.data?.reason?.kind ?? 'unknown'
        const icon = kind === 'completed' ? '✅' : kind === 'aborted' ? '⏹' : '❌'
        const label = kind === 'completed' ? '完成' : kind === 'aborted' ? '已停止' : `结束(${kind})`
        const agent = ctx.agents.get(session.id)
        const tail = agent ? describe(agent) : `会话结束 · ${shortId(session.id)}`
        broadcast(`${icon} ${label} · turn ${event.data?.turn ?? '?'} · ${tail}`)
        return
      }
      default:
        return
    }
  }

  function onStatus(payload) {
    const sessionId = payload?.agent?.id
    if (!sessionId) return
    for (const channel of channelsBoundTo(sessionId)) {
      if (payload.status === 'running') startTyping(channel)
      else stopTyping(channel)
    }
  }

  // ---- lifecycle -------------------------------------------------------

  ctx.effect(() => {
    const offEvent = ctx.on('session/event', onSessionEvent)
    const offStatus = ctx.on('agent/status', onStatus)
    const gateway = new DiscordGateway({
      token: cfg.botToken,
      intents: INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGES | INTENTS.MESSAGE_CONTENT,
      proxy: cfg.proxy || undefined,
      log: warn,
      onDispatch: (type, data) => {
        if (type === 'READY') {
          state.selfId = data?.user?.id ?? ''
          state.appId = data?.application?.id ?? state.appId
          if (state.appId && state.guildId && !state.commandsRegistered) {
            state.commandsRegistered = true
            rest
              .registerGuildCommands(state.appId, state.guildId, SLASH_COMMANDS)
              .then((commands) => log(`registered ${Array.isArray(commands) ? commands.length : 0} slash commands`))
              .catch((error) => {
                state.commandsRegistered = false
                warn(`slash command registration failed: ${error?.message ?? error}`)
              })
          }
          log(`connected as ${data?.user?.username ?? '?'} (${state.selfId}); proxy=${cfg.proxy || 'none'}; bindings=${bindings.size}`)
          const home = cfg.channelId || [...bindings.keys()][0]
          if (home) {
            const bound = [...bindings].map(([channel, session]) => `<#${channel}> → \`${shortId(session)}\``)
            void sayTo(home, ['🟢 dsh bridge 已连接', ...bound].join('\n'))
          }
          return
        }
        if (type === 'MESSAGE_CREATE') {
          void onMessage(data)
        }
        if (type === 'INTERACTION_CREATE') {
          void onInteraction(data)
        }
        if (type === 'GUILD_CREATE') {
          if (!state.guildId) state.guildId = data.id
          if (data.id !== state.guildId) return
          for (const channel of data.channels ?? []) {
            if (channel?.type !== 0) continue
            state.channels.set(channel.id, channel)
            adoptChannel(channel)
          }
          return
        }
        if (type === 'CHANNEL_CREATE' || type === 'CHANNEL_UPDATE') {
          if (data?.type !== 0) return
          state.channels.set(data.id, data)
          adoptChannel(data)
          return
        }
        if (type === 'CHANNEL_DELETE') {
          state.channels.delete(data?.id)
          if (data?.id && bindings.has(data.id)) {
            bindings.delete(data.id)
            saveStore()
            log(`#${data.name ?? data.id} deleted — bound session left untouched`)
          }
          return
        }
      },
    })
    state.gateway = gateway
    gateway.connect().catch((error) => warn(`gateway connect failed: ${error?.message ?? error}`))

    return () => {
      state.disposed = true
      for (const channel of [...state.typing.keys()]) stopTyping(channel)
      offEvent()
      offStatus()
      void gateway.close()
      for (const handle of state.created.values()) void handle.dispose?.().catch?.(() => undefined)
      for (const handle of state.resumed.values()) void handle.dispose?.().catch?.(() => undefined)
      state.created.clear()
      state.resumed.clear()
    }
  })

  log(`armed · channels=${bindings.size} · proxy=${cfg.proxy || 'none'}`)
}
