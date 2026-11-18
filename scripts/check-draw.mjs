/**
 * Check that canvas_draw legalises what it is given instead of failing or painting nowhere.
 *
 * No panel is involved: a fake SSE stream receives the ops and the ack goes back through the
 * same done route a real panel uses. Covers the fraction band, the numeric knobs, pixel
 * coordinates, a filled path and pressure.
 */
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, group } from './lib.mjs'

export async function run() {
  const g = group('draw')
  const routes = new Map()
  const tools = new Map()
  const frames = []
  const attachments = { saveImage: async () => ({ width: 680, height: 572, mediaType: 'image/webp' }) }
  const scope = () => ({
    tools: { register: (definition) => tools.set(definition.name, definition) },
    get: (name) => (name === 'attachments' ? attachments : undefined),
    systemPrompt: { section() {} },
    // index.js also registers its skill; this check does not care about it.
    skills: { register: () => () => {} },
    effect: (fn) => { fn(); return () => {} },
  })
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    webServer: { register: (definition) => { routes.set(definition.path, definition.handler); return () => {} } },
    get: () => undefined,
    inject: (_names, callback) => callback(scope()),
    on: () => {},
    logger: { warn() {} },
  }
  const { apply } = await import(pathToFileURL(join(ROOT, 'index.js')).href)
  apply(ctx)

  const request = async (path, method, body) => {
    const handler = routes.get(path)
    if (!handler) throw new Error(`missing route ${path}`)
    const req = new EventEmitter()
    req.method = method
    req.url = path
    req.destroy = () => {}
    const res = { status: 0, text: '', writeHead(code) { this.status = code }, end(text) { this.text = text } }
    const pending = handler(req, res)
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
    await pending
    return res.text ? JSON.parse(res.text) : null
  }

  // Stand up one fake panel and its snapshot, then take a look so the draw guard is satisfied.
  const streamReq = new EventEmitter()
  streamReq.method = 'GET'
  streamReq.url = '/mpx/canvas/stream?sessionId=check'
  streamReq.destroy = () => {}
  const streamRes = new EventEmitter()
  streamRes.write = (chunk) => { frames.push(chunk); return true }
  streamRes.end = () => {}
  streamRes.writeHead = () => {}
  streamRes.setHeader = () => {}
  routes.get('/mpx/canvas/stream')(streamReq, streamRes)
  await request('/mpx/canvas/push', 'POST', {
    sessionId: 'check',
    png: 'data:image/webp;base64,AAAA',
    meta: { canvas: { width: 680, height: 572 } },
  })
  const exec = { agent: { session: { id: 'check' } } }
  await tools.get('canvas_look').execute({}, exec)

  const draw = async (args) => {
    frames.length = 0
    const pending = tools.get('canvas_draw').execute(args, exec)
    let ackId
    for (let tick = 0; tick < 400 && !ackId; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      for (const frame of frames) {
        const match = /data: (.*)\n\n/s.exec(frame)
        if (!match) continue
        for (const op of JSON.parse(match[1]).ops) if (op.type === 'flush-ack') ackId = op.id
      }
    }
    if (!ackId) throw new Error('the tool never asked for an ack')
    await request('/mpx/canvas/done', 'POST', { sessionId: 'check', id: ackId })
    const result = await pending
    const ops = []
    for (const frame of frames) {
      const match = /data: (.*)\n\n/s.exec(frame)
      if (!match) continue
      for (const op of JSON.parse(match[1]).ops) if (op.type === 'stroke') ops.push(op)
    }
    return { text: result.text, ops }
  }

  const inside = (points) => points.every(([x, y]) => x >= 0 && y >= 0 && x <= 680 && y <= 572)

  const overshoot = await draw({ strokes: [{ path: '0.2,0.2 0.3,1.02', brushType: 'circle', size: 30 }] })
  const overshootPoints = overshoot.ops.flatMap((op) => op.points)
  g.check(overshoot.ops.length === 1, 'fraction with one overshoot value still paints', `${overshoot.ops.length} stroke`)
  g.check(inside(overshootPoints), 'overshoot coordinates land on the canvas', JSON.stringify(overshootPoints.at(-1)))
  g.check(/Corrected to a legal value/.test(overshoot.text), 'the reply names the correction')

  const knobs = await draw({ strokes: [{ path: '0.2,0.2 0.3,0.3', brushType: 'oil', color: 'blue', size: 900, strength: 150, wetness: 120, spacing: 0, dripAmount: 5 }] })
  const op = knobs.ops[0] || {}
  g.check(op.size === 600, 'size clamps to 600', String(op.size))
  g.check(op.strength === 100, 'strength clamps to 100', String(op.strength))
  g.check(op.wetness === 100, 'wetness clamps to 100', String(op.wetness))
  g.check(op.spacing === 1, 'spacing clamps to 1', String(op.spacing))
  g.check(op.dripAmount === 2, 'dripAmount clamps to 2', String(op.dripAmount))
  g.check(op.brushType === undefined, 'unknown brush dropped', String(op.brushType))
  g.check(op.color === undefined, 'unreadable colour dropped', String(op.color))

  const pixels = await draw({ strokes: [{ path: '0.5,0.5 -20,700', unit: 'pixels', size: 30 }] })
  g.check(inside(pixels.ops.flatMap((entry) => entry.points)), 'pixel coordinates are pulled onto the canvas')

  const filled = await draw({ strokes: [{ path: '0.2,0.2 q 0.4,0.1 0.6,0.2 l 0.62,1.05 l 0.2,1.04 z', fill: true, size: 20 }] })
  g.check(filled.ops.length === 1 && filled.ops[0].points.length > 10, 'filled path expands', `${filled.ops[0]?.points.length ?? 0} points`)
  g.check(inside(filled.ops.flatMap((entry) => entry.points)), 'filled path stays on the canvas')

  const pressure = await draw({ strokes: [{ path: '0.2,0.2:2 0.3,1.1:-1', unit: 'ratio', usePressure: true, size: 30 }] })
  const pressures = pressure.ops.flatMap((entry) => entry.points).filter((point) => point.length > 2).map((point) => point[2])
  g.check(pressures.every((value) => value >= 0 && value <= 1), 'pressure clamps into 0-1', pressures.join('/'))

  streamRes.emit('close')
  return g.results
}
