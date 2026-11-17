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
 *   POST /mpx/canvas/render  { sessionId, id, png }   <- a glance or a zoom
 */

const PUSH_PATH = '/mpx/canvas/push'
const STREAM_PATH = '/mpx/canvas/stream'
const NUDGE_PATH = '/mpx/canvas/nudge'
const ASK_PATH = '/mpx/canvas/ask'
const SAMPLE_PATH = '/mpx/canvas/sample'
const DONE_PATH = '/mpx/canvas/done'
const RENDER_PATH = '/mpx/canvas/render'
const LAST_PATH = '/mpx/canvas/last'
const DEBUG_PATH = '/mpx/canvas/debug'

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Retention for the on-disk snapshots. One file per session, overwritten in place, so
// a painting never grows; only the number of sessions can grow, and that is capped.
const MAX_STATE_FILES = 16
const MAX_STATE_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_SNAPSHOT_CHARS = 4 * 1024 * 1024
const MAX_MEMORY_SNAPSHOTS = 24
/** How long a glance or a zoom waits for the panel to paint one out. */
const RENDER_TIMEOUT_MS = 6000
/** Pushes arriving this soon after the agent's own strokes are its own wet paint settling. */
const OWN_DRAW_GRACE_MS = 2500
/**
 * The shared painting memory: a small directory of Markdown notes.
 *
 * One file per topic, so a session loads the index (cheap) and then only the note it
 * needs. Every session reads and writes the same directory, which is how one
 * conversation's hard-won lesson reaches the next one.
 */
const NOTE_MAX_CHARS = 2400
const NOTES_MAX_TOTAL = 12000
const NOTE_SEEDS = {
  'brushes.md': [
    '# 笔刷与参数',
    '',
    '- 选笔先看用途：氛围 → `watercolor`（浓度 100 / 湿度 100）；清晰造型 → `circle`、`soft`；线稿 → `flat` 小 size + `spacing` 1 + 浓度 75~90（像铅笔）；纹理 → `splatter`、`dry`。',
    '- `watercolor` 是氛围笔：浓度 100 + 湿度 100 才是它该有的样子，湿 20 只会变干涩斑驳。',
    '- `dry` 是"同样纹理但不带水彩效果"的干笔；`splatter` 做喷溅纹理。',
    '- 只有 `circle`/`flat`/`soft` 是实色不透明；水彩白压深永远是灰的。',
    '- 宽度：水彩/干笔/喷溅 ≈ 2×size；`circle`/`flat`/`soft` ≈ 1×size。',
    '- 选笔前先 `canvas_brushes` 看一眼引擎自己画的样张，别猜。',
    '- `wetness` 只管边缘扩散多远，不管深浅；要深靠浓度和叠笔。',
  ].join('\n'),
  'composition.md': [
    '# 构图与步骤',
    '',
    '- 先大色块，再轮廓，最后细节和高光。',
    '- 重画一遍通常比在旧稿上补丁更快：叠多了会发糊。',
    '- chibi 的可爱度靠头身比，头占画面一半以上就对了。',
  ].join('\n'),
  'mistakes.md': [
    '# 踩过的坑',
    '',
    '- 用皮肤色盖回眼线会把眼睛上缘切平，看着眯眼——宁可从整只眼睛重画。',
    '- 白色颜料能盖住深色，修外轮廓的鼓包可行，但会留下比纸略冷的白。',
    '- 撤销之后必须重新 glance 一次才能落笔（守卫规则）。',
  ].join('\n'),
}

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
const NOTES_DIR = join(HARNESS_HOME, 'canvas-notes')
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
  'You have three ways to look, at three prices. `canvas_glance` returns the whole canvas as a thumbnail (cheapest: see where things are). `canvas_zoom` returns one rectangle of it, enlarged, named by two points in fractions of the canvas — `from [0.2, 0.3] to [0.45, 0.55]` — so you read them straight off a glance without converting pixels (a detail for the price of the crop). `canvas_look` returns the whole canvas at full size plus its pixel size and the current brush, palette, and colours (most expensive: use it when colour or exact edges matter, and before you advise on the painting).',
  '- `canvas_state` returns the same facts without a picture; use it for cheap follow-ups. It is not a look: it never shows you the picture.',
  '- `canvas_draw` paints one or more strokes onto the canvas. Points are canvas pixels by default, or 0-1 fractions of the canvas when the stroke sets `unit: "ratio"` (the same space you measure on a glance). Every stroke lands in the user undo stack, so the user can discard it.',
  'You cannot paint blind: `canvas_draw` refuses strokes until you have looked at the whole canvas in this session, and refuses again if the canvas changed since that look (the user painted, undid, cleared, or the panel reloaded). After a refusal, look (a glance is enough), then draw. If a draw is refused, never retry it unchanged: look first.',
  'Each stroke takes its own colour, size, strength (how much pigment), wetness (how far it bleeds), spacing (how densely the brush stamps), brushType, and optionally `usePressure`; the same tool also carries the `smudge` tool and the `undo`/`redo`/`clear` actions. `size` is the half-width for the wash and texture brushes (watercolor, dry, splatter), so those spread about twice the number, while circle, flat and soft paint about one `size` wide.',
  'Keep one `canvas_draw` call to a handful of strokes (about eight). A call that is long or wide enough to be mangled costs the whole batch; several small calls paint in sequence and one failure costs only its own strokes. A stroke may send its path as the compact string `"0.36,0.60 0.37,0.65"` instead of nested arrays, which is sturdier for long paths.',
  'Draw curves as curves: `path: "0.30,0.40 q 0.50,0.10 0.70,0.40"` is one arc (control point, then the end point), and `c` takes two controls; loose points are smoothed into a curve automatically, so a hair lock or a tail is three or four points, not a dense polyline. `taper: "out"` writes the pressure ramp for you — pressure narrows the mark and pales it at the same time, and only you can say whether that suits the shape.',
  'A shape can be a shape, not a pile of rows: `ellipse: [cx, cy, rx, ry]` fills one in a single stroke with a smooth rim, `ring: true` outlines it, `from`/`to` angles make it an arc, and `polygon: [[x, y], …]` fills any outline you have painted around. `mirror: "x"` paints the stroke and its reflection about the canvas centre line, so a pair of eyes, ears or hair locks comes out symmetrical in one call.',
  'Depth comes from strength and from painting the same area twice, not from wetness: at strength 20 a stroke is barely a stain, at 77 about 60% of the pigment lands, and only near 100 does the colour read as itself. Wetness governs how far the edge travels (100 bleeds openly, 20 keeps a tight edge), so lower it to sharpen a shape rather than to darken it — and for the watercolour brush, whose own default is wetness 100, a low value is a deliberate dry-and-patchy choice, not the way to get solid colour.',
  'Choose the brush by the job, and set its parameters before the path: `watercolor` is the atmosphere brush — washes, mood, background, soft masses — at its own default strength 100 / wetness 100; `circle` and `soft` are the clean-shape brushes, solid and opaque, for anything that must read as itself; `flat` is flat blocks at strength 100 but draws like a pencil at a small size with `spacing` 1 and strength 75-90, which is the brush for line art and hatching; `splatter` sprays grain, and `dry` splits like a dry 毛笔 — forked bristles, coarse and rough, a texture you reach for rarely. Two things no setting changes: a watercolour white over dark stays grey however many passes it gets, and circle/flat/soft cannot make a wash. Call `canvas_brushes` once before choosing brushes for a new painting instead of guessing — it returns a labelled swatch sheet painted by this engine, plus the same table.',
  'Build every shape first with full-pressure strokes, then decide where a point or a fade belongs: a water tendril, a fin tip, the tail of a line. On this engine low pressure lowers pigment deposit as well as width, so the same knob that narrows a stroke also pales it. What that costs you is a judgement call — 0.8 down to 0.35 still reads as a point, 0.95 down to 0.05 reads as a scratch, and a whole silhouette drawn with tapered strokes comes out pale and weak. Experiment on a corner of the canvas rather than assuming.',
  'Pressure responds on a curve (pressureCurve): linear is even and slightly mechanical, soft eases in and out, firm holds the width and tapers late, ink thins early for a brush-like tail. Pick the curve before the numbers; a tendril usually reads best with soft from 0.85 to 0.3.',
  'When the user asks for help with painting, look first, then name one concrete problem at a time and demonstrate with a single short stroke rather than a long description.',
  'The panel may start a turn for you when it decides the painting changed enough. Treat such a turn as an invitation to look and say one useful sentence, not as a prompt to describe the whole canvas again.',
  `There is a shared painting memory at ${NOTES_DIR} — a directory of Markdown notes earlier sessions wrote about exactly this pipeline. Load it progressively: \`canvas_notes\` with no arguments returns the index (one line per note, cheap), then \`action: "read", file: …\` returns just the note you need. Check the relevant note before a new painting, and append the line that would have saved you a repaint: one conclusion per line, and delete what is no longer true, because the whole directory has a hard size cap.`,
  'If a canvas tool reports that no canvas is open, say so and suggest opening the 肥鱼画室 panel instead of guessing what is on it.',
].join(' ')

