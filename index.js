/**
 * Host half of the 肥鱼画室 bundle.
 *
 * The painting canvas lives in the browser half. This half keeps the latest
 * snapshot each session pushed, hands it to the model as an image, and sends
 * the agent's strokes back to the open panel over a Server-Sent Events stream.
 *
 * Wire surface (same origin as the GUI, loopback only):
 *   POST /mpx/canvas/push    { sessionId, png: dataURL, meta }
 *   GET  /mpx/canvas/stream?sessionId=...   -> `ops` events
 */

const PUSH_PATH = '/mpx/canvas/push'
const STREAM_PATH = '/mpx/canvas/stream'
const NUDGE_PATH = '/mpx/canvas/nudge'
const ASK_PATH = '/mpx/canvas/ask'
const SAMPLE_PATH = '/mpx/canvas/sample'
const DONE_PATH = '/mpx/canvas/done'
const LAST_PATH = '/mpx/canvas/last'
const DEBUG_PATH = '/mpx/canvas/debug'

import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Retention for the on-disk snapshots. One file per session, overwritten in place, so
// a painting never grows; only the number of sessions can grow, and that is capped.
const MAX_STATE_FILES = 16
const MAX_STATE_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_SNAPSHOT_CHARS = 4 * 1024 * 1024
const MAX_MEMORY_SNAPSHOTS = 24

/**
 * Resolve the harness data root.
 *
 * The desktop launcher hands this process neither `DSH_HOME` nor `DSH_PROFILE_DIR`, so
 * the working directory is the only reliable clue: it is the profile directory, which
 * always sits at `$DSH_HOME/profiles/<name>`.
 * @returns {string} absolute data root.
 */
function resolveHarnessHome() {
  const candidates = [
    (process.env.DSH_PROFILE_DIR || '').trim(),
    process.cwd(),
    (process.env.DSH_HOME || '').trim(),
  ]
  for (const candidate of candidates) {
    const match = /^(.*)[\\/]profiles[\\/][^\\/]+$/i.exec(candidate)
    if (match && match[1]) return match[1]
  }
  const home = (process.env.DSH_HOME || '').trim()
  if (home && !/[\\/]profiles([\\/]|$)/i.test(home)) return home
  return process.cwd()
}

// The panel's own snapshot lives in the browser's localStorage, which is keyed by
// origin — and this host picks a new port on every launch. Keeping a copy under the
// harness home makes the painting survive a restart and reachable before the panel
// pushes again.
const HARNESS_HOME = resolveHarnessHome()
const STATE_DIR = join(HARNESS_HOME, 'canvas-state')
/** Earlier builds wrote inside the profile; read from there once so nothing is lost. */
const LEGACY_STATE_DIR = process.env.DSH_PROFILE_DIR
  ? join(process.env.DSH_PROFILE_DIR.trim(), 'canvas-state')
  : undefined

/**
 * One filesystem-safe file name for a session.
 * @param {string} sessionId - session identity.
 * @returns {string} file name.
 */
function stateFileName(sessionId) {
  return `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`
}
const MAX_BODY_BYTES = 16 * 1024 * 1024
const SNAPSHOT_TTL_MS = 30 * 60 * 1000

/** Loader identity for this plugin row. */
export const name = 'chubby-fish-studio'

/** The HTTP carrier hosts the canvas bridge; the rest is injected optionally. */
export const inject = ['webServer']

const CANVAS_PROMPT = [
  'The user has a pigment-mixing painting canvas: the 肥鱼画室 panel in the right sidebar.',
  'You can see it and you can paint on it, through the same pigment pipeline the user paints with.',
  '- `canvas_look` returns a picture of the canvas plus its pixel size and the current brush, palette, and colours. Call it whenever the user refers to what they painted, and before any advice about the painting.',
  '- `canvas_state` returns the same facts without a picture; use it for cheap follow-ups.',
  '- `canvas_draw` paints one or more strokes onto the canvas. It takes canvas pixel coordinates, which match the size `canvas_look` reported. Every stroke lands in the user undo stack, so the user can discard it.',
  'When the user asks for help with painting, look first, then name one concrete problem at a time and demonstrate with a single short stroke rather than a long description.',
  'The panel may start a turn for you when it decides the painting changed enough. Treat such a turn as an invitation to look and say one useful sentence, not as a prompt to describe the whole canvas again.',
  'If a canvas tool reports that no canvas is open, say so and suggest opening the 肥鱼画室 panel instead of guessing what is on it.',
].join(' ')

