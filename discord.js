/**
 * Minimal Discord REST + Gateway client for the Session Hub bridge.
 *
 * Deliberately dependency-light so it can live inside a Harness profile:
 * only `ws` (Gateway WebSocket) and `https-proxy-agent` (CONNECT tunnel for
 * networks that reach Discord through a local proxy such as Clash).
 *
 * @module dsh-discord-bridge/discord
 */
import https from 'node:https'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'

const API = 'https://discord.com/api/v10'
const MAX_MESSAGE = 1900

export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
}

/** Split one long reply into Discord-sized chunks without cutting words. */
export function chunkText(text, limit = MAX_MESSAGE) {
  const source = String(text ?? '')
  if (source.length <= limit) return [source]
  const out = []
  let rest = source
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.4) cut = rest.lastIndexOf(' ', limit)
    if (cut < limit * 0.4) cut = limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.length > 0) out.push(rest)
  return out
}

function agentFor(proxy) {
  if (!proxy) return undefined
  return new HttpsProxyAgent(proxy)
}

/**
 * Download one Discord CDN attachment into memory.
 *
 * Attachment URLs are pre-signed and need no Authorization header. The proxy
 * (when configured) is reused so media follows the same network path as the
 * gateway/REST calls. Redirects are followed a bounded number of times and the
 * body is capped before it can exhaust memory.
 *
 * @param {string} url
 * @param {{ proxy?: string, maxBytes?: number, timeoutMs?: number }} [options]
 * @returns {Promise<Buffer>}
 */
