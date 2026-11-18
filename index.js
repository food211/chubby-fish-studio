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

// A spatially smooth displacement keeps neighbouring marks together, including
// the two ends of a closed outline and adjacent turns of a filled ellipse.
function wobble(points, amount, anchorEnds, minStep = 0) {
  if (!amount || points.length < 2) return points
  const phase = Array.from({length:4}, () => Math.random() * 2 * Math.PI)
  const scale = Math.max(8, amount * 3)
  const result = []
  const first = points[0], last = points[points.length-1]
  function displaced(p) {
    const x = p[0]/scale, y = p[1]/scale
    const fade = anchorEnds ? Math.min(1, Math.hypot(p[0]-first[0],p[1]-first[1])/scale,
      Math.hypot(p[0]-last[0],p[1]-last[1])/scale) : 1
    const dx = 0.55*Math.sin(x+0.7*y+phase[0]) + 0.45*Math.sin(0.45*x-y+phase[1])
    const dy = 0.55*Math.sin(0.8*x-y+phase[2]) + 0.45*Math.sin(x+0.35*y+phase[3])
    return [p[0]+amount*fade*dx, p[1]+amount*fade*dy, ...p.slice(2)]
  }
  result.push(displaced(first))
  for (let i=1; i<points.length; i++) {
    const a=points[i-1], b=points[i]
    const steps=Math.min(512, Math.ceil(Math.hypot(b[0]-a[0], b[1]-a[1])/Math.max(scale*0.75,minStep)))
    for (let j=1; j<steps; j++) {
      const t=j/steps
      const p=[a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t]
      if (a.length>2 || b.length>2) p.push((a[2]??1)*(1-t)+(b[2]??1)*t)
      result.push(displaced(p))
    }
    result.push(displaced(b))
  }
  return result
}

const PUSH_PATH = '/mpx/canvas/push'
const STREAM_PATH = '/mpx/canvas/stream'
const NUDGE_PATH = '/mpx/canvas/nudge'
const ASK_PATH = '/mpx/canvas/ask'
const SAMPLE_PATH = '/mpx/canvas/sample'
const DONE_PATH = '/mpx/canvas/done'
const RENDER_PATH = '/mpx/canvas/render'
const RECORD_PATH = '/mpx/canvas/record'
const SAVE_PATH = '/mpx/canvas/save'
const OPEN_PATH = '/mpx/canvas/open'
const SETTINGS_PATH = '/mpx/canvas/settings'
const LAST_PATH = '/mpx/canvas/last'
const DEBUG_PATH = '/mpx/canvas/debug'