const CARD_TEXT = {
  noSession: 'No agent session is attached to this call, so there is no canvas to read.',
  notOpen: 'No canvas is open for this session. Ask the user to open the 肥鱼画室 panel from the 画室 entry at the foot of the left sidebar, then try again.',
  noAttachments: 'This deployment has no attachment store, so the canvas image cannot be handed to the model. The canvas state is still available through canvas_state.',
}

/**
 * Read a request body up to a fixed bound.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @returns {Promise<Buffer>} the collected bytes.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('canvas snapshot exceeds the size limit'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Answer one JSON response.
 * @param {import('node:http').ServerResponse} res - response to write.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable payload.
 */
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * Parse a `data:<media>;base64,<payload>` snapshot URL.
 * @param {string} dataUrl - the snapshot URL.
 * @returns {{ mediaType: string, bytes: Buffer } | undefined} parsed snapshot.
 */
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return undefined
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl)
  if (!match) return undefined
  return { mediaType: match[1], bytes: Buffer.from(match[2], 'base64') }
}

/**
 * Register the canvas bridge and the model-facing surface.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  /** @type {Map<string, { png: string, meta: unknown, at: number }>} */
  const snapshots = new Map()
  /** @type {Map<string, Set<import('node:http').ServerResponse>>} */
  const listeners = new Map()
  /** @type {Map<string, (colors: unknown) => void>} */
  const pendingSamples = new Map()
  /** @type {Map<string, () => void>} */
  const pendingDone = new Map()
  /** @type {Map<string, NodeJS.Timeout>} */
  const writeTimers = new Map()

  /**
   * Read the last snapshot this host saved for a session.
   * @param {string} sessionId - session identity.
   * @returns {Promise<{ png: string, meta: unknown, at: number } | undefined>} the entry.
   */
  async function readPersisted(sessionId) {
    const fileName = stateFileName(sessionId)
    for (const dir of [STATE_DIR, LEGACY_STATE_DIR]) {
      if (!dir) continue
      try {
        const text = await readFile(join(dir, fileName), 'utf8')
        const data = JSON.parse(text)
        if (!data || typeof data.png !== 'string') continue
        return { png: data.png, meta: data.meta ?? null, at: Number(data.at) || 0 }
      } catch {
        // try the next location
      }
    }
    return undefined
  }

  /**
   * Keep the snapshot directory bounded: newest MAX_STATE_FILES, nothing older than
   * MAX_STATE_AGE_MS.
   */
  async function pruneStateFiles() {
    try {
      const names = await readdir(STATE_DIR)
      const files = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const full = join(STATE_DIR, name)
        try {
          const info = await stat(full)
          files.push({ full, mtime: info.mtimeMs })
        } catch {
          // vanished; nothing to prune
        }
      }
      files.sort((left, right) => right.mtime - left.mtime)
      const now = Date.now()
      for (let index = 0; index < files.length; index += 1) {
        const tooMany = index >= MAX_STATE_FILES
        const tooOld = now - files[index].mtime > MAX_STATE_AGE_MS
        if (!tooMany && !tooOld) continue
        try { await unlink(files[index].full) } catch { /* already gone */ }
      }
    } catch {
      // no directory yet
    }
  }

  /**
   * Write one session's snapshot to disk, debounced per session.
   * @param {string} sessionId - session identity.
   */
  function schedulePersist(sessionId) {
    if (writeTimers.has(sessionId)) clearTimeout(writeTimers.get(sessionId))
    writeTimers.set(sessionId, setTimeout(async () => {
      writeTimers.delete(sessionId)
      const entry = snapshots.get(sessionId)
      if (!entry) return
      if (entry.png.length > MAX_SNAPSHOT_CHARS) {
        ctx.logger?.warn?.(`canvas-state: snapshot is ${entry.png.length} chars, over the ${MAX_SNAPSHOT_CHARS} cap; not persisted`)
        return
      }
      try {
        await mkdir(STATE_DIR, { recursive: true })
        // Overwrites this session's file: a longer painting never makes a longer file.
        await writeFile(
          join(STATE_DIR, stateFileName(sessionId)),
          JSON.stringify({ png: entry.png, meta: entry.meta ?? null, at: entry.at }),
          'utf8',
        )
        await pruneStateFiles()
      } catch (error) {
        ctx.logger?.warn?.(`canvas-state write failed: ${String(error && error.message || error)}`)
      }
    }, 600))
  }

  /**
   * Resolve the live agent of one session.
   *
   * Reads the registry instead of tracking `agent/created`: a session that started
   * before this plugin loaded still has to be reachable.
   * @param {string} sessionId - session identity.
   * @returns {unknown} the agent, or undefined.
   */
  function agentFor(sessionId) {
    const registry = ctx.get('agents')
    if (!registry || typeof registry.get !== 'function') return undefined
    try { return registry.get(sessionId) } catch { return undefined }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PUSH_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'method' }); return }
      let payload
      try {
        payload = JSON.parse((await readBody(req)).toString('utf8'))
      } catch (error) {
        json(res, 400, { ok: false, reason: 'bad-json', message: String(error && error.message || error) })
        return
      }
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      const parsed = parseDataUrl(payload?.png)
      if (!sessionId || !parsed) { json(res, 400, { ok: false, reason: 'bad-payload' }); return }
      const entry = { png: payload.png, meta: payload.meta ?? null, at: Date.now() }
      snapshots.set(sessionId, entry)
      // Bound the in-memory map too: one entry per session, oldest evicted first.
      if (snapshots.size > MAX_MEMORY_SNAPSHOTS) {
        const oldest = [...snapshots.entries()]
          .filter(([key]) => key !== sessionId)
          .sort((left, right) => (left[1].at || 0) - (right[1].at || 0))[0]
        if (oldest) snapshots.delete(oldest[0])
      }
      schedulePersist(sessionId)
      json(res, 200, { ok: true })
    },
  }), 'mixbox-palette: snapshot push route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STREAM_PATH,
    handler: (req, res) => {
      const url = new URL(req.url ?? STREAM_PATH, 'http://127.0.0.1')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      if (!sessionId) { res.end(); return }
      let set = listeners.get(sessionId)
      if (!set) { set = new Set(); listeners.set(sessionId, set) }
      set.add(res)
      const keepAlive = setInterval(() => { try { res.write(': ping\n\n') } catch { /* closed */ } }, 25000)
      const cleanup = () => {
        clearInterval(keepAlive)
        const current = listeners.get(sessionId)
        if (current) { current.delete(res); if (!current.size) listeners.delete(sessionId) }
      }
      req.on('close', cleanup)
      res.on('close', cleanup)
    },
  }), 'mixbox-palette: ops stream route')

  /**
   * Wake the agent of one session to look at the canvas.
   *
   * The panel decides when (its inbox threshold), this route only relays: the model
   * is asked to call `canvas_look`, not handed pixels, so the look stays a normal
   * tool call in the log.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: NUDGE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'method' }); return }
      let payload
      try {
        payload = JSON.parse((await readBody(req)).toString('utf8'))
      } catch {
        json(res, 400, { ok: false, reason: 'bad-json' })
        return
      }
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      const agent = sessionId ? agentFor(sessionId) : undefined
      if (!agent) { json(res, 200, { ok: false, reason: 'no-agent' }); return }
      const stats = payload?.stats && typeof payload.stats === 'object' ? payload.stats : {}
      const strokes = Number(stats.strokes) || 0
      const change = Number(stats.change) || 0
      const text = `画布有新内容：${strokes} 笔新笔触，画面变化约 ${change}%。`
        + ' 调用 canvas_look 看一眼当前画面，然后用一两句话点评：指出一个具体问题，或肯定一个具体做法。'
        + ' 不要复述你在这次对话里已经说过的内容；如果用户此刻不像是想要反馈，就只回一句最要紧的。'
      // `role` is not optional here: the request serializer reads it straight off
      // the message, so a role-less message reaches the provider as
      // `{"content":[...]}` and every later request fails with
      // `messages[N]: missing field role` (INVALID_REQUEST). The id keeps two
      // pending nudges from colliding as two messages without identity.
      const message = {
        role: 'user',
        id: globalThis.crypto.randomUUID(),
        content: [{ type: 'text', text }],
        source: { kind: 'mpx-canvas', form: 'notice' },
      }
      try {
        agent.followup(message)
      } catch (error) {
        try {
          agent.followup({ role: 'user', id: globalThis.crypto.randomUUID(), content: message.content, source: { kind: 'user' } })
        } catch (retryError) {
          json(res, 200, {
            ok: false,
            reason: 'followup-failed',
            message: String(retryError && retryError.message || retryError || error),
          })
          return
        }
      }
      json(res, 200, { ok: true })
    },
  }), 'mixbox-palette: canvas nudge route')

  /**
   * Answer one pixel probe the panel executed.
   *
   * `canvas_sample` sends a `sample` op down the event stream and waits here; only the
   * panel can read exact canvas pixels, the host snapshot is a lossy downscale.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SAMPLE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'method' }); return }
      let payload
      try {
        payload = JSON.parse((await readBody(req)).toString('utf8'))
      } catch {
        json(res, 400, { ok: false, reason: 'bad-json' })
        return
      }
      const id = typeof payload?.id === 'string' ? payload.id : ''
      const resolve = id ? pendingSamples.get(id) : undefined
      if (resolve) resolve(payload?.colors)
      json(res, 200, { ok: true, matched: Boolean(resolve) })
    },
  }), 'mixbox-palette: canvas sample route')

  /**
   * Answer one "strokes are painted" receipt.
   *
   * Strokes now paint across animation frames, so `canvas_draw` dispatches a
   * `flush-ack` op and waits here for the panel to report the finished picture.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DONE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'method' }); return }
      let payload
      try {
        payload = JSON.parse((await readBody(req)).toString('utf8'))
      } catch {
        json(res, 400, { ok: false, reason: 'bad-json' })
        return
      }
      const id = typeof payload?.id === 'string' ? payload.id : ''
      const resolve = id ? pendingDone.get(id) : undefined
      if (resolve) resolve()
      json(res, 200, { ok: true, matched: Boolean(resolve) })
    },
  }), 'mixbox-palette: canvas done route')

  /**
   * Relay the user's own message about the painting, with the canvas attached.
   *   * The panel owns the text box; this route turns it into an ordinary user turn so the
   * picture arrives with the words instead of costing a separate `canvas_look` call.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ASK_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'method' }); return }
      let payload
      try {
        payload = JSON.parse((await readBody(req)).toString('utf8'))
      } catch {
        json(res, 400, { ok: false, reason: 'bad-json' })
        return
      }
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      const text = typeof payload?.text === 'string' ? payload.text.trim().slice(0, 4000) : ''
      if (!text) { json(res, 400, { ok: false, reason: 'empty-text' }); return }
      const agent = sessionId ? agentFor(sessionId) : undefined
      if (!agent) { json(res, 200, { ok: false, reason: 'no-agent' }); return }

      const content = [{ type: 'text', text }]
      let attached = false
      const entry = snapshots.get(sessionId)
      const attachments = ctx.get('attachments')
      const parsed = entry ? parseDataUrl(entry.png) : undefined
      if (parsed && attachments) {
        try {
          const ref = await attachments.saveImage({ data: parsed.bytes, mediaType: parsed.mediaType, name: 'canvas.webp' })
          content.push({ type: 'image', attachment: ref })
          attached = true
        } catch (error) {
          // A missing image must not swallow the user's message.
          ctx.logger?.warn?.(`canvas ask: attachment refused (${String(error && error.message || error)})`)
        }
      }
      try {
        agent.followup({
          role: 'user',
          id: globalThis.crypto.randomUUID(),
          content,
          source: { kind: 'user' },
        })
      } catch (error) {
        json(res, 200, {
          ok: false,
          reason: 'followup-failed',
          message: String(error && error.message || error),
        })
        return
      }
      json(res, 200, { ok: true, attached })
    },
  }), 'mixbox-palette: canvas ask route')

  /**
   * Hand the panel the last snapshot this host knows, so a fresh origin (a new port
   * after a restart) can seed its canvas instead of starting empty.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: LAST_PATH,
    handler: async (req, res) => {
      const url = new URL(req.url ?? LAST_PATH, 'http://127.0.0.1')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (!sessionId) { json(res, 400, { ok: false, reason: 'no-session' }); return }
      const entry = snapshots.get(sessionId) ?? await readPersisted(sessionId)
      if (!entry) { json(res, 200, { ok: false, reason: 'none' }); return }
      snapshots.set(sessionId, entry)
      json(res, 200, { ok: true, png: entry.png, meta: entry.meta ?? null, at: entry.at })
    },
  }), 'mixbox-palette: last snapshot route')

  /**
   * Report where this host persists snapshots.
   *
   * Path resolution depends on launcher-provided environment variables, so the panel
   * (and a human) can read the resolved answer instead of guessing.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DEBUG_PATH,
    handler: async (req, res) => {
      json(res, 200, {
        ok: true,
        home: HARNESS_HOME,
        stateDir: STATE_DIR,
        legacyStateDir: LEGACY_STATE_DIR ?? null,
        env: {
          DSH_HOME: process.env.DSH_HOME ?? null,
          DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR ?? null,
        },
        cwd: process.cwd(),
        sessions: [...snapshots.keys()],
        maxFiles: MAX_STATE_FILES,
        maxSnapshotChars: MAX_SNAPSHOT_CHARS,
      })
    },
  }), 'mixbox-palette: state debug route')

  /**
   * Send drawing operations to the panel of one session.
   * @param {string} sessionId - target session.
   * @param {unknown[]} ops - operations to apply.
   * @returns {boolean} whether an open panel received them.
   */
  function dispatch(sessionId, ops) {
    const set = listeners.get(sessionId)
    if (!set || set.size === 0) return false
    const frame = `event: ops\ndata: ${JSON.stringify({ ops })}\n\n`
    let delivered = false
    for (const res of set) {
      try { res.write(frame); delivered = true } catch { /* closed */ }
    }
    return delivered
  }

  /**
   * Resolve the snapshot of the calling agent's session, falling back to the copy on disk.
   * @param {{ agent?: { session?: { id?: string } } }} exec - tool execution context.
   * @returns {Promise<{ sessionId: string, entry: { png: string, meta: unknown, at: number }, stale: boolean } | undefined>} the snapshot.
   */
  async function snapshotFor(exec) {
    const sessionId = exec?.agent?.session?.id
    if (!sessionId) return undefined
    let entry = snapshots.get(sessionId)
    if (!entry) {
      entry = await readPersisted(sessionId)
      if (entry) snapshots.set(sessionId, entry)
    }
    if (!entry) return undefined
    return { sessionId, entry, stale: Date.now() - entry.at > 120000 }
  }

  ctx.inject(['tools'], (scope) => {
    scope.tools.register({
      name: 'canvas_look',
      description: 'See the user painting canvas: returns the current picture plus its pixel size, brush, palette and colours. Call this whenever the user refers to what they painted, and before advising on the painting.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          const blocks = [{ type: 'text', text: value.text }]
          if (value.image) blocks.push({ type: 'image', attachment: value.image })
          return blocks
        },
      },
      async execute(_args, exec) {
        const found = await snapshotFor(exec)
        if (!found) {
          const sessionId = exec?.agent?.session?.id
          return { text: sessionId ? CARD_TEXT.notOpen : CARD_TEXT.noSession }
        }
        const { entry } = found
        const parsed = parseDataUrl(entry.png)
        if (!parsed) return { text: 'The canvas snapshot on the host is unreadable; ask the user to redraw one stroke or reopen the panel.' }
        const meta = (entry.meta && typeof entry.meta === 'object') ? entry.meta : {}
        const canvas = meta.canvas && typeof meta.canvas === 'object' ? meta.canvas : {}
        const width = Number(canvas.width) || 0
        const height = Number(canvas.height) || 0
        const attachments = scope.get('attachments')
        if (!attachments) {
          return {
            text: `${CARD_TEXT.noAttachments}\n\nCanvas: ${width}x${height}px. State: ${JSON.stringify(meta)}`,
          }
        }
        const ref = await attachments.saveImage({ data: parsed.bytes, mediaType: parsed.mediaType, name: 'canvas.webp' })
        const scaledX = width && ref.width ? width / ref.width : 1
        const scaledY = height && ref.height ? height / ref.height : 1
        const lines = [
          '<path>canvas</path>',
          `<canvas>${width}x${height} px</canvas>`,
          `<image>${ref.width}x${ref.height} px</image>`,
        ]
        if (found.stale) {
          lines.push(`<snapshot>saved ${new Date(found.entry.at).toISOString()}; the panel may be closed, so this is the last picture this host has</snapshot>`)
        }
        if (ref.width !== width || ref.height !== height) {
          lines.push(`<scale>x ${scaledX.toFixed(3)}, y ${scaledY.toFixed(3)} (multiply coordinates measured on the picture by these to get canvas coordinates)</scale>`)
        }
        lines.push(`<state>${JSON.stringify(meta)}</state>`)
        lines.push('Canvas coordinates span the full canvas: x from 0 to the canvas width, y from 0 to the canvas height, origin at the top-left.')
        return { text: lines.join('\n'), image: ref }
      },
    })

    scope.tools.register({
      name: 'canvas_state',
      description: 'Read the user painting canvas state (size, brush, palette, colours, undo position) without sending a picture. Cheaper than canvas_look.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: value.text }] },
      },
      async execute(_args, exec) {
        const found = await snapshotFor(exec)
        if (!found) return { text: exec?.agent?.session?.id ? CARD_TEXT.notOpen : CARD_TEXT.noSession }
        return { text: JSON.stringify(found.entry.meta ?? {}, null, 2) }
      },
    })

    scope.tools.register({
      name: 'canvas_draw',
      description: 'Paint on the user painting canvas through the same pigment-mixing pipeline the user paints with, or undo / redo / clear. Coordinates are canvas pixels, matching the size canvas_look reports. Every change enters the user undo stack.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['undo', 'redo', 'clear'],
            description: 'Run one canvas action instead of painting strokes.',
          },
          strokes: {
            type: 'array',
            description: 'Strokes to paint, in order.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['points'],
              properties: {
                points: {
                  type: 'array',
                  description: 'Path points; each is [x, y] or [x, y, pressure] with pressure 0-1. Pressure applies when the panel pen-pressure switch is on, or when the stroke sets usePressure.',
                  items: { type: 'array', items: { type: 'number' } },
                },
                usePressure: { type: 'boolean', description: 'Use the per-point pressures even when the panel pen-pressure switch is off. Tapers the stroke by the pressure values.' },
                color: { type: 'string', description: 'Hex colour such as #3355cc; defaults to the current foreground colour.' },
                size: { type: 'number', description: 'Brush size in pixels; defaults to the current brush size.' },
                strength: { type: 'number', description: 'Paint concentration 1-100 for this stroke; defaults to the panel slider. 100 lays solid pigment, 20 is mostly a stain.' },
                wetness: { type: 'number', description: 'Paper wetness 0-100 for this stroke; defaults to the panel slider. 100 bleeds hard, 0 keeps the edge tight.' },
                brushType: { type: 'string', description: 'Brush texture: watercolor, dry, splatter, circle, soft or flat; defaults to the current brush.' },
                tool: { type: 'string', enum: ['brush', 'smudge'], description: 'brush paints pigment (default); smudge pulls the existing colour along the path.' },
              },
            },
          },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: value.text }] },
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.session?.id
        if (!sessionId) return { text: CARD_TEXT.noSession }

        const action = typeof args?.action === 'string' ? args.action : ''
        if (action) {
          if (!['undo', 'redo', 'clear'].includes(action)) return { text: `Unknown action "${action}".` }
          if (!dispatch(sessionId, [{ type: action }])) return { text: CARD_TEXT.notOpen }
          const said = action === 'undo' ? 'Undid one step.' : action === 'redo' ? 'Redid one step.' : 'Cleared the canvas.'
          return { text: `${said} Call canvas_look if you need the new picture.` }
        }

        const strokes = Array.isArray(args?.strokes) ? args.strokes : []
        if (!strokes.length) return { text: 'Nothing to do: pass strokes, or an action of undo, redo or clear.' }
        const ops = strokes.map((stroke) => ({
          type: 'stroke',
          tool: stroke?.tool === 'smudge' ? 'smudge' : 'brush',
          points: stroke?.points ?? [],
          color: stroke?.color,
          size: stroke?.size,
          strength: stroke?.strength,
          wetness: stroke?.wetness,
          usePressure: stroke?.usePressure,
          brushType: stroke?.brushType,
        }))
        const id = `draw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const finished = new Promise((resolve) => {
          // Generous wait: strokes paint one at a time with a pause between them, so a
          // full batch legitimately takes seconds. A client without the ack still gives
          // up early rather than stalling the tool.
          const timer = setTimeout(() => { pendingDone.delete(id); resolve(false) }, 20000)
          pendingDone.set(id, () => { clearTimeout(timer); pendingDone.delete(id); resolve(true) })
        })
        if (!dispatch(sessionId, [...ops, { type: 'flush-ack', id }])) {
          pendingDone.delete(id)
          return { text: CARD_TEXT.notOpen }
        }
        const acked = await finished
        const smudges = ops.filter((op) => op.tool === 'smudge').length
        const painted = ops.length - smudges
        const parts = []
        if (painted) parts.push(`${painted} brush stroke(s)`)
        if (smudges) parts.push(`${smudges} smudge stroke(s)`)
        const tail = acked
          ? 'The canvas is updated; canvas_look shows the finished result.'
          : 'Still painting; call canvas_look in a moment for the finished result.'
        return { text: `Applied ${parts.join(' and ')}. ${tail} The user can undo them.` }
      },
    })

    scope.tools.register({
      name: 'canvas_sample',
      description: 'Read the exact colour of one or more canvas pixels. Use it instead of guessing colours from the picture: [x, y] in canvas pixels, returns #RRGGBB and rgb for each point.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['points'],
        properties: {
          points: {
            type: 'array',
            description: 'Points to sample, each [x, y] in canvas pixels.',
            items: { type: 'array', items: { type: 'number' } },
          },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: value.text }] },
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.session?.id
        if (!sessionId) return { text: CARD_TEXT.noSession }
        const points = Array.isArray(args?.points) ? args.points.slice(0, 24) : []
        if (!points.length) return { text: 'No points were given.' }
        const id = `sample-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const pending = new Promise((resolve) => {
          const timer = setTimeout(() => { pendingSamples.delete(id); resolve(undefined) }, 3000)
          pendingSamples.set(id, (colors) => { clearTimeout(timer); pendingSamples.delete(id); resolve(colors) })
        })
        if (!dispatch(sessionId, [{ type: 'sample', id, points }])) {
          pendingSamples.delete(id)
          return { text: CARD_TEXT.notOpen }
        }
        const colors = await pending
        if (!Array.isArray(colors) || !colors.length) {
          return { text: 'The panel did not return the sample in time. Ask the user to keep the canvas panel open and try again.' }
        }
        const lines = colors.map((color) => `(${color.x}, ${color.y}) → ${color.hex} rgb(${color.rgb.join(', ')})`)
        return { text: `Canvas pixels:\n${lines.join('\n')}` }
      },
    })
  })

  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({ name: 'ui:mixbox-palette-canvas', order: 820, text: CANVAS_PROMPT })
  })

  ctx.on('dispose', () => {
    for (const set of listeners.values()) {
      for (const res of set) { try { res.end() } catch { /* closed */ } }
    }
    listeners.clear()
    snapshots.clear()
  })
}