const CARD_TEXT = {
  noSession: 'No agent session is attached to this call, so there is no canvas to read.',
  notOpen: 'No canvas is open for this session. Ask the user to open the 肥鱼画室 panel from the 画室 entry at the foot of the left sidebar, then try again.',
  noAttachments: 'This deployment has no attachment store, so the canvas image cannot be handed to the model. The canvas state is still available through canvas_state.',
}

/** The swatch sheet that ships with the bundle, resolved next to this module. */
const BRUSH_SHEET_URL = new URL('./docs/brushes.png', import.meta.url)

/**
 * Job first, brush second: which brush to reach for, the settings that make it work, and
 * the width each one paints (measured on the real engine, km, navy on paper). A model
 * that assumes every brush is opaque paints white over dark and gets grey.
 */
const BRUSH_GUIDE = [
  '| brushType | reach for it when | its settings | the mark |',
  '| --- | --- | --- | --- |',
  '| `circle` | a shape that has to read as itself | strength 100, low wetness | solid, opaque, crisp edge — full colour at any size |',
  '| `soft` | the same clean shape, with a soft edge | strength 100 | solid core, blurred rim |',
  '| `flat` | flat blocks; pencil line art | 100 for blocks; for a graphite line a small size with `spacing` 1 and strength 75-90 | solid with chiselled ends, or a fine graphite line |',
  '| `watercolor` | atmosphere: washes, mood, background, soft masses | **strength 100 + wetness 100** (its own panel default) | pale, bleeds, the edge pools and drifts |',
  '| `dry` | a dry brush 毛笔: split, forking bristles, deliberately rough — a rare texture, not a workhorse | strength 100, low wetness | broken hairs with white gaps |',
  '| `splatter` | texture: spray, speckle, dust | strength 100 | dots, no solid core |',
  '| `smudge` (tool) | blending pigment that is already down | — | drags colour along the path |',
  '',
  'Job first, brush second: atmosphere → watercolor; a form that must stay crisp → circle or soft; line art and hatching → flat with a small size, `spacing` 1 and strength 75-90 (it then draws like a pencil); grain and sparkle → splatter; `dry` is the dry-brush 毛笔 for a split, coarse, gritty texture and it is rarely the right choice. Two things no setting changes: a watercolor white over dark stays grey however many passes it gets, and circle/flat/soft cannot make a wash. Width: circle/flat/soft paint about 1 x size, watercolor/dry/splatter about 2 x size.',
].join('\n')

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
  /** @type {Map<string, (payload: { png?: string }) => void>} */
  const pendingRenders = new Map()
  /**
   * The picture each session's agent last looked at whole, as a content hash.
   *
   * A draw compares this against the snapshot on the host: equal means the model is
   * painting the canvas it actually saw, unequal means someone else changed it since
   * (the user painted, undid, cleared, or the panel restored a different picture) and
   * the stroke would land blind.
   * @type {Map<string, string>}
   */
  const lastSeen = new Map()

  /**
   * When this agent last finished painting, per session.
   *
   * The panel pushes once more a few hundred milliseconds after a batch while the wet
   * paint settles; that push is our own work, so it refreshes the seen stamp instead of
   * locking the model out of its next batch.
   * @type {Map<string, number>}
   */
  const ownDrawAt = new Map()

  /**
   * Content hash of one snapshot, memoised on the entry.
   * @param {{ png?: string, stamp?: string } | undefined} entry - a snapshot entry.
   * @returns {string | undefined} the hash, or undefined for no entry.
   */
  function stampOf(entry) {
    if (!entry || typeof entry.png !== 'string') return undefined
    if (!entry.stamp) entry.stamp = createHash('sha1').update(entry.png).digest('hex')
    return entry.stamp
  }

  /**
   * Refuse a draw that would land on a picture the model has not seen.
   *
   * The model may paint only the canvas it last looked at whole: never one it has not
   * looked at at all (a fresh session, or after the panel reloaded), and never one that
   * changed underneath it (the user painted, undone, cleared, or the panel restored a
   * different picture). The refusal is cheap and explicit, so the fix is obvious: look,
   * then draw.
   * @param {string} sessionId - target session.
   * @returns {string | undefined} refusal text, or undefined when painting is safe.
   */
  function drawGuardText(sessionId) {
    const entry = snapshots.get(sessionId)
    if (!entry) return CARD_TEXT.notOpen
    const seen = lastSeen.get(sessionId)
    if (!seen) {
      return 'Not painted: you have not looked at this canvas in this session. Call canvas_glance (a cheap thumbnail) or canvas_look first, then send the strokes again — otherwise you would be painting a picture you have never seen.'
    }
    if (stampOf(entry) !== seen) {
      const seconds = Math.max(1, Math.round((Date.now() - (entry.at || Date.now())) / 1000))
      return `Not painted: the canvas changed since your last look — the picture on the host now is ${seconds}s old and is not the one you saw. Call canvas_glance or canvas_look again, then send the strokes again.`
    }
    return undefined
  }

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
      const paintedAt = ownDrawAt.get(sessionId) || 0
      if (Date.now() - paintedAt <= OWN_DRAW_GRACE_MS) lastSeen.set(sessionId, stampOf(entry))
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
   * Answer one glance or zoom the panel painted out.
   *
   * The panel renders these on demand (shrunk whole canvas, or one enlarged crop) and
   * posts the picture back here; the waiting tool hands it to the model.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RENDER_PATH,
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
      const resolve = id ? pendingRenders.get(id) : undefined
      if (resolve) resolve({ png: payload?.png })
      json(res, 200, { ok: true, matched: Boolean(resolve) })
    },
  }), 'mixbox-palette: canvas render route')

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
   * Ask the open panel to paint a picture out right now.
   *
   * Only the panel can render: a glance is the whole canvas shrunk, a zoom is one crop
   * enlarged. The host's stored snapshot is always the same size, so it can serve
   * neither.
   * @param {string} sessionId - target session.
   * @param {{ maxWidth?: number, crop?: { x: number, y: number, width: number, height: number } }} spec - what to render.
   * @returns {Promise<{ png: string } | undefined>} the rendered data URL, or undefined.
   */
  async function renderFromPanel(sessionId, spec) {
    const id = `render-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const waiting = new Promise((resolve) => {
      const timer = setTimeout(() => { pendingRenders.delete(id); resolve(undefined) }, RENDER_TIMEOUT_MS)
      pendingRenders.set(id, (payload) => { clearTimeout(timer); pendingRenders.delete(id); resolve(payload) })
    })
    if (!dispatch(sessionId, [{ type: 'render', id, ...spec }])) {
      pendingRenders.delete(id)
      return undefined
    }
    const payload = await waiting
    if (!payload || typeof payload.png !== 'string' || !parseDataUrl(payload.png)) return undefined
    return payload
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
      description: 'See the whole canvas at full size: the picture plus its pixel size, brush, palette and colours. The most expensive look — canvas_glance is the cheap thumbnail and canvas_zoom is one enlarged crop. Call it whenever the user refers to what they painted, and before advising on the painting; a glance is enough before drawing.',
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
        lastSeen.set(found.sessionId, stampOf(entry))
        return { text: lines.join('\n'), image: ref }
      },
    })

    /**
     * Hand one rendered picture to the model.
     * @param {{ png: string }} rendered - what the panel painted out.
     * @returns {Promise<{ width: number, height: number } | undefined>} the stored image.
     */
    async function storeRender(rendered) {
      const parsed = parseDataUrl(rendered?.png)
      const attachments = scope.get('attachments')
      if (!parsed || !attachments) return undefined
      return attachments.saveImage({ data: parsed.bytes, mediaType: parsed.mediaType, name: 'canvas.webp' })
    }

    scope.tools.register({
      name: 'canvas_glance',
      description: 'Cheap look at the whole canvas: the panel shrinks it to a thumbnail, so you see placement and the big shapes for a fraction of the tokens canvas_look costs. It also counts as having looked, so you may draw afterwards. Follow it with canvas_zoom when a detail matters.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          maxWidth: {
            type: 'number',
            description: 'Longest side of the thumbnail in pixels, 160-640. Defaults to 360.',
          },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          const blocks = [{ type: 'text', text: value.text }]
          if (value.image) blocks.push({ type: 'image', attachment: value.image })
          return blocks
        },
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.session?.id
        if (!sessionId) return { text: CARD_TEXT.noSession }
        const maxWidth = Math.max(160, Math.min(640, Math.round(Number(args?.maxWidth) || 360)))
        const rendered = await renderFromPanel(sessionId, { maxWidth })
        if (!rendered) {
          return { text: 'The panel did not paint a thumbnail back (it is closed, or still painting). Call canvas_look for the picture the host already holds, or ask the user to keep the 肥鱼画室 panel open.' }
        }
        const ref = await storeRender(rendered)
        if (!ref) return { text: CARD_TEXT.noAttachments }
        const entry = snapshots.get(sessionId)
        lastSeen.set(sessionId, stampOf(entry))
        const meta = entry?.meta && typeof entry.meta === 'object' ? entry.meta : {}
        const canvas = meta.canvas && typeof meta.canvas === 'object' ? meta.canvas : {}
        const width = Number(canvas.width) || 0
        const height = Number(canvas.height) || 0
        const lines = [
          '<path>canvas</path>',
          `<canvas>${width}x${height} px</canvas>`,
          `<glance>thumbnail ${ref.width}x${ref.height} px: placement and big shapes are reliable, a fine edge or an exact colour is not; call canvas_zoom on the region that matters</glance>`,
          `<state>${JSON.stringify(meta)}</state>`,
        ]
        if (width && ref.width) {
          lines.splice(2, 0, `<scale>x ${(width / ref.width).toFixed(3)}, y ${(height / ref.height).toFixed(3)} (multiply a coordinate measured on this picture by these to get canvas coordinates)</scale>`)
        }
        return { text: lines.join('\n'), image: ref }
      },
    })

    scope.tools.register({
      name: 'canvas_zoom',
      description: 'Look closely at one part of the canvas: the panel crops the rectangle between two points and returns it enlarged, so a detail costs tokens for the crop instead of the whole picture. The two points are fractions of the canvas (0 = left or top edge, 1 = right or bottom edge), so you can read them straight off a canvas_glance thumbnail without converting pixels, e.g. from [0.2, 0.3] to [0.45, 0.55]. Use it to check a face, an edge, or whether two colours actually meet.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to'],
        properties: {
          from: {
            type: 'array',
            items: { type: 'number' },
            description: 'One corner of the region as fractions of the canvas width and height: [0.2, 0.3] means 20% across and 30% down. Measured on the whole canvas, so a coordinate read off the thumbnail divides by the thumbnail width or height; no need to convert to canvas pixels.',
          },
          to: {
            type: 'array',
            items: { type: 'number' },
            description: 'The opposite corner, in the same fractions. The crop is the rectangle these two points span, so either may be the top-left one.',
          },
          maxWidth: {
            type: 'number',
            description: 'Longest side of the returned picture in pixels, 240-1200. Defaults to 640; a bigger number enlarges more.',
          },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          const blocks = [{ type: 'text', text: value.text }]
          if (value.image) blocks.push({ type: 'image', attachment: value.image })
          return blocks
        },
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.session?.id
        if (!sessionId) return { text: CARD_TEXT.noSession }
        const entry = snapshots.get(sessionId)
        const meta = entry?.meta && typeof entry.meta === 'object' ? entry.meta : {}
        const canvas = meta.canvas && typeof meta.canvas === 'object' ? meta.canvas : {}
        const canvasWidth = Number(canvas.width) || 0
        const canvasHeight = Number(canvas.height) || 0
        if (!canvasWidth || !canvasHeight) {
          return { text: 'The host does not know the canvas size yet, so these fractions cannot be turned into pixels. Call canvas_glance (or canvas_look) once, then zoom.' }
        }
        /** Clamp one fraction into the canvas. */
        const fraction = (value) => {
          const number = Number(value)
          return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0
        }
        const from = Array.isArray(args?.from) ? args.from : []
        const to = Array.isArray(args?.to) ? args.to : []
        if (from.length < 2 || to.length < 2) {
          return { text: 'canvas_zoom takes two points, each [x, y] as fractions of the canvas from 0 to 1, for example from [0.2, 0.3] to [0.45, 0.55]. Nothing was rendered.' }
        }
        const leftRatio = Math.min(fraction(from[0]), fraction(to[0]))
        const rightRatio = Math.max(fraction(from[0]), fraction(to[0]))
        const topRatio = Math.min(fraction(from[1]), fraction(to[1]))
        const bottomRatio = Math.max(fraction(from[1]), fraction(to[1]))
        const crop = {
          x: Math.min(Math.round(leftRatio * canvasWidth), canvasWidth - 1),
          y: Math.min(Math.round(topRatio * canvasHeight), canvasHeight - 1),
          width: Math.max(8, Math.round((rightRatio - leftRatio) * canvasWidth)),
          height: Math.max(8, Math.round((bottomRatio - topRatio) * canvasHeight)),
        }
        crop.width = Math.min(crop.width, canvasWidth - crop.x)
        crop.height = Math.min(crop.height, canvasHeight - crop.y)
        const maxWidth = Math.max(240, Math.min(1200, Math.round(Number(args?.maxWidth) || 640)))
        const rendered = await renderFromPanel(sessionId, { crop, maxWidth })
        if (!rendered) {
          return { text: 'The panel did not paint the crop back (it is closed, or still painting). Ask the user to keep the 肥鱼画室 panel open, or call canvas_look for the picture the host already holds.' }
        }
        const ref = await storeRender(rendered)
        if (!ref) return { text: CARD_TEXT.noAttachments }
        const lines = [
          '<path>canvas</path>',
          `<region>from (${leftRatio.toFixed(3)}, ${topRatio.toFixed(3)}) to (${rightRatio.toFixed(3)}, ${bottomRatio.toFixed(3)}) of the canvas</region>`,
          `<crop>x=${crop.x}, y=${crop.y}, w=${crop.width}, h=${crop.height} (canvas pixels)</crop>`,
          `<image>${ref.width}x${ref.height} px</image>`,
          `<scale>x ${(crop.width / ref.width).toFixed(3)}, y ${(crop.height / ref.height).toFixed(3)} (canvas x = ${crop.x} + x_on_image * scale_x, y = ${crop.y} + y_on_image * scale_y)</scale>`,
        ]
        return { text: lines.join('\n'), image: ref }
      },
    })

    scope.tools.register({
      name: 'canvas_state',
      description: 'Read the user painting canvas state (size, brush, palette, colours, undo position) without sending a picture. Cheaper than canvas_glance, but it does not count as having looked — use canvas_look or canvas_glance for that.',
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

    /** The swatch sheet bytes, read once from the bundle. @type {Buffer | undefined} */
    let brushSheetBytes

    scope.tools.register({
      name: 'canvas_brushes',
      description: 'How each brush type paints: a labelled swatch sheet rendered by this canvas engine, plus one line per brush on what the mark is and how wide it reaches. Costs one image, needs no open canvas and paints nothing. Call it once before choosing brushes for a new painting, or when a brush comes out different from what you expected.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          const blocks = [{ type: 'text', text: value.text }]
          if (value.image) blocks.push({ type: 'image', attachment: value.image })
          return blocks
        },
      },
      async execute() {
        const header = 'Brush swatches painted by this engine: colour #2a3557, strength 100, wetness as labelled, one stroke per bar. It is a fixed sample — use it to tell the brushes apart, not to predict one particular size.'
        const text = [header, '', BRUSH_GUIDE].join('\n')
        const attachments = scope.get('attachments')
        if (!attachments) return { text: `${text}\n\n${CARD_TEXT.noAttachments}` }
        if (!brushSheetBytes) {
          try {
            brushSheetBytes = await readFile(BRUSH_SHEET_URL)
          } catch (error) {
            return { text: `${text}\n\nThe bundled swatch sheet could not be read (${String(error && error.message || error)}); the table above still holds.` }
          }
        }
        try {
          const ref = await attachments.saveImage({ data: brushSheetBytes, mediaType: 'image/png', name: 'brushes.png' })
          return { text, image: ref }
        } catch (error) {
          return { text: `${text}\n\nThe swatch sheet could not be handed over (${String(error && error.message || error)}); the table above still holds.` }
        }
      },
    })

    /**
     * Make sure the notes directory exists and holds the seed notes.
     *
     * Seeds are written only when the directory has no notes at all, so a session that
     * deleted one seed does not have it resurrected under it.
     */
    async function ensureNotesDir() {
      try {
        await mkdir(NOTES_DIR, { recursive: true })
        const names = await readdir(NOTES_DIR)
        if (names.some((name) => name.endsWith('.md'))) return
      } catch {
        // fall through to writing the seeds
      }
      try {
        await mkdir(NOTES_DIR, { recursive: true })
        for (const [name, body] of Object.entries(NOTE_SEEDS)) {
          await writeFile(join(NOTES_DIR, name), `${body}\n`, 'utf8')
        }
      } catch (error) {
        ctx.logger?.warn?.(`canvas-notes: seeds failed (${String(error && error.message || error)})`)
      }
    }

    /**
     * Normalise a note name to a `something.md` file inside the notes directory.
     * @param {unknown} name - what the model asked for.
     * @returns {string} a safe file name, or '' when nothing usable was given.
     */
    const noteFileName = (name) => {
      const clean = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '-')
      if (!clean) return ''
      return clean.endsWith('.md') ? clean : `${clean}.md`
    }

    /** List the notes with their title, first line and size. */
    async function listNotes() {
      const names = (await readdir(NOTES_DIR)).filter((name) => name.endsWith('.md')).sort()
      const notes = []
      for (const name of names) {
        try {
          const body = await readFile(join(NOTES_DIR, name), 'utf8')
          const title = (/^#\s+(.*)$/m.exec(body)?.[1] ?? name.replace(/\.md$/, '')).trim()
          const first = body.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('#')) ?? ''
          notes.push({ name, title, first, chars: body.length })
        } catch {
          // a note that cannot be read is skipped rather than fatal
        }
      }
      return notes
    }

    /** Total size of the notes directory, in characters. */
    async function notesTotalChars() {
      const notes = await listNotes()
      return notes.reduce((total, note) => total + note.chars, 0)
    }

    scope.tools.register({
      name: 'canvas_notes',
      description: 'The shared painting memory: a directory of Markdown notes that earlier sessions wrote about this exact pipeline, so a new conversation inherits their experience. Load it progressively — call with no arguments for the index (one line per note, cheap), read only the note you need, and append the line that would have saved you a repaint. The directory has a hard size cap: when an append pushes it over, compress first (merge notes that say the same thing, drop conclusions that turned out wrong or stale) and write the shorter version back.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['index', 'read', 'append', 'replace', 'delete'],
            description: 'index (default) lists the notes cheaply; read returns one note in full; append adds a line to a note; replace overwrites a whole note; delete removes one.',
          },
          file: { type: 'string', description: 'Which note, e.g. "brushes" or "brushes.md". A new name creates a new note on append.' },
          text: { type: 'string', description: 'The Markdown to append, or the whole new body for replace. One conclusion per line.' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: value.text }] },
      },
      async execute(args) {
        await ensureNotesDir()
        const action = ['index', 'read', 'append', 'replace', 'delete'].includes(args?.action) ? args.action : 'index'
        const file = noteFileName(args?.file)
        const text = typeof args?.text === 'string' ? args.text.trim() : ''

        /**
         * Refuse a write that breaks the budget, and say how to get back under it.
         * @param {string} detail - what would be over the line.
         * @returns {Promise<{ text: string }>} the refusal, listing the notes and their sizes.
         */
        const overBudget = async (detail) => {
          const notes = await listNotes()
          const total = notes.reduce((sum, note) => sum + note.chars, 0)
          const listing = notes.map((note) => `- ${note.name}（${note.chars} 字）${note.title}`).join('\n')
          return {
            text: `超出预算：${detail}\n\n现在 ${notes.length} 篇共 ${total} 字（单篇上限 ${NOTE_MAX_CHARS}，总量上限 ${NOTES_MAX_TOTAL}）。\n先压缩再写：合并讲同一件事的笔记、删掉已经被推翻或过时的结论，用 replace 写回压缩版、用 delete 删掉该走的，然后重新 append 这一条。\n现有：\n${listing}`,
          }
        }

        if (action === 'index') {
          const notes = await listNotes()
          const total = notes.reduce((sum, note) => sum + note.chars, 0)
          if (!notes.length) return { text: '画布记忆还是空的。画完把结论 append 进来，下一篇会话就能继承。' }
          const lines = notes.map((note, index) => {
            const brief = note.first.length > 80 ? `${note.first.slice(0, 80)}…` : note.first
            return `${index + 1}. ${note.name} · ${note.title} — ${brief}（${note.chars} 字）`
          })
          return { text: `肥鱼画室·画布记忆（${notes.length} 篇，共 ${total}/${NOTES_MAX_TOTAL} 字）\n${lines.join('\n')}\n\n读一篇：canvas_notes { action: "read", file: "<名字>" }` }
        }

        if (action === 'read') {
          if (!file) return { text: 'read 需要 file：读哪一篇，比如 "brushes"。先看 index 也行。' }
          try {
            const body = await readFile(join(NOTES_DIR, file), 'utf8')
            return { text: `## ${file}\n${body.trim()}` }
          } catch {
            return { text: `没有这篇笔记：${file}。先看 index 里有哪些。` }
          }
        }

        if (action === 'append') {
          if (!file) return { text: 'append 需要 file：写进哪一篇，比如 "brushes"；新名字就是新建一篇。' }
          if (!text) return { text: 'append 需要 text：要写进笔记的那几行。' }
          let existing = ''
          try { existing = await readFile(join(NOTES_DIR, file), 'utf8') } catch { existing = `# ${file.replace(/\.md$/, '')}\n` }
          const addition = text.startsWith('-') ? text : `- ${text}`
          const next = `${existing.trimEnd()}\n${addition}\n`
          if (next.length > NOTE_MAX_CHARS) return overBudget(`这一篇会到 ${next.length} 字。`)
          const total = (await notesTotalChars()) - existing.length + next.length
          if (total > NOTES_MAX_TOTAL) return overBudget(`整份记忆会到 ${total} 字。`)
          await writeFile(join(NOTES_DIR, file), next, 'utf8')
          return { text: `已写进 ${file}（${next.length}/${NOTE_MAX_CHARS} 字，整份 ${total}/${NOTES_MAX_TOTAL} 字）。` }
        }

        if (action === 'replace') {
          if (!file) return { text: 'replace 需要 file：替换哪一篇。' }
          if (!text) return { text: 'replace 需要 text：这一篇的新全文。' }
          let existing = ''
          try { existing = await readFile(join(NOTES_DIR, file), 'utf8') } catch { existing = '' }
          if (text.length > NOTE_MAX_CHARS) return overBudget(`这一篇会到 ${text.length} 字。`)
          const total = (await notesTotalChars()) - existing.length + text.length
          if (total > NOTES_MAX_TOTAL) return overBudget(`整份记忆会到 ${total} 字。`)
          await writeFile(join(NOTES_DIR, file), `${text}\n`, 'utf8')
          return { text: `已替换 ${file}（${text.length}/${NOTE_MAX_CHARS} 字，整份 ${total}/${NOTES_MAX_TOTAL} 字）。` }
        }

        if (action === 'delete') {
          if (!file) return { text: 'delete 需要 file：删哪一篇。' }
          try {
            await unlink(join(NOTES_DIR, file))
            const total = await notesTotalChars()
            return { text: `已删除 ${file}。整份记忆现在 ${total}/${NOTES_MAX_TOTAL} 字。` }
          } catch {
            return { text: `没有这篇笔记：${file}。` }
          }
        }

        return { text: `Unknown action "${action}".` }
      },
    })

    scope.tools.register({
      name: 'canvas_draw',
      description: 'Paint on the user painting canvas through the same pigment-mixing pipeline the user paints with, or undo / redo / clear. Coordinates are canvas pixels, or 0-1 fractions of the canvas when every value is within 0-1 (measure those straight off a glance). Every change enters the user undo stack. Refuses strokes until you have looked at this session canvas, and again if the canvas changed since that look.',
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
              properties: {
                points: {
                  type: 'array',
                  description: 'Path points; each is [x, y] or [x, y, pressure] with pressure 0-1. Canvas pixels, unless every coordinate is within 0-1 (then they are read as fractions of the canvas) or the stroke sets unit. Give either points or path.',
                  items: { type: 'array', items: { type: 'number' } },
                },
                path: {
                  type: 'string',
                  description: 'The same path as one compact string, which is sturdier than nested arrays when a call is long: pairs separated by spaces, optional pressure after a colon, e.g. "0.36,0.60 0.37,0.65 0.40,0.70". A lone "q" or "c" makes the next two or three points a quadratic or cubic Bézier that starts at the point before it, e.g. "0.30,0.40 q 0.50,0.10 0.70,0.40" — one arc for four numbers instead of a dense polyline. Use instead of points.',
                },
                ellipse: {
                  type: 'array',
                  description: 'Fill an ellipse instead of sweeping a path: [cx, cy, rx, ry], in the same units as points (fractions of the canvas unless something is over 1). The host expands it into one spiral, so the rim stays smooth instead of scalloped by row caps. Needs size, which sets the spiral pitch. Add ring: true (or an from/to angle) to outline instead.',
                },
                ring: { type: 'boolean', description: 'With ellipse: draw the outline instead of filling it. The size is then the line width.' },
                from: { type: 'number', description: 'With ellipse: start angle in degrees (0 = right, clockwise). Giving from/to turns the ellipse into an arc; from 0 to 180 is the upper half.' },
                to: { type: 'number', description: 'With ellipse: end angle in degrees.' },
                polygon: {
                  type: 'array',
                  description: 'Fill a polygon instead of sweeping a path: [[x, y], …] with at least three vertices, in the same units as points. The host cuts it into horizontal bands, one stroke each, so a dress or a cheek patch fills in one call instead of many rows.',
                },
                seam: {
                  type: 'number',
                  description: 'With a filled ellipse: the angle in degrees (0 = right, clockwise) where the spiral\'s inner tail ends. The stroke already finishes inside the fill (it runs on along the rim, then tucks back in) so no cap sticks out of the contour; this only chooses where, if you care which side the hidden overlap sits on.',
                },
                jitter: {
                  type: 'number',
                  description: 'Pixels of random wobble added to a generated shape path (0-20). A spiral rim and parallel bands come out mechanically even; a little jitter restores the hand-made edge. Leave it off for a crisp anime line.',
                },
                mirror: {
                  type: 'string',
                  enum: ['x', 'y'],
                  description: 'Paint the stroke twice, the second time reflected about the canvas centre line: "x" flips it left-right, "y" up-down. Half the work for a symmetrical pair — eyes, ears, hair locks — and the two sides cannot drift apart.',
                },
                smooth: {
                  type: 'boolean',
                  description: 'Round the points into a curve (Chaikin subdivision). On by default for three or more points, so a few loose points read as an arc rather than a zigzag; set false to keep a corner sharp. Paths that already use q or c are left alone.',
                },
                taper: {
                  type: 'string',
                  enum: ['in', 'out', 'both'],
                  description: 'Write a pressure ramp for you: a soft fade from 1 to 0.3 across the last (or first) part of the path, with the soft curve. It narrows the mark and lowers its deposit together; whether that reads as a point, a fade or a mistake depends on the shape, so treat it as a tool to try rather than a rule.',
                },
                unit: {
                  type: 'string',
                  enum: ['pixels', 'ratio'],
                  description: 'Optional, and usually unnecessary: coordinates with every value within 0-1 are read as fractions of the canvas automatically, anything larger as canvas pixels. Set "pixels" or "ratio" only to force it.',
                },
                usePressure: { type: 'boolean', description: 'Use the per-point pressures even when the panel pen-pressure switch is off. Pressure narrows the stroke and lowers pigment deposit at the same time, so the same value can read as a taper, a fade, or a thin pale line depending on the rest of the stroke — try it and look at what it gives.' },
                pressureCurve: { type: 'string', description: 'Shape of the pressure response: linear (even), soft (smoothstep, gentle at both ends), firm (holds width then eases off late), or ink (gives way early). Try them; they change how a given pressure sequence reads.' },
                color: { type: 'string', description: 'Hex colour such as #3355cc; defaults to the current foreground colour.' },
                size: { type: 'number', description: 'How far the pigment spreads either side of the path, in canvas pixels: the mark ends up about twice this wide. Defaults to the current brush size.' },
                strength: { type: 'number', description: 'Paint concentration 1-100 for this stroke; defaults to the panel slider. 100 lays solid pigment, 20 is mostly a stain.' },
                wetness: { type: 'number', description: 'Paper wetness 0-100 for this stroke; defaults to the panel slider. 100 bleeds hard, 0 keeps the edge tight.' },
                spacing: { type: 'number', description: 'Brush stamp spacing for this stroke, 1-100 percent of the brush size (the panel has the same slider); defaults to the panel setting. Tight spacing (1) with a small size is what makes the flat brush draw like a pencil.' },
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
          // The canvas moved under the model's feet: the next stroke needs a fresh look,
          // but undoing is not painting, so it needs no look itself.
          lastSeen.delete(sessionId)
          const said = action === 'undo' ? 'Undid one step.' : action === 'redo' ? 'Redid one step.' : 'Cleared the canvas.'
          return { text: `${said} The canvas no longer matches what you saw, so look again (canvas_glance or canvas_look) before the next stroke.` }
        }

        const refusal = drawGuardText(sessionId)
        if (refusal) return { text: refusal }

        const strokes = Array.isArray(args?.strokes) ? args.strokes : []
        if (!strokes.length) return { text: 'Nothing to do: pass strokes, or an action of undo, redo or clear.' }
        const entryMeta = snapshots.get(sessionId)?.meta
        const metaObject = entryMeta && typeof entryMeta === 'object' ? entryMeta : {}
        const canvasMeta = metaObject.canvas && typeof metaObject.canvas === 'object' ? metaObject.canvas : {}
        const canvasWidth = Number(canvasMeta.width) || 0
        const canvasHeight = Number(canvasMeta.height) || 0

        /**
         * Sample one quadratic Bézier.
         * @param {number[]} from - start point.
         * @param {number[]} control - the single control point.
         * @param {number[]} to - end point.
         * @param {number} steps - segments to sample.
         * @returns {number[][]} points after `from`, ending on `to`.
         */
        const sampleQuadratic = (from, control, to, steps) => {
          const out = []
          for (let step = 1; step <= steps; step += 1) {
            const t = step / steps
            const u = 1 - t
            out.push([
              u * u * from[0] + 2 * u * t * control[0] + t * t * to[0],
              u * u * from[1] + 2 * u * t * control[1] + t * t * to[1],
            ])
          }
          return out
        }

        /**
         * Sample one cubic Bézier.
         * @param {number[]} from - start point.
         * @param {number[]} controlA - first control point.
         * @param {number[]} controlB - second control point.
         * @param {number[]} to - end point.
         * @param {number} steps - segments to sample.
         * @returns {number[][]} points after `from`, ending on `to`.
         */
        const sampleCubic = (from, controlA, controlB, to, steps) => {
          const out = []
          for (let step = 1; step <= steps; step += 1) {
            const t = step / steps
            const u = 1 - t
            out.push([
              u * u * u * from[0] + 3 * u * u * t * controlA[0] + 3 * u * t * t * controlB[0] + t * t * t * to[0],
              u * u * u * from[1] + 3 * u * u * t * controlA[1] + 3 * u * t * t * controlB[1] + t * t * t * to[1],
            ])
          }
          return out
        }

        /**
         * Turn one stroke's `path` string into points.
         *
         * Tokens are `x,y` or `x,y:pressure`, separated by spaces. A lone `q` or `c` puts
         * the next two (or three) points into a quadratic (or cubic) Bézier that starts at
         * the point before it, so a curve costs three or four points instead of a dense
         * polyline — which is both easier to get right and cheaper to send.
         * @param {unknown} text - the path string.
         * @returns {{ points: number[][], curved: boolean }} parsed path and whether Bézier commands were used.
         */
        const parsePath = (text) => {
          if (typeof text !== 'string') return { points: [], curved: false }
          const points = []
          let pending = []
          let curved = false
          let mode = 'line'
          for (const token of text.trim().split(/[\s;]+/)) {
            if (!token) continue
            const lower = token.toLowerCase()
            if (lower === 'm' || lower === 'l') { mode = 'line'; pending = []; continue }
            if (lower === 'q') { mode = 'q'; pending = []; curved = true; continue }
            if (lower === 'c') { mode = 'c'; pending = []; curved = true; continue }
            const [pair, pressure] = token.split(':')
            const [x, y] = pair.split(',')
            const point = [Number(x), Number(y)]
            if (pressure !== undefined && pressure !== '') point.push(Number(pressure))
            if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue
            if (mode === 'line') { points.push(point); continue }
            pending.push(point)
            const from = points[points.length - 1]
            if (!from) continue
            if (mode === 'q' && pending.length === 2) {
              points.push(...sampleQuadratic(from, pending[0], pending[1], 12))
              pending = []
              mode = 'line'
            } else if (mode === 'c' && pending.length === 3) {
              points.push(...sampleCubic(from, pending[0], pending[1], pending[2], 16))
              pending = []
              mode = 'line'
            }
          }
          return { points, curved }
        }

        /**
         * Round the corners of a polyline with Chaikin's algorithm, so three or four
         * points read as a curve instead of a zigzag.
         * @param {number[][]} points - the polyline.
         * @param {number} rounds - subdivision rounds (2 is plenty).
         * @returns {number[][]} a smoother polyline with the same endpoints.
         */
        const smoothPoints = (points, rounds) => {
          let current = points
          for (let round = 0; round < rounds && current.length > 2; round += 1) {
            const next = [current[0]]
            for (let index = 0; index < current.length - 1; index += 1) {
              const a = current[index]
              const b = current[index + 1]
              const blend = (t) => {
                const point = [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t]
                if (a.length > 2 || b.length > 2) {
                  point.push(Number(a[2] ?? 1) * (1 - t) + Number(b[2] ?? 1) * t)
                }
                return point
              }
              next.push(blend(0.25), blend(0.75))
            }
            next.push(current[current.length - 1])
            current = next
          }
          return current
        }

        /**
         * Give a stroke a pointed end without writing a pressure array by hand.
         * @param {number[][]} points - pixel points.
         * @param {'in'|'out'|'both'} mode - which end tapers.
         * @returns {number[][]} points carrying pressures.
         */
        const applyTaper = (points, mode) => {
          if (points.length < 2) return points
          const out = points.map((point) => [point[0], point[1], Number(point[2] ?? 1)])
          const last = out.length - 1
          if (mode === 'out' || mode === 'both') {
            const start = Math.floor(last * 0.55)
            for (let index = start; index <= last; index += 1) {
              const t = (index - start) / Math.max(1, last - start)
              out[index][2] = Math.min(out[index][2], 1 - 0.7 * t)
            }
          }
          if (mode === 'in' || mode === 'both') {
            const end = Math.ceil(last * 0.45)
            for (let index = 0; index <= end; index += 1) {
              const t = 1 - index / Math.max(1, end)
              out[index][2] = Math.min(out[index][2], 1 - 0.7 * t)
            }
          }
          return out
        }

        /** Every coordinate inside 0-1 reads as a fraction of the canvas. */
        const looksLikeFractions = (points) => points.length > 0
          && points.every((point) => Math.abs(Number(point?.[0])) <= 1 && Math.abs(Number(point?.[1])) <= 1)

        /**
         * Expand an ellipse spec into one spiral path that fills it.
         *
         * A stroke is a swept brush, not a filled shape, so filling a disc by hand means
         * either rows (which scallop the rim with round caps) or rings (whose joins paint
         * unwanted lines). A spiral avoids both: one continuous path, one rim, and the
         * pitch is set from the brush so the bands overlap exactly enough to cover.
         * @param {number[]} center - [cx, cy] in canvas pixels.
         * @param {number[]} radii - [rx, ry] in canvas pixels.
         * @param {number} brush - the stroke's spread, in canvas pixels (its radius).
         * @returns {number[][]} spiral points, centre outward.
         */
        const ellipseSpiral = ([cx, cy], [rx, ry], brush, phase = 0) => {
          const size = Math.max(1, Number(brush) || 1)
          const maxR = Math.max(rx, ry)
          if (maxR <= size * 0.5) return [[cx, cy]]
          const limit = Math.max(0, 1 - (size * 0.5) / maxR)
          // Pitch from the brush, conservatively: the circle brush spreads about half the
          // number either side, watercolour spreads the whole number, and a spiral that
          // assumes the larger spread leaves crescent gaps on the smaller one.
          const perTurn = Math.min(0.6, Math.max(0.12, (size * 0.7) / maxR))
          const step = 0.22
          // Start at the centre and wind outward: starting part-way out leaves an unfilled
          // hole, and jumping back to the centre at the end paints a streak across it.
          const points = [[cx, cy]]
          let theta = phase
          let u = 0
          while (u < limit && points.length < 1200) {
            points.push([cx + rx * u * Math.cos(theta), cy + ry * u * Math.sin(theta)])
            theta += step
            u += perTurn * (step / (Math.PI * 2))
          }
          // Finish on paint, not on the silhouette. Stopping at the rim leaves a round cap
          // poking out of the contour; so run on along the rim (covered by the ring just
          // painted) and then tuck back inward, which hides the end inside the fill.
          const rim = Math.min(limit, u)
          for (let index = 0; index < 3; index += 1) {
            theta += step
            points.push([cx + rx * rim * Math.cos(theta), cy + ry * rim * Math.sin(theta)])
          }
          let back = rim
          for (let index = 0; index < 4; index += 1) {
            back = Math.max(0, back - (perTurn * 0.55))
            theta += step
            points.push([cx + rx * back * Math.cos(theta), cy + ry * back * Math.sin(theta)])
          }
          return points
        }

        /**
         * Walk an ellipse or an arc as one outline path.
         * @param {number[]} center - [cx, cy] in canvas pixels.
         * @param {number[]} radii - [rx, ry] in canvas pixels.
         * @param {number} fromDeg - start angle in degrees (0 = right, clockwise).
         * @param {number} toDeg - end angle; a full turn closes the ring.
         * @returns {number[][]} the outline.
         */
        const ellipsePath = ([cx, cy], [rx, ry], fromDeg, toDeg) => {
          const span = ((toDeg - fromDeg) % 360 + 360) % 360 || 360
          const steps = Math.max(16, Math.round(span / 3))
          const points = []
          for (let index = 0; index <= steps; index += 1) {
            const turn = (fromDeg + (span * index) / steps) * (Math.PI / 180)
            points.push([cx + rx * Math.cos(turn), cy + ry * Math.sin(turn)])
          }
          return points
        }

        /**
         * Cut a polygon into horizontal bands, one stroke each.
         * @param {number[][]} polygon - vertices in canvas pixels.
         * @param {number} brush - the stroke's spread, which sets the band pitch.
         * @returns {number[][][]} one segment per band.
         */
        const polygonBands = (polygon, brush) => {
          const size = Math.max(1, Number(brush) || 1)
          const ys = polygon.map((point) => point[1])
          const top = Math.min(...ys)
          const bottom = Math.max(...ys)
          const pitch = Math.max(2, size * 0.7)
          const bands = []
          for (let y = top + size * 0.5; y <= bottom - size * 0.25; y += pitch) {
            const crossings = []
            for (let index = 0; index < polygon.length; index += 1) {
              const a = polygon[index]
              const b = polygon[(index + 1) % polygon.length]
              if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
                crossings.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]))
              }
            }
            crossings.sort((left, right) => left - right)
            for (let index = 0; index + 1 < crossings.length; index += 2) {
              const start = crossings[index] + size * 0.5
              const end = crossings[index + 1] - size * 0.5
              bands.push(end - start >= 1 ? [[start, y], [end, y]] : [[(start + end) / 2, y]])
            }
          }
          return bands
        }

        const readStroke = (stroke) => {
          const shape = Array.isArray(stroke?.ellipse) ? stroke.ellipse.map(Number) : undefined
          const declaredUnit = stroke?.unit === 'ratio' ? true : stroke?.unit === 'pixels' ? false : undefined
          if (shape && shape.length === 4 && shape.every((value) => Number.isFinite(value))) {
            const asRatio = declaredUnit === undefined ? shape.every((value) => Math.abs(value) <= 1) : declaredUnit
            const center = asRatio ? [shape[0] * canvasWidth, shape[1] * canvasHeight] : [shape[0], shape[1]]
            const radii = asRatio ? [shape[2] * canvasWidth, shape[3] * canvasHeight] : [shape[2], shape[3]]
            const from = Number(stroke?.from)
            const to = Number(stroke?.to)
            // `ring` (or an arc angle) means outline the ellipse instead of filling it.
            const outline = stroke?.ring === true || Number.isFinite(from) || Number.isFinite(to)
            if (outline) {
              const start = Number.isFinite(from) ? from : 0
              const end = Number.isFinite(to) ? to : start + 360
              return { raw: ellipsePath(center, radii, start, end), curved: true, asRatio: false }
            }
            const brushSize = Number(stroke?.size) || 40
            let spiral = ellipseSpiral(center, radii, brushSize)
            // `seam` shifts the spiral's starting angle so that its last point — the one cap
            // that can show as a lump on the rim — lands at the angle you choose instead of
            // wherever the arithmetic happened to stop. Rotate the angle, not the points: a
            // point rotation would tip the ellipse out of axis alignment.
            const seam = Number(stroke?.seam)
            if (Number.isFinite(seam) && spiral.length > 2) {
              // The last pushed point sits one step short of the loop counter.
              const endAngle = 0.22 * (spiral.length - 2)
              spiral = ellipseSpiral(center, radii, brushSize, (seam * Math.PI) / 180 - endAngle)
            }
            return { raw: spiral, curved: true, asRatio: false }
          }
          const parsed = Array.isArray(stroke?.points)
            ? { points: stroke.points, curved: false }
            : parsePath(stroke?.path)
          const declared = stroke?.unit === 'ratio' ? true : stroke?.unit === 'pixels' ? false : undefined
          return { raw: parsed.points, curved: parsed.curved, asRatio: declared === undefined ? looksLikeFractions(parsed.points) : declared }
        }
        /** A polygon stroke arrives as vertices; turn it into pixel-space vertices. */
        const readPolygon = (stroke) => {
          const raw = Array.isArray(stroke?.polygon) ? stroke.polygon : undefined
          if (!raw || raw.length < 3) return undefined
          const points = raw.map((point) => (Array.isArray(point)
            ? [Number(point[0]), Number(point[1])]
            : [Number(point?.x), Number(point?.y)]))
          if (!points.every((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))) return undefined
          const declared = stroke?.unit === 'ratio' ? true : stroke?.unit === 'pixels' ? false : undefined
          const asRatio = declared === undefined
            ? points.every((point) => Math.abs(point[0]) <= 1 && Math.abs(point[1]) <= 1)
            : declared
          return asRatio
            ? points.map((point) => [point[0] * canvasWidth, point[1] * canvasHeight])
            : points
        }
        if (strokes.some((stroke) => readStroke(stroke).asRatio) && (!canvasWidth || !canvasHeight)) {
          return { text: 'These strokes are given as fractions of the canvas, but the host does not know the canvas size yet, so the fractions cannot be turned into pixels. Call canvas_glance (or canvas_look) once, then send them again.' }
        }
        let outOfBounds = 0
        /** Turn one stroke spec into one or more point arrays (bands, or a mirrored twin). */
        const plansFor = (stroke) => {
          const polygon = readPolygon(stroke)
          const jitter = Math.max(0, Math.min(20, Number(stroke?.jitter) || 0))
          const shake = (plans) => (jitter > 0
            ? plans.map((plan) => plan.map((point) => [
              point[0] + (Math.random() * 2 - 1) * jitter,
              point[1] + (Math.random() * 2 - 1) * jitter,
            ]))
            : plans)
          if (polygon) {
            // Bands are perfectly parallel by construction; jitter is what keeps them from
            // reading as a printout rather than as paint.
            return shake(polygonBands(polygon, Number(stroke?.size) || 40))
          }
          const { raw, curved, asRatio } = readStroke(stroke)
          let clipped = false
          let points = raw.map((point) => {
            const x = Number(point?.[0])
            const y = Number(point?.[1])
            if (asRatio) {
              const converted = [x * canvasWidth, y * canvasHeight]
              if (Array.isArray(point) && point.length > 2) converted.push(Number(point[2]))
              return converted
            }
            if (!Number.isFinite(x) || !Number.isFinite(y)) return point
            if (x < 0 || y < 0 || (canvasWidth && x > canvasWidth) || (canvasHeight && y > canvasHeight)) clipped = true
            return point
          })
          if (clipped) outOfBounds += 1
          // Loose points and generated shapes alike get rounded; a Bézier is already a curve,
          // so it needs no corner cutting, and a shape needs only one light pass.
          const wantsSmoothing = stroke?.smooth === true || (stroke?.smooth === undefined && points.length >= 3)
          if (wantsSmoothing) points = smoothPoints(points, curved ? 1 : 2)
          const taper = ['in', 'out', 'both'].includes(stroke?.taper) ? stroke.taper : undefined
          if (taper) points = applyTaper(points, taper)
          return curved ? shake([points]) : [points]
        }
        const ops = strokes.flatMap((stroke) => {
          const mirrored = stroke?.mirror === 'x' || stroke?.mirror === 'y' || stroke?.mirror === true
          const base = plansFor(stroke)
          // Snapshot the base plans before adding reflections: iterating an array while
          // appending to it never terminates, which is exactly how this crashed the host.
          const plans = mirrored
            ? [...base, ...base.map((plan) => {
              const flip = stroke?.mirror === 'y'
              return plan.map((point) => {
                const copy = [flip ? point[0] : canvasWidth - point[0], flip ? canvasHeight - point[1] : point[1]]
                if (point.length > 2) copy.push(point[2])
                return copy
              })
            })]
            : base
          const taper = ['in', 'out', 'both'].includes(stroke?.taper) ? stroke.taper : undefined
          return plans.map((points) => ({
            type: 'stroke',
            tool: stroke?.tool === 'smudge' ? 'smudge' : 'brush',
            points,
            color: stroke?.color,
            size: stroke?.size,
            strength: stroke?.strength,
            wetness: stroke?.wetness,
            spacing: stroke?.spacing,
            usePressure: Boolean(taper) || Boolean(stroke?.usePressure) || points.some((point) => point.length > 2),
            pressureCurve: stroke?.pressureCurve || (taper ? 'soft' : undefined),
            brushType: stroke?.brushType,
          }))
        })
        if (ops.length > 400) {
          return { text: `That expands to ${ops.length} strokes, which is more than this tool will send in one call. Split it into smaller shapes or fewer polygon vertices.` }
        }
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
        // Its own strokes are the one change it is allowed not to look at again; a timed
        // out ack means the picture may not have reached the host yet, so look next time.
        if (acked) lastSeen.set(sessionId, stampOf(snapshots.get(sessionId)))
        else lastSeen.delete(sessionId)
        if (acked) ownDrawAt.set(sessionId, Date.now())
        const smudges = ops.filter((op) => op.tool === 'smudge').length
        const painted = ops.length - smudges
        const parts = []
        if (painted) parts.push(`${painted} brush stroke(s)`)
        if (smudges) parts.push(`${smudges} smudge stroke(s)`)
        const tail = acked
          ? 'The canvas is updated; canvas_glance shows the result cheaply if you need to check it.'
          : 'Still painting; call canvas_glance in a moment for the result.'
        const bounds = outOfBounds
          ? ` ${outOfBounds} of them had points outside the ${canvasWidth}x${canvasHeight} canvas, so part of the stroke landed off-canvas.`
          : ''
        return { text: `Applied ${parts.join(' and ')}. ${tail} The user can undo them.${bounds}` }
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
