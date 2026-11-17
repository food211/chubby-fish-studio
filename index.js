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
const RECORD_PATH = '/mpx/canvas/record'
const LAST_PATH = '/mpx/canvas/last'
const DEBUG_PATH = '/mpx/canvas/debug'

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'

// Retention for the on-disk snapshots. One file per session, overwritten in place, so
// a painting never grows; only the number of sessions can grow, and that is capped.
const MAX_STATE_FILES = 16
const MAX_STATE_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_SNAPSHOT_CHARS = 4 * 1024 * 1024
const MAX_MEMORY_SNAPSHOTS = 24
/** How long a glance or a zoom waits for the panel to paint one out. */
const RENDER_TIMEOUT_MS = 6000
/** How long a stop waits for the panel to flush the encoder and upload the clip. */
const RECORD_TIMEOUT_MS = 45000
/** A recording upload is base64 inside JSON, so it needs more room than a snapshot. */
const RECORD_BODY_BYTES = 96 * 1024 * 1024
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
/** Recorded drawing clips land here, one webm per recording. */
const RECORD_DIR = join(HARNESS_HOME, 'canvas-recordings')
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
  'The user has a pigment-mixing painting canvas: the 肥鱼画室 panel in the right sidebar. You can see it and paint on it through the same pigment pipeline the user paints with.',
  'Look at three prices: `canvas_glance` (the whole canvas as a thumbnail — placement and big shapes), `canvas_zoom` (one rectangle in canvas fractions, enlarged — a detail for the price of the crop), `canvas_look` (full size plus brush, palette and colours — when colour or an exact edge matters, or before advising on the painting). `canvas_state` gives the same facts without a picture and is not a look.',
  'You cannot paint blind: `canvas_draw` refuses strokes until you have looked at the whole canvas this session, and again if the canvas has changed since that look (the user painted, undid, cleared, or the panel reloaded). After a refusal, look (a glance is enough), then draw — never retry it unchanged. Your own strokes do not invalidate the look.',
  '`canvas_draw` paints strokes and also carries `smudge` plus the undo/redo/clear actions; every stroke lands in the user undo stack. Points are canvas pixels, or fractions of the canvas when every value is in 0-1. `size` is the half-width on the wash brushes (they spread about twice it) and about the full width on circle/flat/soft.',
  'Keep a call to a handful of strokes, about eight: a long or wide call that gets mangled costs the whole batch, while small calls lose only their own. A path can be the compact string "0.36,0.60 0.37,0.65", sturdier for long paths, and curves are curves — "… q cx,cy x,y" is one arc.',
  'Draw shapes as shapes, not piles of rows: `ellipse: [cx, cy, rx, ry]` (with `ring`, `from`/`to`, `seam`, `jitter`), `polygon`, and `mirror: "x"` for a symmetrical pair — that is how eyes, ears and hair locks come out even in one call.',
  'Depth comes from strength and a second pass, not from wetness: 20 is barely a stain, 77 lands about 60% of the pigment, only near 100 does the colour read as itself. Wetness is how far the edge travels (100 bleeds, 20 holds), so lower it to sharpen a shape rather than to darken it — and a watercolor at low wetness goes patchy, not solid.',
  'The drip run-off is a separate knob from wetness: per stroke `drip: "off"` suppresses it, `"on"` forces it, `"auto"` leaves it to the device and the panel toggle, and `dripAmount` 0-2 (1 is the default) sets how often drops spawn and how many are allowed at once. Drops only form at wetness 50 or more, on a `watercolor` stroke — so push wetness up first, then season with dripAmount rather than flooding the picture. `dripAmount` is density, not reach: how far a drop runs is fixed by the brush size and the wetness, so for longer runs use a larger brush or wetter paint, not a bigger amount.',
  'Pick the brush by the job — `watercolor` for atmosphere, `circle`/`soft` for clean opaque shapes, `flat` for blocks or (small size, `spacing` 1, strength 75-90) for pencil lines, `splatter` for grain, `dry` rarely — and load the brush sheet for the settings instead of guessing. No setting turns a watercolor white opaque over dark, and circle/flat/soft cannot make a wash.',
  'Seven tools are always available; four more (`canvas_guide`, `canvas_brushes`, `canvas_notes`, `canvas_sample`) load on demand so they do not cost every request — call `canvas_tools` with `load: "guide"` (or "brushes", "notes", "sample") and that tool is usable from your next step. Load the guide before a new painting: it is the method — layers, light, stroke intent, judging, when to repaint.',
  '`canvas_record` films the drawing as a webm: `start` before the strokes, `stop` after, and the clip lands under the harness home with its path returned. It reads the canvas stream, not the undo stack, so it captures the whole painting and not the last 50 frames; the panel has to be open.',
  'Pressure narrows and pales at once, so a silhouette drawn with tapered strokes comes out weak: build the shape at full pressure, then place the points and the fades. Pick the pressureCurve (linear, soft, firm, ink) before the numbers.',
  'When the user asks for help with painting, look first, name one concrete problem, and demonstrate with one short stroke instead of a long description.',
  'The panel may start a turn when it decides the painting changed enough: treat that as an invitation to look and say one useful sentence, not to re-describe the canvas.',
  `Shared painting memory at ${NOTES_DIR}: \`canvas_notes\` with no arguments returns the index (one line per note), \`action: "read", file: …\` returns one note. Read it before a new painting, and append the line that would have saved a repaint — one conclusion per line, delete what is no longer true, the directory has a hard size cap.`,
  'If a canvas tool reports that no canvas is open, say so and suggest opening the 肥鱼画室 panel rather than guessing what is on it.',
].join(' ')