import { createHash } from 'node:crypto'
import { polygonFill } from './polygon-fill.js'
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
    '- 可以按想要的笔迹选笔：氛围 → `watercolor`（浓度 100 / 湿度 100）；清晰造型 → `circle`、`soft`；线稿 → `flat` 小 size + `spacing` 1 + 浓度 75~90（像铅笔）；纹理 → `splatter`、`dry`。',
    '- `watercolor` 是氛围笔：浓度和湿度都设为 100 时适合铺湿润的色层，湿度降到 20 左右会出现干涩斑驳的边缘。',
    '- `dry` 是"同样纹理但不带水彩效果"的干笔；`splatter` 做喷溅纹理。',
    '- 只有 `circle`/`flat`/`soft` 是实色不透明；水彩白压深永远是灰的。',
    '- 宽度：水彩/干笔/喷溅 ≈ 2×size；`circle`/`flat`/`soft` ≈ 1×size。',
    '- 拿不准笔迹时，可以用 `canvas_brushes` 看实际样张。涂抹笔像手指推颜料，适合局部混色，也能沿笔路拉出纹理。',
    '- `wetness` 只管边缘扩散多远，不管深浅；要深靠浓度和叠笔。',
  ].join('\n'),
  'composition.md': [
    '# 构图与步骤',
    '',
    '- 可以先看走势和大色块，再按需要补轮廓、细节和高光。',
    '- 重画一遍通常比在旧稿上补丁更快：叠多了会发糊。',
    '- 画 Q 版时，可以试试让头部约占人物高度的一半，再根据角色调整。',
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
/** Panel preferences survive a restart here: the web origin (and its localStorage) does not. */
const SETTINGS_FILE = join(HARNESS_HOME, 'canvas-settings.json')
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
  'You cannot paint blind: `canvas_draw` refuses strokes until you have looked at the whole canvas this session, and again if the canvas has changed since that look (the user painted, undid, cleared, or the panel reloaded). After a refusal, look (a glance is enough), then draw — never retry it unchanged. Your own strokes and a confirmed clear let you continue painting directly.',
  '`canvas_draw` paints strokes and also carries `smudge` plus the undo/redo/clear actions; every stroke lands in the user undo stack. Points are canvas pixels, or fractions of the canvas when every value is in 0-1. `size` is the half-width on the wash brushes (they spread about twice it) and about the full width on circle/flat/soft.',
  'Keep a call to a handful of strokes, about eight: a long or wide call that gets mangled costs the whole batch, while small calls lose only their own. A path can be the compact string "0.36,0.60 0.37,0.65", sturdier for long paths, and curves are curves — "… q cx,cy x,y" is one arc.',
  'canvas_mask can select a region for brush and smudge on the shared canvas. Its edge jitter is sampled once per selection; set jitter to 0 for precision.',
  'When painting an illustration, aim for a hand-drawn feel that suits the subject. Direction, pressure and the rhythm of repeated marks can do as much as a little contour jitter.',
  'For a large shape, sketching its sweep and silhouette first can help. See canvas_guide for the thumbnail check. Use `ellipse: [cx, cy, rx, ry]` for an oval, `polygon` for a filled outline, `path` with `fill: true` for a curved silhouette, and `mirror: "x"` for a symmetrical pair.',
  'Depth comes from strength and a second pass, not from wetness: 20 is barely a stain, 77 lands about 60% of the pigment, only near 100 does the colour read as itself. Wetness is how far the edge travels (100 bleeds, 20 holds), so lower it to sharpen a shape rather than to darken it — and a watercolor at low wetness goes patchy, not solid.',
  'The drip run-off is a separate knob from wetness: per stroke `drip: "off"` suppresses it, `"on"` forces it, `"auto"` leaves it to the device and the panel toggle, and `dripAmount` 0-2 (1 is the default) sets how often drops spawn and how many are allowed at once. Drops only form at wetness 50 or more, on a `watercolor` stroke — so push wetness up first, then season with dripAmount rather than flooding the picture. `dripAmount` is density, not reach: how far a drop runs is fixed by the brush size and the wetness, so for longer runs use a larger brush or wetter paint, not a bigger amount.',
  'Possible brush choices include `watercolor` for atmosphere, `circle`/`soft` for clean opaque shapes, `flat` for blocks or (small size, `spacing` 1, strength 75-90) for pencil lines, `splatter` for grain, `dry` for broken bristle texture. The brush sheet gives example settings. No setting turns a watercolor white opaque over dark, and circle/flat/soft cannot make a wash.',
  'Eight tools are always available; four more (`canvas_guide`, `canvas_brushes`, `canvas_notes`, `canvas_sample`) load on demand so they do not cost every request — call `canvas_tools` with `load: "guide"` (or "brushes", "notes", "sample") and that tool is usable from your next step. The guide offers suggestions — layers, light, stroke intent, judging, when to repaint.',
  '`canvas_record` films the drawing as a webm: `start` before the strokes, `stop` after, and the clip lands under the harness home with its path returned. It reads the canvas stream, not the undo stack, so it captures the whole painting and not the last 50 frames; the panel has to be open.',
  'Pressure narrows and pales at once, so a silhouette drawn with tapered strokes comes out weak: full pressure can help establish a solid shape, and a taper can add finer ends. The pressureCurve affects how quickly the mark narrows.',
  'When the user asks for help with painting, look first, name one concrete problem, and demonstrate with one short stroke instead of a long description.',
  'The panel may start a turn when it decides the painting changed enough: treat that as an invitation to look and say one useful sentence, not to re-describe the canvas. Start with `canvas_glance` — the thumbnail is what that invitation is worth; only look closer on your own judgement when the thumbnail genuinely cannot answer the question.',
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
  '| `dry` | a dry brush 毛笔: split, forking bristles, deliberately rough — useful for broken texture | strength 100, low wetness | broken hairs with white gaps |',
  '| `splatter` | texture: spray, speckle, dust | strength 100 | dots, no solid core |',
  '| `smudge` (tool) | fingertip blending or a dragged texture | — | drags colour along the path |',
  '',
  'The drip run-off is its own switch, not a wetness value: `drip: "on" | "off" | "auto"` per stroke, and `dripAmount` 0-2 for how eagerly drops spawn and how many may run at once. It needs `watercolor` at wetness 50 or more; below that nothing spawns whatever the switch says. `dripAmount` changes density only — the distance a drop travels is set by the brush size and the wetness, so a longer run wants a bigger brush or wetter paint rather than a higher amount.',
  '',
  'Possible starting points include watercolor for atmosphere, circle for crisp shapes, soft for soft edges, and a small flat brush at spacing 1 and strength 75-90 for pencil-like marks. Smudge can blend neighbouring colours or pull an existing colour into streaks. Two things no setting changes: a watercolor white over dark stays grey however many passes it gets, and circle/flat/soft cannot make a wash. Width: circle/flat/soft paint about 1 x size, watercolor/dry/splatter about 2 x size.',
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
  "# Painting on this canvas",
  "",
  "## Composition and large shapes",
  "- A thumbnail can help you pick out the silhouette, the focal point and the largest colour masses. A few clearly separated values often carry a shape even in one hue.",
  "- One way into a large shape is to mark its ends, widest point and changes of direction. Long curves or straight edges can connect those landmarks while preserving a distinctive corner or notch.",
  "- A flat silhouette makes it easy to judge tilt, width and gaps. Filling inside that boundary can give a smoother contour than defining it with the ends of stacked horizontal strokes.",
  "- Where surfaces turn, fold or overlap, a light mass and a shadow mass may be enough. An uninterrupted plane can work as a single colour.",
  "",
  "## Layers and light",
  "- Working from distant shapes towards near ones makes overlaps easy. An underpainting can extend beneath later shapes; painting around a gap can preserve a sliver of paper or light.",
  "- Choosing a main light direction can help relate highlights and shadows. A cast shadow can suggest contact with the ground or the height of a lifted object.",
  "- A shadow can be painted as its own shape. Circle or flat gives a crisp edge; soft can lay down a gradual edge in the chosen shadow colour.",
  "",
  "## Choosing a mark",
  "- Circle and flat can give opaque forms and crisp silhouettes. Small flat strokes with tight spacing (around 1) can suggest pencil lines or hatching.",
  "- Soft has a solid core and a blurred rim. For a rounded cheek, a brush sized to the desired transition can lay in the shadow directly.",
  "- Smudge (`tool: \"smudge\"`) works like a fingertip moving pigment already on the canvas. A short stroke across adjoining colours can mix them locally; a longer pull can leave a directional streak. Near a contour, a smaller footprint can keep its shape intact.",
  "- Watercolor at high wetness can give a broad wash with a pooled edge. Dry can suggest broken fibres or stone, and splatter can suggest spray, grain or stars.",
  "- Pressure and taper can give a hair tip or a fold a lighter ending. Even pressure can suit a firm silhouette or a deliberately uniform graphic line.",
  "",
  "- For a hand-drawn contour, a little jitter (about 0.5-1.5 canvas pixels on a long hair strand or garment edge) can help. A small eye highlight or a precise join may read better with zero jitter.",
  "## A hand-drawn feel",
  "- For a hand-drawn finish, you might let a long contour swell through a turn and ease off toward its tip. A quiet, steady edge beside a more expressive stroke gives both a purpose.",
  "- Related marks can share a direction while varying slightly in length, spacing or pressure. For hair or folds, a few deliberate groups often read more naturally than evenly spaced parallel lines.",
  "- A brush-textured or gently uneven silhouette can suit cloth, hair or leaves. A selection with a little edge jitter can carry that same character through several colour passes; the displayed edge stays fixed until the selection changes.",
  "",
  "## Checking the result",
  "- A glance shows whether the masses read together. A zoom can help judge one edge, eye or colour transition.",
  "- If an area feels busy, quieter detail, a narrower palette or a broader repaint may help. If the shape already reads at the intended scale, it may need no further marks.",
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
 * Turn a raw recording into the formats the panel asked for.
 *
 * `both` (the default) keeps the webm and adds an mp4; `webm` leaves it alone; `mp4` and
 * `gif` are export-only and drop the webm once the conversion worked. All of it needs
 * ffmpeg on PATH — without it the webm is still a valid, playable file.
 * @param {string} file - the webm just written.
 * @param {string} format - both | webm | mp4 | gif.
 * @returns {Promise<{ indexed: boolean, mp4: string | null, gif: string | null, needsFfmpeg: boolean }>}
 */
async function exportRecording(file, format) {
  const mode = ['both', 'webm', 'mp4', 'gif'].includes(format) ? format : 'both'
  if (!await ffmpegAvailable()) {
    return { indexed: false, mp4: null, gif: null, needsFfmpeg: mode !== 'webm' }
  }
  // A stream copy fixes the missing duration index without touching a pixel.
  const temp = file.replace(/\.webm$/, '.indexed.webm')
  let indexed = false
  const copied = await runFfmpeg(['-v', 'error', '-y', '-i', file, '-c', 'copy', temp])
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

  let mp4 = null
  if (mode === 'both' || mode === 'mp4') {
    const target = file.replace(/\.webm$/, '.mp4')
    const done = await runFfmpeg([
      '-v', 'error', '-y', '-i', file,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20',
      '-movflags', '+faststart', target,
    ])
    if (done) mp4 = target
  }

  let gif = null
  if (mode === 'gif') {
    const target = file.replace(/\.webm$/, '.gif')
    // The recorder already cuts the still stretches out of the timeline, so there is
    // nothing to decimate here — mpdecimate would also eat the slow watercolour ramps,
    // whose frame-to-frame change sits under its threshold. Palette pass: one to build it,
    // one to dither through it, or the colours band.
    const done = await runFfmpeg([
      '-v', 'error', '-y', '-i', file,
      '-vf', 'fps=12,scale=680:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
      '-loop', '0', target,
    ])
    if (done) gif = target
  }

  // An export-only choice should not leave the raw file behind as clutter.
  if (mode === 'mp4' && mp4) { try { await unlink(file) } catch { /* gone */ } }
  if (mode === 'gif' && gif) { try { await unlink(file) } catch { /* gone */ } }
  return { indexed, mp4, gif, needsFfmpeg: false }
}

/**
 * The folder clips are written to.
 *
 * The panel picks it, but only an absolute path is honoured and the folder is created on
 * demand: a typo or a folder that cannot be made falls back to the harness default rather
 * than swallowing a recording.
 * @param {unknown} wanted - the folder the panel asked for.
 * @returns {Promise<string>} an existing absolute folder.
 */
async function prepareRecordingDir(wanted) {
  const path = typeof wanted === 'string' ? wanted.trim() : ''
  if (path && isAbsolute(path)) {
    try {
      await mkdir(path, { recursive: true })
      return path
    } catch { /* no such folder — keep the default below */ }
  }
  await mkdir(RECORD_DIR, { recursive: true })
  return RECORD_DIR
}

/**
 * The folder to report when nothing needs creating.
 * @param {unknown} wanted - the folder the panel asked for.
 * @returns {string} an absolute folder path.
 */
function recordingDirName(wanted) {
  const path = typeof wanted === 'string' ? wanted.trim() : ''
  return path && isAbsolute(path) ? path : RECORD_DIR
}

/**
 * Write one finished recording into the recording folder and export it.
 *
 * Both the agent's `canvas_record` stop and the panel's own ● button land here, so the
 * folder and the export format the user picked in the settings apply to either.
 * @param {Buffer} bytes - the webm the panel uploaded.
 * @param {unknown} wantedDir - the panel's recording folder.
 * @param {unknown} format - both | webm | mp4 | gif.
 * @returns {Promise<{ dir: string, files: string[], needsFfmpeg: boolean, indexed: boolean }>}
 */
async function saveRecordingClip(bytes, wantedDir, format) {
  const dir = await prepareRecordingDir(wantedDir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = join(dir, `chubby-fish-${stamp}.webm`)
  await writeFile(file, bytes)
  const polished = await exportRecording(file, typeof format === 'string' ? format : 'both')
  // An export-only format deletes the webm once the conversion worked, so list what is
  // actually on disk instead of announcing a file the next step removed.
  const files = []
  for (const candidate of [file, polished.mp4, polished.gif]) {
    if (!candidate) continue
    try {
      await stat(candidate)
      files.push(candidate)
    } catch { /* converted away, or the export failed */ }
  }
  return { dir, files, needsFfmpeg: polished.needsFfmpeg, indexed: polished.indexed }
}

/**
 * Show a folder in the desktop's file manager.
 *
 * This host composes a verified opener (Explorer, Finder, xdg-open) that rejects paths it
 * cannot map, so it is tried first; when it is missing or refuses, the platform command is
 * spawned directly. The spawn is detached because Explorer reports a non-zero exit even
 * when the window opened, and the panel must not sit waiting for a window.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} dir - existing absolute folder.
 * @returns {Promise<'host' | 'spawn'>} which opener took it.
 */
async function openFolder(ctx, dir) {
  const controller = ctx.get('sessionController')
  if (controller && typeof controller.openWorkspacePath === 'function') {
    try {
      await controller.openWorkspacePath({ path: dir }, AbortSignal.timeout(15000))
      return 'host'
    } catch { /* fall through to the platform command */ }
  }
  const command = process.platform === 'win32'
    ? 'explorer.exe'
    : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(command, [dir], { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => { /* no desktop, or no such opener */ })
    child.unref()
  } catch { /* nothing else to try */ }
  return 'spawn'
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
   * The panel decides when (its inbox threshold), this route only relays: the model is
   * asked to glance first and only look closer on its own judgement, so a live-mode nudge
   * costs a thumbnail instead of the full picture, and the look stays a normal tool call.
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
        + ' 先用 canvas_glance 瞟一眼（缩略图，最省）；只有缩略图上真的看不清、又需要判断细节时，才自己决定 canvas_zoom 或 canvas_look，不要默认直接整张看图。'
        + ' 然后用一两句话点评：指出一个具体问题，或肯定一个具体做法。'
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
   * Keep the panel's preferences across restarts.
   *
   * DSH web changes its port every launch, and localStorage is per origin, so a folder or
   * an export format kept only in the browser is gone the next time the app opens. The
   * panel writes the same object here on every apply and reads it back on mount.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SETTINGS_PATH,
    handler: async (req, res) => {
      if (req.method === 'GET') {
        let settings = {}
        try {
          const parsed = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))
          settings = parsed && typeof parsed === 'object' ? parsed : {}
        } catch { /* first run, or a torn file: the defaults below are the answer */ }
        // The panel shows the real folder instead of describing it, so the dialog can also
        // offer to open it before a single clip exists.
        let dir = recordingDirName(settings.recordDir)
        try { dir = await prepareRecordingDir(settings.recordDir) } catch { /* report the name only */ }
        json(res, 200, { ok: true, settings, dir, defaultDir: RECORD_DIR })
        return
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'method' }); return }
      let payload
      try {
        payload = JSON.parse((await readBody(req)).toString('utf8'))
      } catch {
        json(res, 400, { ok: false, reason: 'bad-json' })
        return
      }
      const settings = payload?.settings && typeof payload.settings === 'object' ? payload.settings : {}
      try {
        await mkdir(HARNESS_HOME, { recursive: true })
        await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8')
        json(res, 200, { ok: true })
      } catch (error) {
        json(res, 500, { ok: false, reason: String(error && error.message || error) })
      }
    },
  }), 'mixbox-palette: canvas settings route')

  /**
   * Save the clip the panel recorded with its own ● button.
   *
   * The encoder runs in the browser, so the bytes can only reach the disk as an upload.
   * Sending them here — instead of a browser download — means the recording folder and the
   * export format the user picked apply to their own recordings too, not only the agent's,
   * and the same folder button reaches them afterwards.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SAVE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'method' }); return }
      let payload
      try {
        payload = JSON.parse((await readBody(req, RECORD_BODY_BYTES)).toString('utf8'))
      } catch {
        json(res, 400, { ok: false, reason: 'bad-json' })
        return
      }
      const base64 = typeof payload?.data === 'string' ? payload.data : ''
      const bytes = base64 ? Buffer.from(base64, 'base64') : Buffer.alloc(0)
      if (!bytes.length) { json(res, 400, { ok: false, reason: 'empty-recording' }); return }
      try {
        const clip = await saveRecordingClip(bytes, payload?.dir, payload?.format)
        json(res, 200, {
          ok: true,
          dir: clip.dir,
          file: clip.files[0] ?? null,
          files: clip.files,
          needsFfmpeg: clip.needsFfmpeg,
          indexed: clip.indexed,
        })
      } catch (error) {
        json(res, 500, { ok: false, reason: String(error && error.message || error) })
      }
    },
  }), 'mixbox-palette: canvas clip save route')

  /**
   * Show the recording folder in the user's file manager.
   *
   * The panel runs in the browser and can neither list nor open a local folder, so a click
   * on 打开文件夹 comes here: the folder is created if the very first clip has not landed
   * yet, then handed to the desktop.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'method' }); return }
      let payload = {}
      try {
        payload = JSON.parse((await readBody(req)).toString('utf8')) || {}
      } catch { /* no body: the default folder */ }
      try {
        const dir = await prepareRecordingDir(payload?.dir)
        const opened = await openFolder(ctx, dir)
        json(res, 200, { ok: true, dir, opened })
      } catch (error) {
        json(res, 500, { ok: false, reason: String(error && error.message || error) })
      }
    },
  }), 'mixbox-palette: canvas folder route')

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
  async function dispatchAndWait(sessionId, ops) {
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
      return null
    }
    return finished
  }

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
      name: 'canvas_mask',
      description: 'Set a shared painting selection on this canvas, inspect it or clear it. Brush and smudge writes are clipped, including their soft edges. The dashed preview is not exported. Clear/undo/redo still act on the whole canvas. Selection lasts until released or the panel reloads. Jitter is sampled once when setting it.',
      parameters: {type:'object',additionalProperties:false,properties:{
        action:{type:'string',enum:['set','clear','status']},
        rect:{type:'array',items:{type:'number'},description:'[x1,y1,x2,y2], opposite corners'},
        polygon:{type:'array',items:{type:'array',items:{type:'number'}},description:'3–48 outline vertices, e.g. [[100,100],[200,120],[150,180]]'},
        unit:{type:'string',enum:['pixels','ratio']},
        jitter:{type:'number',minimum:0,maximum:20,description:'Edge wobble in canvas pixels, default 1. Use 0 for a precise edge.'}
      }},
      output:{schema:{type:'object',additionalProperties:true},render(_args,v){return [{type:'text',text:v.text}]}},
      async execute(args,exec) {
        const found = await snapshotFor(exec)
        if (!found) return {text:CARD_TEXT.notOpen}
        const {entry,sessionId} = found
        const action = args.action || 'status'
        if (action === 'status') return {text:JSON.stringify({unit:'ratio',polygon:entry.meta?.mask || null})}
        let mask = null
        if (action === 'set') {
          let vertices = args.polygon
          if (args.rect && !vertices && args.rect.length === 4) {
            const [x,y,r,b] = args.rect
            vertices = [[x,y],[r,y],[r,b],[x,b]]
          } else if (args.rect) return {text:'Supply one rect or polygon.'}
          if (!Array.isArray(vertices) || vertices.length<3 || vertices.length>48 || !vertices.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite))) return {text:'Expected 3–48 finite coordinate pairs.'}
          const {width,height} = entry.meta?.canvas || {}
          if (!width || !height) return {text:'Canvas dimensions unavailable.'}
          const ratio = args.unit === 'ratio' || (!args.unit && vertices.every(p=>p.every(v=>v>=0&&v<=1)))
          const pts = vertices.map(([x,y])=>ratio?[x*width,y*height]:[x,y])
          if (pts.some(([x,y])=>x<0||x>width||y<0||y>height)) return {text:'Keep the selection vertices inside the canvas.'}
          const area = pts.reduce((sum,p,i)=>{const q=pts[(i+1)%pts.length];return sum+p[0]*q[1]-p[1]*q[0]},0)
          if (Math.abs(area)<1) return {text:'The selection must enclose an area.'}
          const amount = Math.max(0, Math.min(20, args.jitter ?? 1))
          const closed = [...pts,pts[0]]
          const perimeter = pts.reduce((n,p,i)=>n+Math.hypot(p[0]-closed[i+1][0],p[1]-closed[i+1][1]),0)
          const edge = wobble(closed,amount,false,perimeter/(64-pts.length)).slice(0,-1)
          mask=edge.map(([x,y])=>[Math.max(0,Math.min(1,x/width)),Math.max(0,Math.min(1,y/height))])
        } else if (action !== 'clear') return {text:'Expected set, clear or status.'}
        const ok = await dispatchAndWait(sessionId,[{type:'mask',mask}])
        if (!ok || JSON.stringify(snapshots.get(sessionId)?.meta?.mask ?? null)!==JSON.stringify(mask)) return {text:'Selection change not confirmed; inspect canvas_mask status.'}
        return {text: mask ? 'Selection active. Brush and smudge are clipped to the displayed boundary.' : 'Selection cleared.'}
      }
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
      description: 'A general method for painting here: what a viewer reads first, how to layer, and what each tool adds that the others cannot - soft brushes for gradual edges, watercolor for light and mood, pressure for stroke life - plus light, working rhythm and the usual failure modes. No canvas needed; it can be consulted when planning or revising a painting.',
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
      description: 'Paint on the user painting canvas through the same pigment-mixing pipeline the user paints with, or undo / redo / clear. Coordinates are canvas pixels, or 0-1 fractions of the canvas when every value is within 0-1 (measure those straight off a glance). Every change enters the user undo stack. Refuses strokes until you have looked at or cleared this session canvas, and again if the canvas changed since that look.',
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
                fill: { type: 'boolean', description: 'With path: close the outline and fill it in one stroke. Mix straight segments with q and c curves; optional final z. Example: 100,150 q 130,70 200,120 c 185,145 145,185 100,150.' },
                polygon: {
                  type: 'array',
                  description: 'Fill a polygon instead of sweeping: [[x, y], …], at least three vertices, units of points. One continuous stroke follows the outline and winds inward.',
                },
                seam: {
                  type: 'number',
                  description: 'With a filled ellipse: the angle (degrees, 0 = right) where the spiral hides its inward tail. Cosmetic only.',
                },
                jitter: {
                  type: 'number',
                  description: 'Optional smooth wobble in canvas pixels (0-20) for lines, curves and shape outlines. Try 0.5-1.5 on long ink lines; zero keeps the original path.',
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
                tool: { type: 'string', enum: ['brush', 'smudge'], description: 'brush paints (default); smudge moves existing pigment like a fingertip for blending colours or pulling streaks. A soft brush can paint a soft edge directly.' },
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
          if (action === 'clear') {
            const confirmed = await dispatchAndWait(sessionId, [{ type: action }])
            if (confirmed === null) return { text: CARD_TEXT.notOpen }
            if (!confirmed) {
              lastSeen.delete(sessionId)
              return { text: 'Clear requested; the panel has not confirmed the new canvas. Check with canvas_glance before painting.' }
            }
            lastSeen.set(sessionId, stampOf(snapshots.get(sessionId)))
            return { text: 'Cleared the canvas. Ready to paint.' }
          }
          if (!dispatch(sessionId, [{ type: action }])) return { text: CARD_TEXT.notOpen }
          // The canvas moved under the model's feet: the next stroke needs a fresh look,
          // but undoing is not painting, so it needs no look itself.
          lastSeen.delete(sessionId)
          const said = action === 'undo' ? 'Undid one step.' : 'Redid one step.'
          return { text: `${said} The canvas no longer matches what you saw, so look again (canvas_glance or canvas_look) before the next stroke.` }
        }

        const refusal = drawGuardText(sessionId)
        if (refusal) return { text: refusal }

        let strokes = Array.isArray(args?.strokes) ? args.strokes : []
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
              ...([from,control,to].some(p=>p.length>2) ? [u*u*(from[2]??1)+2*u*t*(control[2]??1)+t*t*(to[2]??1)] : []),
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
              ...([from,controlA,controlB,to].some(p=>p.length>2) ? [u*u*u*(from[2]??1)+3*u*u*t*(controlA[2]??1)+3*u*t*t*(controlB[2]??1)+t*t*t*(to[2]??1)] : []),
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
        // Linear interpolation error is bounded by max |B''| / (8 * steps²).
        function curveSteps(control) {
          let bend = 0
          for (let i = 2; i < control.length; i++) {
            const [a,b,c] = control.slice(i-2, i+1)
            bend = Math.max(bend, Math.hypot(a[0]-2*b[0]+c[0], a[1]-2*b[1]+c[1]))
          }
          const degree = control.length - 1
          return Math.min(512, Math.max(2, Math.ceil(Math.sqrt(bend * degree * (degree-1) / 2))))
        }
        const parsePath = (text, pixelCurves = false) => {
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
              points.push(...sampleQuadratic(from, pending[0], pending[1], pixelCurves ? curveSteps([from,...pending]) : 12))
              pending = []
              mode = 'line'
            } else if (mode === 'c' && pending.length === 3) {
              points.push(...sampleCubic(from, pending[0], pending[1], pending[2], pixelCurves ? curveSteps([from,...pending]) : 16))
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
        // Convert a single closed outline to pixel coordinates before sampling Béziers.
        // Straight segments and the joins between curves keep their authored corners.
        function filledPath(stroke) {
          if (!stroke?.fill) return stroke
          if (typeof stroke.path !== 'string' || stroke.points || stroke.polygon || stroke.ellipse) {
            throw Error('Use fill: true with one path string.')
          }
          const tokens = stroke.path.trim().split(/[\s;]+/)
          if (/^m$/i.test(tokens[0])) tokens.shift()
          if (/^z$/i.test(tokens.at(-1))) tokens.pop()
          const coords = []
          let needed = 0
          for (const token of tokens) {
            if (/^[qlc]$/i.test(token)) {
              if (!coords.length || needed) throw Error('Incomplete segment in filled path.')
              needed = { l:1, q:2, c:3 }[token.toLowerCase()]
            } else {
              const pair = token.split(',')
              if (pair.length !== 2 || pair.some(n => !n || !Number.isFinite(Number(n)))) throw Error('Expected x,y in filled path.')
              coords.push(pair.map(Number))
              if (needed) needed--
            }
          }
          if (needed || coords.length < 3) throw Error('A filled outline needs a complete curve or at least three vertices.')
          const ratio = stroke.unit === 'ratio' || (!stroke.unit && looksLikeFractions(coords))
          if (ratio && (!canvasWidth || !canvasHeight)) throw Error('Look at the canvas first to get its size.')
          let index = 0
          const path = tokens.map(token => {
            if (!token.includes(',')) return token
            const [x,y] = coords[index++]
            return ratio ? [x*canvasWidth,y*canvasHeight].join(',') : token
          }).join(' ')
          return { ...stroke, path: undefined, unit: 'pixels', polygon: parsePath(path, true).points }
        }
        try {
          strokes = strokes.map(filledPath)
        } catch (error) {
          return { text: 'Not painted: ' + error.message }
        }
        if (strokes.some((stroke) => readStroke(stroke).asRatio) && (!canvasWidth || !canvasHeight)) {
          return { text: 'These strokes are given as fractions of the canvas, but the host does not know the canvas size yet, so the fractions cannot be turned into pixels. Call canvas_glance (or canvas_look) once, then send them again.' }
        }
        let outOfBounds = 0
        /** Turn one stroke spec into one or more point arrays (including mirrored shapes). */
        const plansFor = (stroke) => {
          const polygon = readPolygon(stroke)
          const jitter = Math.max(0, Math.min(20, Number(stroke?.jitter) || 0))
          if (polygon) {
            const outline = jitter ? wobble([...polygon, polygon[0]], jitter, false) : polygon
            const fill = polygonFill(outline, Number(stroke.size) || Number(metaObject.brush?.size) || 40)
            stroke.size = fill.size
            return fill.points.length ? [fill.points] : []
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
          return [wobble(points, jitter, !stroke.ellipse || Number.isFinite(stroke.from) || Number.isFinite(stroke.to))]
        }
        const ops = strokes.flatMap((input) => {
          const stroke = { ...input }
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
        const acked = await dispatchAndWait(sessionId, ops)
        if (acked === null) return { text: CARD_TEXT.notOpen }
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
      description: 'Record the drawing process as a webm video, taken from the panel canvas stream rather than the undo stack (which keeps only ~50 frames and would replay a fragment). Start it before you paint, stop it when the painting is finished: the clip is written to the folder picked in the panel settings (the harness home canvas-recordings by default) and the file path comes back. Frames are pulled only on ticks with real paint work and the encoder pauses while the picture is still, so idle time neither bloats the file nor the bitrate. The panel has to be open.',
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
          // The panel's settings carry a recording folder and an export format; the clip
          // goes where the user's own ● button puts it.
          const clip = await saveRecordingClip(bytes, reply.recordDir, reply.recordFormat)
          const seconds = Math.round((Number(reply.durationMs) || 0) / 1000)
          const frames = Number(reply.frames) || 0
          const lines = [
            `Recording saved in ${clip.dir}:`,
            ...clip.files.map((saved) => `- ${saved}`),
            `${Math.round(bytes.length / 1024)} KB, ${frames} frames, about ${seconds}s of painting.`,
          ]
          if (clip.needsFfmpeg) {
            lines.push('This export format needs ffmpeg, which is not on this host: the clip was kept as webm. Install ffmpeg, or pick the webm format in the panel settings.')
          } else if (!clip.indexed) {
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