export function downloadAttachment(url, options = {}) {
  const { proxy, maxBytes = 10 * 1024 * 1024, timeoutMs = 20000 } = options
  const agent = agentFor(proxy)

  return new Promise((resolve, reject) => {
    const go = (target, redirectsLeft) => {
      let parsed
      try {
        parsed = new URL(target)
      } catch {
        reject(new Error('invalid attachment URL'))
        return
      }
      if (parsed.protocol !== 'https:') {
        reject(new Error(`unsupported attachment protocol ${parsed.protocol}`))
        return
      }

      const req = https.request(
        target,
        {
          method: 'GET',
          agent,
          headers: {
            'user-agent': 'DiscordBot (dsh-discord-bridge, 0.1.0)',
            accept: 'image/*',
          },
          timeout: timeoutMs,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume()
            go(new URL(res.headers.location, target).toString(), redirectsLeft - 1)
            return
          }
          if (res.statusCode !== 200) {
            res.resume()
            reject(new Error(`attachment GET -> ${res.statusCode}`))
            return
          }
          const chunks = []
          let total = 0
          res.on('data', (chunk) => {
            total += chunk.length
            if (total > maxBytes) {
              req.destroy(new Error(`attachment exceeds ${maxBytes} bytes`))
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () => resolve(Buffer.concat(chunks)))
        },
      )
      req.on('timeout', () => req.destroy(new Error('attachment GET timed out')))
      req.on('error', reject)
      req.end()
    }

    go(url, 3)
  })
}


/** Serialized REST client: one request at a time keeps rate limits simple. */
export class DiscordRest {
  #token
  #agent
  #queue = Promise.resolve()

  constructor({ token, proxy }) {
    this.#token = token
    this.#agent = agentFor(proxy)
  }

  get hasProxy() {
    return this.#agent !== undefined
  }

  request(method, path, body) {
    const run = async (attempt = 0) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      return await new Promise((resolve, reject) => {
        const req = https.request(
          `${API}${path}`,
          {
            method,
            agent: this.#agent,
            headers: {
              authorization: `Bot ${this.#token}`,
              'content-type': 'application/json',
              'user-agent': 'DiscordBot (dsh-discord-bridge, 0.1.0)',
              ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }),
            },
            timeout: 20000,
          },
          (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8')
              if (res.statusCode === 429 && attempt < 2) {
                let waitMs = 2000
                try {
                  const parsed = JSON.parse(text)
                  if (typeof parsed.retry_after === 'number') waitMs = Math.ceil(parsed.retry_after * 1000) + 250
                } catch {
                  /* keep the default wait */
                }
                setTimeout(() => run(attempt + 1).then(resolve, reject), Math.min(waitMs, 30000))
                return
              }
              if (res.statusCode >= 200 && res.statusCode < 300) {
                if (text.length === 0) return resolve(undefined)
                try {
                  return resolve(JSON.parse(text))
                } catch {
                  return resolve(text)
                }
              }
              reject(new Error(`discord ${method} ${path} -> ${res.statusCode} ${text.slice(0, 300)}`))
            })
          },
        )
        req.on('timeout', () => req.destroy(new Error(`discord ${method} ${path} timed out`)))
        req.on('error', reject)
        if (payload !== undefined) req.write(payload)
        req.end()
      })
    }
    const next = this.#queue.then(
      () => run(0),
      () => run(0),
    )
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  createChannel(guildId, payload) {
    return this.request('POST', `/guilds/${guildId}/channels`, payload)
  }

  modifyChannel(channelId, patch) {
    return this.request('PATCH', `/channels/${channelId}`, patch)
  }

  /**
   * Upload one file as a Discord message attachment.
   *
   * The caller owns workspace/path validation and the size limit. This method
   * only serializes the multipart body and shares the REST queue.
   *
   * @param {string} channelId
   * @param {{ name: string, contentType?: string, data: Buffer }} file
   * @param {string} [content]
   */
  upload(channelId, file, content = '') {
    const run = async (attempt = 0) => {
      const boundary = `----dshBridge${randomUUID().replace(/-/g, '')}`
      const filename = String(file.name || 'file').replace(/["\r\n]/g, '_')
      const payload = JSON.stringify({
        content: content || '',
        attachments: [{ id: 0, filename }],
      })
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\n` +
          `Content-Type: application/json\r\n\r\n${payload}\r\n`,
        'utf8',
      )
      const fileHead = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${filename}"\r\n` +
          `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`,
        'utf8',
      )
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
      const body = Buffer.concat([head, fileHead, file.data, tail])

      return await new Promise((resolve, reject) => {
        const req = https.request(
          `${API}/channels/${channelId}/messages`,
          {
            method: 'POST',
            agent: this.#agent,
            headers: {
              authorization: `Bot ${this.#token}`,
              'content-type': `multipart/form-data; boundary=${boundary}`,
              'user-agent': 'DiscordBot (dsh-discord-bridge, 0.1.0)',
              'content-length': body.length,
            },
            timeout: 60000,
          },
          (res) => {
            const chunks = []
            res.on('data', (chunk) => chunks.push(chunk))
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8')
              if (res.statusCode === 429 && attempt < 2) {
                let waitMs = 2000
                try {
                  const parsed = JSON.parse(text)
                  if (typeof parsed.retry_after === 'number') waitMs = Math.ceil(parsed.retry_after * 1000) + 250
                } catch {
                  /* keep the default wait */
                }
                setTimeout(() => run(attempt + 1).then(resolve, reject), Math.min(waitMs, 30000))
                return
              }
              if (res.statusCode >= 200 && res.statusCode < 300) {
                try {
                  return resolve(JSON.parse(text))
                } catch {
                  return resolve(text)
                }
              }
              reject(new Error(`discord upload ${channelId} -> ${res.statusCode} ${text.slice(0, 300)}`))
            })
          },
        )
        req.on('timeout', () => req.destroy(new Error('discord upload timed out')))
        req.on('error', reject)
        req.write(body)
        req.end()
      })
    }

    const next = this.#queue.then(
      () => run(0),
      () => run(0),
    )
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  deleteChannel(channelId) {
    return this.request('DELETE', `/channels/${channelId}`)
  }

  me() {
    return this.request('GET', '/users/@me')
  }

  gatewayUrl() {
    return this.request('GET', '/gateway/bot')
  }

  /** Post one logical message, split into as many Discord messages as needed. */
  async sendMessage(channelId, content, options = {}) {
    const chunks = chunkText(content)
    const sent = []
    for (let i = 0; i < chunks.length; i += 1) {
      const body = { allowed_mentions: { parse: [] } }
      const text = chunks[i]
      if (text && text.length > 0) body.content = text
      if (i === 0 && options.embeds) body.embeds = options.embeds
      if (i === 0 && options.components) body.components = options.components
      if (i === 0 && options.replyTo) {
        body.message_reference = { message_id: options.replyTo, fail_if_not_exists: false }
      }
      sent.push(await this.request('POST', `/channels/${channelId}/messages`, body))
    }
    return sent
  }

  /** Answer one gateway interaction within Discord's 3 second window. */
  interactionCallback(interactionId, token, data) {
    return this.request('POST', `/interactions/${interactionId}/${token}/callback`, data)
  }

  /** Replace the commands the bot exposes in one guild (instant, resets drift). */
  registerGuildCommands(applicationId, guildId, commands) {
    return this.request('PUT', `/applications/${applicationId}/guilds/${guildId}/commands`, commands)
  }

  /** Fill in the deferred ephemeral reply of one interaction. */
  editOriginalResponse(applicationId, token, payload) {
    return this.request('PATCH', `/webhooks/${applicationId}/${token}/messages/@original`, payload)
  }

  typing(channelId) {
    return this.request('POST', `/channels/${channelId}/typing`).catch(() => undefined)
  }
}