const CARD_TEXT = {
  noSession: 'No agent session is attached to this call, so there is no canvas to read.',
  notOpen: 'No canvas is open for this session. Ask the user to open the 肥鱼画室 panel from the 画室 entry at the foot of the left sidebar, then try again.',
  noAttachments: 'This deployment has no attachment store, so the canvas image cannot be handed to the model. The canvas state is still available through canvas_state.',
}

/**
 * The optional canvas tools, by group.
 *
 * DSH re-sends every visible tool schema on every request, so these four — which are read
 * once per painting and never again — are registered with a `when` condition instead: their
 * schemas and their execution stay out of the step until the model asks for the group
 * through canvas_tools. Looking and painting are always available.
 */
const LAZY_TOOL_GROUPS = {
  guide: 'canvas_guide',
  brushes: 'canvas_brushes',
  notes: 'canvas_notes',
  sample: 'canvas_sample',
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
  'The drip run-off is its own switch, not a wetness value: `drip: "on" | "off" | "auto"` per stroke, and `dripAmount` 0-2 for how eagerly drops spawn and how many may run at once. It needs `watercolor` at wetness 50 or more; below that nothing spawns whatever the switch says. `dripAmount` changes density only — the distance a drop travels is set by the brush size and the wetness, so a longer run wants a bigger brush or wetter paint rather than a higher amount.',
  '',
  'Job first, brush second: atmosphere → watercolor; a form that must stay crisp → circle or soft; line art and hatching → flat with a small size, `spacing` 1 and strength 75-90 (it then draws like a pencil); grain and sparkle → splatter; `dry` is the dry-brush 毛笔 for a split, coarse, gritty texture and it is rarely the right choice. Two things no setting changes: a watercolor white over dark stays grey however many passes it gets, and circle/flat/soft cannot make a wash. Width: circle/flat/soft paint about 1 x size, watercolor/dry/splatter about 2 x size.',
].join('\n')

/**
 * How to paint a picture that reads.
 *
 * Served on demand by `canvas_guide` rather than sitting in every request: the method is
 * read once per painting, and what a stroke can do is already in the schema. It exists
 * because the tools alone teach mechanics, and mechanics without a method is how you end
 * up with a well-drawn arm on a figure nobody recognises.
 */
const PAINT_GUIDE = [
  '# Painting on this canvas: a general method',
  '',
  '## What a viewer reads first',
  '- The silhouette, the focal point (usually the face and eyes), and the biggest colour mass. Design those three and everything else is detail that can be added, left rough, or skipped.',
  '- Value before colour: three clear values - light, mid, dark - read even in one hue. Ten colours with mushy values read as nothing.',
  '',
  '## Think in layers',
  '- Back to front, big to small, flat to rendered.',
  '- Paint roughly what will be covered, carefully what stays visible; the last strokes are the crisp ones.',
  '- Only split into layers where shapes overlap. One colour field is one pass, not five.',
  '- Nothing is painted *around*: lay the whole shape, then cover the part you do not want.',
  '',
  '## Let each tool add what the others cannot',
  '- `circle` / `flat` - form. Flat colour and crisp silhouettes at full strength: the bones of the picture.',
  '- `watercolor` - light and mood. Wet (100) so it bleeds: a wash under the subject, a sky, a glow, a gradient. Two pale passes build a rich tone without mud; a wet edge left alone is a feature, not a mistake. Never use it where the colour has to be solid.',
  '- `soft` - soft *and* opaque: blush, a cheek shadow, a glow behind a head, the blur of a cast shadow.',
  '- `smudge` - the transition between two colours already on the paper: drag a shadow edge into the light, soften a jaw, melt hair into its own shadow, thin a rim. It is the fastest way to stop an edge reading as a sticker, and it only blends - it never adds colour.',
  '- `dry` - broken, gritty texture: cloth, stone, rough hair. Use it sparingly or it eats the shape it was describing.',
  '- `splatter` - dust, stars, spray, a splash. Texture that sits on top; a little goes far.',
  '- pressure and `taper` - the life in a line: light at the tip, heavy at the root, a long line that swells and thins. An evenly weighted line reads as typed, a worn one reads as drawn. Use it on every stroke that leaves a shape (hair tips, fingers, a tail, an ankle), full pressure on every fill.',
  '- `spacing` - tight (1) with a small `flat` gives the pencil texture for line work and hatching; loose gives a broken, grainy block.',
  '',
  '## Light',
  '- Pick one direction before the first stroke and keep it: every lit side on the same side.',
  '- Three values minimum - base, shadow, light. Highlights last, small, and only near the focal point.',
  '- Shadows are the base colour darker and a touch cooler, not black. A cast shadow on the ground is what tells a viewer the subject stands on something - or, lifted off it, how high.',
  '',
  '## Work in a rhythm',
  '- Cheap looks: a glance for placement, a zoom for one face or edge. Judge the whole picture at thumbnail size - mistakes invisible when zoomed in are obvious there.',
  '- One named problem per pass ("the sleeve is thinner than the hair behind it, so the arm reads as a blob"), then fix that one.',
  '- A wrong shape gets repainted, not patched: strokes laid over a mistake inherit it.',
  '- Stop when the picture reads whole. An expressive picture with rough passages beats an even, over-polished one.',
  '',
  '## The failure modes, most frequent first',
  '1. Uniform effort - every area rendered to the same finish. Leave something rough so the focus has contrast.',
  '2. One tool - everything flat and hard reads as stickers, everything wet reads as fog.',
  '3. Too many saturated colours - pick a dominant hue and let the rest be its relatives.',
  '4. White used as paint - white over dark greys out. White is paper left alone, or an opaque brush on a light area.',
  '5. Over-painting - every extra pass muddies a spot. If three strokes did not fix it, repaint the area.',
].join('\n')