/**
 * Gateway connection with heartbeat, identify/resume, and exponential backoff.
 * Dispatch listeners receive `(type, data)`.
 */
export class DiscordGateway {
  #token
  #intents
  #proxy
  #onDispatch
  #log
  #ws
  #seq = null
  #sessionId = null
  #resumeUrl = null
  #heartbeat
  #retry = 0
  #disposed = false
  #ready = null

  constructor({ token, intents, proxy, onDispatch, log }) {
    this.#token = token
    this.#intents = intents
    this.#proxy = proxy
    this.#onDispatch = onDispatch
    this.#log = log ?? (() => {})
  }

  get sessionId() {
    return this.#sessionId
  }

  async connect() {
    const rest = new DiscordRest({ token: this.#token, proxy: this.#proxy })
    let delay = 1000
    // DSH can start before the proxy/network is ready. Gateway discovery is a
    // REST call; retry it instead of giving up permanently on the first failure.
    for (;;) {
      if (this.#disposed) throw new Error('discord gateway disposed')
      try {
        const info = await rest.gatewayUrl()
        this.#resumeUrl = info.url
        return this.#open(`${info.url}/?v=10&encoding=json`)
      } catch (error) {
        this.#log(
          `gateway lookup failed: ${error instanceof Error ? error.message : String(error)}; retrying in ${delay}ms`,
        )
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delay)
          timer.unref?.()
        })
        delay = Math.min(delay * 2, 30000)
      }
    }
  }

  #open(url) {
    const agent = agentFor(this.#proxy)
    const ws = new WebSocket(url, { agent })
    this.#ws = ws
    this.#ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('discord gateway handshake timed out')), 20000)
      ws.once('open', () => clearTimeout(timer))
      ws.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    this.#ready.catch(() => {})

    ws.on('message', (raw) => this.#handle(String(raw)))
    ws.on('close', (code, reason) => {
      clearInterval(this.#heartbeat)
      this.#heartbeat = undefined
      if (this.#disposed) return
      this.#log(`gateway closed (${code} ${String(reason || '')})`)
      this.#scheduleReconnect()
    })
    ws.on('error', (err) => this.#log(`gateway error: ${err?.message ?? err}`))
    return this.#ready
  }

  #scheduleReconnect() {
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.#retry, 5))
    this.#retry += 1
    const timer = setTimeout(() => {
      if (this.#disposed) return
      const url = this.#resumeUrl ?? 'wss://gateway.discord.gg'
      this.#open(this.#resumeUrl ? `${url}/?v=10&encoding=json` : `${url}/?v=10&encoding=json`).catch((err) =>
        this.#log(`reconnect failed: ${err?.message ?? err}`),
      )
    }, delay)
    timer.unref?.()
  }

  #send(op, d) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ op, d }))
  }

  #identify() {
    this.#send(2, {
      token: this.#token,
      intents: this.#intents,
      properties: { os: process.platform, browser: 'dsh-discord-bridge', device: 'dsh' },
    })
  }

  #handle(raw) {
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof payload.s === 'number') this.#seq = payload.s
    switch (payload.op) {
      case 10: {
        clearInterval(this.#heartbeat)
        const interval = payload.d.heartbeat_interval
        this.#heartbeat = setInterval(() => this.#send(1, this.#seq), interval)
        this.#heartbeat.unref?.()
        if (this.#sessionId) this.#resume()
        else this.#identify()
        break
      }
      case 11:
        break
      case 7: {
        this.#log('gateway asked to reconnect')
        this.#ws?.close()
        break
      }
      case 9: {
        this.#log('gateway invalid session')
        this.#sessionId = null
        setTimeout(() => {
          if (!this.#disposed) this.#identify()
        }, 2000 + Math.random() * 3000)
        break
      }
      case 0: {
        if (payload.t === 'READY') {
          this.#sessionId = payload.d.session_id
          this.#resumeUrl = payload.d.resume_gateway_url ?? this.#resumeUrl
          this.#retry = 0
          this.#onDispatch('READY', payload.d)
          return
        }
        this.#onDispatch(payload.t, payload.d)
        break
      }
      default:
        break
    }
  }

  #resume() {
    this.#send(6, { token: this.#token, session_id: this.#sessionId, seq: this.#seq })
  }

  async close() {
    this.#disposed = true
    clearInterval(this.#heartbeat)
    try {
      this.#ws?.close()
    } catch {
      /* ignore */
    }
  }
}