/**
 * Read a request body up to a fixed bound.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @param {number} [limit] - byte cap; a recorded clip is far bigger than a snapshot.
 * @returns {Promise<Buffer>} the collected bytes.
 */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
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
 * ffmpeg, if this host happens to have it.
 *
 * Bundling it would put tens of megabytes inside a 700 KB plugin, so it stays optional:
 * when it is on PATH a finished recording gets a duration index and an mp4 copy; when it
 * is absent the plain webm is still a valid, playable file.
 * @returns {Promise<boolean>} whether ffmpeg answered.
 */
let ffmpegProbe
function ffmpegAvailable() {
  if (!ffmpegProbe) {
    ffmpegProbe = new Promise((resolve) => {
      let settled = false
      const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
      try {
        const child = spawn('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true })
        const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } finish(false) }, 4000)
        child.on('error', () => { clearTimeout(timer); finish(false) })
        child.on('exit', (code) => { clearTimeout(timer); finish(code === 0) })
      } catch {
        finish(false)
      }
    })
  }
  return ffmpegProbe
}

/**
 * Run one short ffmpeg pass over a recording.
 * @param {string[]} args - ffmpeg arguments.
 * @returns {Promise<boolean>} whether it exited cleanly inside the timeout.
 */
function runFfmpeg(args) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
    try {
      const child = spawn('ffmpeg', args, { stdio: 'ignore', windowsHide: true })
      const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } finish(false) }, 120000)
      child.on('error', () => { clearTimeout(timer); finish(false) })
      child.on('exit', (code) => { clearTimeout(timer); finish(code === 0) })
    } catch {
      finish(false)
    }
  })
}

/**
 * Make a raw recording convenient to play: give it a duration index, then add an mp4 copy.
 *
 * MediaRecorder writes a live webm with no duration: it plays, but cannot be scrubbed and
 * confuses editors. A stream copy fixes the index without touching a pixel, and the mp4
 * is what phones, WeChat and 剪映 accept.
 * @param {string} file - the webm just written.
 * @returns {Promise<{ indexed: boolean, mp4: string | null }>} what is playable now.
 */
async function polishRecording(file) {
  if (!await ffmpegAvailable()) return { indexed: false, mp4: null }
  const temp = file.replace(/\.webm$/, '.indexed.webm')
  const copied = await runFfmpeg(['-v', 'error', '-y', '-i', file, '-c', 'copy', temp])
  let indexed = false
  if (copied) {
    try {
      await rename(temp, file)
      indexed = true
    } catch {
      try { await unlink(temp) } catch { /* gone */ }
    }
  } else {
    try { await unlink(temp) } catch { /* gone */ }
  }
  const mp4 = file.replace(/\.webm$/, '.mp4')
  const transcoded = await runFfmpeg([
    '-v', 'error', '-y', '-i', file,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20',
    '-movflags', '+faststart', mp4,
  ])
  return { indexed, mp4: transcoded ? mp4 : null }
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
  /** @type {Map<string, (payload: unknown) => void>} */
  const pendingRecords = new Map()
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
   * The state a look actually needs, one line instead of the whole dump.
   *
   * A glance or a zoom is about where things are; re-sending brush, palette, colour list
   * and viewport on every one of them is paying for something the model read once. The
   * full state still comes with canvas_look and canvas_state.
   * @param {unknown} meta - the snapshot's meta from the panel.
   * @returns {string} compact JSON.
   */
  function compactState(meta) {
    const view = meta && typeof meta === 'object' ? meta : {}
    const brush = view.brush && typeof view.brush === 'object' ? view.brush : {}
    const colours = view.colors && typeof view.colors === 'object' ? view.colors : {}
    return JSON.stringify({
      canvas: view.canvas,
      brush: brush.type,
      size: brush.size,
      strength: view.concentration,
      wetness: view.wetness,
      fg: colours.foreground,
      history: view.history,
    })
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
      const rawMeta = payload?.meta ?? null
      // The panel tags each push with whatever changed the canvas last. A push that only
      // carries the model's own strokes must not invalidate the look it just took, or the
      // guard would force a fresh glance between every batch of strokes it paints.
      const origin = rawMeta && typeof rawMeta === 'object' && rawMeta.origin === 'agent' ? 'agent' : 'user'
      const meta = rawMeta && typeof rawMeta === 'object' ? { ...rawMeta } : rawMeta
      if (meta && typeof meta === 'object') delete meta.origin
      const entry = { png: payload.png, meta, at: Date.now() }
      snapshots.set(sessionId, entry)
      const paintedAt = ownDrawAt.get(sessionId) || 0
      if (lastSeen.has(sessionId) && (origin === 'agent' || Date.now() - paintedAt <= OWN_DRAW_GRACE_MS)) {
        lastSeen.set(sessionId, stampOf(entry))
      }
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
   * Take a finished recording upload from the panel.
   *
   * The encoder runs in the browser, so the clip can only leave it as an upload; the
   * waiting `canvas_record` call turns these bytes into a file and hands the model a path.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RECORD_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'method' }); return }
      let payload
      try {
        payload = JSON.parse((await readBody(req, RECORD_BODY_BYTES)).toString('utf8'))
      } catch {
        json(res, 400, { ok: false, reason: 'bad-json' })
        return
      }
      const id = typeof payload?.id === 'string' ? payload.id : ''
      const resolve = id ? pendingRecords.get(id) : undefined
      if (resolve) resolve(payload)
      json(res, 200, { ok: true, matched: Boolean(resolve) })
    },
  }), 'mixbox-palette: canvas recording route')

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

  /**
   * Which optional tool groups this session has loaded.
   *
   * Kept per session in memory: a fresh conversation pays for the guide and the brush sheet
   * again only if it needs them, which is the point.
   * @type {Map<string, Set<string>>}
   */
  const loadedToolGroups = new Map()
  /**
   * @param {unknown} agent - the calling agent from a tool execution or a step condition.
   * @returns {string} its session id, or ''.
   */
  const toolSessionKey = (agent) => {
    try {
      return String((agent && typeof agent === 'object' ? agent.session?.id : '') || '')
    } catch {
      return ''
    }
  }
  /**
   * @param {unknown} agent - the calling agent.
   * @param {string} group - one of LAZY_TOOL_GROUPS.
   * @returns {boolean} whether the group's tool is visible to this agent.
   */
  const toolGroupLoaded = (agent, group) => {
    const key = toolSessionKey(agent)
    return Boolean(key) && Boolean(loadedToolGroups.get(key)?.has(group))
  }
  /**
   * @param {unknown} agent - the calling agent.
   * @param {string} group - one of LAZY_TOOL_GROUPS.
   * @returns {boolean} whether the load was recorded.
   */
  const loadToolGroup = (agent, group) => {
    const key = toolSessionKey(agent)
    if (!key) return false
    let set = loadedToolGroups.get(key)
    if (!set) {
      set = new Set()
      loadedToolGroups.set(key, set)
    }
    set.add(group)
    return true
  }
  /**
   * A `when` condition for one lazy group. A throwing condition fails step preparation, so
   * this keeps every path total and returns false when anything is missing.
   * @param {string} group - one of LAZY_TOOL_GROUPS.
   * @returns {(context: { agent?: unknown }) => boolean} the condition.
   */
  const whenToolGroupLoaded = (group) => (context) => {
    try {
      return toolGroupLoaded(context?.agent, group)
    } catch {
      return false
    }
  }

  ctx.inject(['tools'], (scope) => {
    scope.tools.register({
      name: 'canvas_tools',
      description: 'Load the optional canvas tools when you need them: "guide" (how to paint a picture that reads), "brushes" (labelled swatch sheet and one line per brush), "notes" (the shared painting memory), "sample" (exact pixel colours). A loaded tool is available from your next step, so load it the moment you need it. Looking and painting need no loading.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['load'],
        properties: {
          load: {
            type: 'string',
            enum: Object.keys(LAZY_TOOL_GROUPS),
            description: 'Which group of optional tools to load.',
          },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: value.text }] },
      },
      async execute(args, exec) {
        const group = typeof args?.load === 'string' ? args.load : ''
        const toolName = LAZY_TOOL_GROUPS[group]
        if (!toolName) {
          return { text: `Load which group? ${Object.keys(LAZY_TOOL_GROUPS).map((key) => `"${key}"`).join(', ')}.` }
        }
        if (!loadToolGroup(exec?.agent, group)) return { text: CARD_TEXT.noSession }
        return { text: `${toolName} is loaded; call it from your next step.` }
      },
    })
    scope.tools.register({
      name: 'canvas_look',
      description: 'See the whole canvas at full size (picture, pixel size, brush, palette, colours). The most expensive look: a glance or a zoom is cheaper. Use it when the user refers to what they painted, and before advising on the painting.',
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
      description: 'Cheap look: the whole canvas as a thumbnail, so placement and big shapes cost a fraction of canvas_look. It also counts as having looked, so you may draw after it. Follow with canvas_zoom when a detail matters.',
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
          `<state>${compactState(meta)}</state>`,
        ]
        if (width && ref.width) {
          lines.splice(2, 0, `<scale>x ${(width / ref.width).toFixed(3)}, y ${(height / ref.height).toFixed(3)} (multiply a coordinate measured on this picture by these to get canvas coordinates)</scale>`)
        }
        return { text: lines.join('\n'), image: ref }
      },
    })

    scope.tools.register({
      name: 'canvas_zoom',
      description: 'Look closely at one part of the canvas: one crop, enlarged, so a detail costs tokens for the crop instead of the whole picture. Both points are fractions of the canvas (0 = left or top edge), so they can be read straight off a glance: from [0.2, 0.3] to [0.45, 0.55].',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to'],
        properties: {
          from: {
            type: 'array',
            items: { type: 'number' },
            description: 'One corner, as fractions of canvas width and height: [0.2, 0.3] is 20% across, 30% down.',
          },
          to: {
            type: 'array',
            items: { type: 'number' },
            description: 'The opposite corner, same fractions; either may be the top-left one.',
          },
          maxWidth: {
            type: 'number',
            description: 'Longest side of the returned picture, 240-1200; defaults to 640. Bigger costs more tokens, so ask for only as much as the detail needs.',
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
      name: 'canvas_guide',
      description: 'A general method for painting here: what a viewer reads first, how to layer, and what each tool adds that the others cannot - smudge for transitions, watercolor for light and mood, pressure for stroke life - plus light, working rhythm and the usual failure modes. No canvas needed; read it once before a new painting.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: value.text }] },
      },
      async execute() {
        return { text: PAINT_GUIDE }
      },
    }, { when: whenToolGroupLoaded('guide') })

    scope.tools.register({
      name: 'canvas_brushes',
      description: 'How each brush paints: a labelled swatch sheet from this engine plus one line per brush on what the mark is. One image, needs no open canvas, paints nothing. Call it once before choosing brushes for a new painting.',
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
    }, { when: whenToolGroupLoaded('brushes') })

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
      description: 'Shared painting memory: Markdown notes earlier sessions wrote about this pipeline. Call with no arguments for the index, read only the note you need, append the line that would have saved a repaint. Hard size cap: when an append pushes it over, merge duplicates and drop stale conclusions first.',
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
    }, { when: whenToolGroupLoaded('notes') })

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
                  description: 'Path points: [x, y] or [x, y, pressure 0-1]. Canvas pixels, or fractions of the canvas when every value is in 0-1. Give points or path.',
                  items: { type: 'array', items: { type: 'number' } },
                },
                path: {
                  type: 'string',
                  description: 'The same path as one string, sturdier for long paths: "0.36,0.60 0.37,0.65", optional pressure after a colon. A lone q or c makes the next two or three points a Bézier: "0.30,0.40 q 0.50,0.10 0.70,0.40" is one arc.',
                },
                ellipse: {
                  type: 'array',
                  description: 'Fill an ellipse instead of sweeping: [cx, cy, rx, ry] in the units of points. One smooth spiral, so the rim has no scallops; size sets the pitch. Add ring: true, or from/to, to outline instead.',
                },
                ring: { type: 'boolean', description: 'With ellipse: outline it instead of filling; size is then the line width.' },
                from: { type: 'number', description: 'With ellipse: start angle in degrees (0 = right, clockwise); with to it makes an arc.' },
                to: { type: 'number', description: 'With ellipse: end angle in degrees.' },
                polygon: {
                  type: 'array',
                  description: 'Fill a polygon instead of sweeping: [[x, y], …], at least three vertices, units of points. Cut into horizontal bands, one stroke each.',
                },
                seam: {
                  type: 'number',
                  description: 'With a filled ellipse: the angle (degrees, 0 = right) where the spiral hides its inward tail. Cosmetic only.',
                },
                jitter: {
                  type: 'number',
                  description: 'Pixels of wobble (0-20) on a generated shape path, to break a mechanically even rim. Leave it off for a crisp line.',
                },
                mirror: {
                  type: 'string',
                  enum: ['x', 'y'],
                  description: 'Paint the stroke and its reflection about the canvas centre line — a symmetrical pair in one call.',
                },
                smooth: {
                  type: 'boolean',
                  description: 'Round the points into a curve (default for three or more); false keeps a corner. Paths with q or c are left alone.',
                },
                taper: {
                  type: 'string',
                  enum: ['in', 'out', 'both'],
                  description: 'Write a pressure ramp for you, 1 down to 0.3 on a soft curve. It narrows and pales together; try it rather than assuming.',
                },
                unit: {
                  type: 'string',
                  enum: ['pixels', 'ratio'],
                  description: 'Force pixels or fractions; usually unnecessary, since values within 0-1 already read as fractions.',
                },
                usePressure: { type: 'boolean', description: 'Use the per-point pressures even when the panel pen switch is off. Pressure narrows and pales together, so look at what it gives.' },
                pressureCurve: { type: 'string', description: 'Pressure response: linear, soft, firm (holds width, tapers late) or ink (gives way early).' },
                color: { type: 'string', description: 'Hex colour, e.g. #3355cc; defaults to the foreground colour.' },
                size: { type: 'number', description: 'Canvas pixels. About twice this wide on the wash brushes, about this wide on circle/flat/soft; defaults to the brush size.' },
                strength: { type: 'number', description: 'Pigment 1-100: 100 lays solid, 20 is a stain. Defaults to the panel slider.' },
                wetness: { type: 'number', description: 'Edge bleed 0-100: 100 bleeds, 20 holds. Defaults to the panel slider.' },
          drip: {
            type: 'string',
            enum: ['auto', 'on', 'off'],
            description: 'Watercolour run-off for this stroke: "on" forces drips, "off" suppresses them, "auto" leaves it to the device profile and the panel toggle. Drops only form at wetness 50 or more, on a watercolor stroke.',
          },
          dripAmount: {
            type: 'number',
            description: 'Drip density 0-2, default 1: 2 spawns drops twice as often and allows twice as many at once, 0 disables them for this stroke. Density only — it does not lengthen how far a drop runs: run length comes from the brush size (a larger brush falls harder) and from wetness, neither of which this knob touches.',
          },
                spacing: { type: 'number', description: 'Stamp spacing 1-100 percent of the brush size; 1 with a small size is the pencil setting.' },
                brushType: { type: 'string', description: 'watercolor, dry, splatter, circle, soft or flat; defaults to the current brush. See canvas_brushes.' },
                tool: { type: 'string', enum: ['brush', 'smudge'], description: 'brush paints (default); smudge drags existing pigment along the path.' },
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
            drip: stroke?.drip,
            dripAmount: stroke?.dripAmount,
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
    }, { when: whenToolGroupLoaded('sample') })

    scope.tools.register({
      name: 'canvas_record',
      description: 'Record the drawing process as a webm video, taken from the panel canvas stream rather than the undo stack (which keeps only ~50 frames and would replay a fragment). Start it before you paint, stop it when the painting is finished: the clip is written to <DSH_HOME>/canvas-recordings and the file path comes back. Frames are pulled only on ticks with real paint work and the encoder pauses while the picture is still, so idle time neither bloats the file nor the bitrate. The panel has to be open.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop'],
            description: 'start begins a recording; stop ends it, saves the webm and returns its path.',
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
        const action = args?.action === 'stop' ? 'stop' : 'start'
        const id = `record-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        // A start answers straight away; a stop has to flush the encoder and upload
        // the clip, which is one big base64 body.
        const timeout = action === 'start' ? 8000 : RECORD_TIMEOUT_MS
        const pending = new Promise((resolve) => {
          const timer = setTimeout(() => { pendingRecords.delete(id); resolve(undefined) }, timeout)
          pendingRecords.set(id, (payload) => { clearTimeout(timer); pendingRecords.delete(id); resolve(payload) })
        })
        if (!dispatch(sessionId, [{ type: 'recorder', action, id }])) {
          pendingRecords.delete(id)
          return { text: CARD_TEXT.notOpen }
        }
        const reply = await pending
        if (!reply || typeof reply !== 'object') {
          return { text: 'The panel did not answer in time. Keep the canvas panel open, and reload it after a bundle update.' }
        }
        if (!reply.ok) {
          return { text: action === 'start'
            ? `Could not start recording (${reply.reason ?? 'unknown'}). Reload the panel and try again.`
            : `Nothing was recorded (${reply.reason ?? 'unknown'}).` }
        }
        if (action === 'start') {
          return { text: 'Recording started. Paint, then call canvas_record stop to finish — the pause between strokes costs no frames.' }
        }
        const base64 = typeof reply.data === 'string' ? reply.data : ''
        if (!base64) return { text: 'The panel returned an empty recording.' }
        const bytes = Buffer.from(base64, 'base64')
        if (!bytes.length) return { text: 'The panel returned an empty recording.' }
        try {
          // The panel's settings carry a recording folder; only an absolute path is
          // honoured, and a broken one falls back to the harness default.
          await mkdir(RECORD_DIR, { recursive: true })
          let targetDir = RECORD_DIR
          const wanted = typeof reply.recordDir === 'string' ? reply.recordDir.trim() : ''
          if (wanted && isAbsolute(wanted)) {
            try {
              await mkdir(wanted, { recursive: true })
              targetDir = wanted
            } catch { /* keep the default */ }
          }
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const file = join(targetDir, `chubby-fish-${stamp}.webm`)
          await writeFile(file, bytes)
          const polished = await polishRecording(file)
          const seconds = Math.round((Number(reply.durationMs) || 0) / 1000)
          const frames = Number(reply.frames) || 0
          const lines = [
            `Recording saved: ${file}`,
            `${Math.round(bytes.length / 1024)} KB, ${frames} frames, about ${seconds}s of painting.`,
          ]
          if (polished.mp4) lines.push(`mp4 copy (plays anywhere, phones and editors included): ${polished.mp4}`)
          if (!polished.indexed) {
            lines.push('No ffmpeg on this host, so the webm carries no duration index: it plays, but editors may show an unknown length. Fix it with: ffmpeg -i in.webm -c copy out.webm')
          }
          return { text: lines.join('\n') }
        } catch (error) {
          return { text: `Recording could not be written: ${String(error && error.message || error)}` }
        }
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
