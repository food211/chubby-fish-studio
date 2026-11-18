import Clipper from 'clipper-lib'

// Clipper offsets integer contours. Keep subpixel precision on the way in and out.
const SCALE = 256
function inset(ring, pixels) {
  const offset = new Clipper.ClipperOffset(2, SCALE * 0.25)
  offset.AddPath(ring, Clipper.JoinType.jtRound, Clipper.EndType.etClosedPolygon)
  const result = []
  offset.Execute(result, -Math.round(pixels * SCALE))
  return result
}

function nearestEdge(ring, point) {
  let best
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    const dx = b.X - a.X, dy = b.Y - a.Y
    const t = Math.max(0, Math.min(1, ((point.X-a.X)*dx + (point.Y-a.Y)*dy) / (dx*dx+dy*dy || 1)))
    const foot = { X: a.X+t*dx, Y: a.Y+t*dy }
    const distance = Math.hypot(point.X-foot.X, point.Y-foot.Y)
    if (!best || distance < best.distance) best = { edge:i, t, foot, distance }
  }
  return best
}

export function polygonFill(vertices, requestedSize) {
  const outline = Clipper.Clipper.CleanPolygon(vertices.map(([x,y]) => ({ X:Math.round(x*SCALE), Y:Math.round(y*SCALE) })), 0.5)
  if (outline.length < 3) return { points: [], size: requestedSize }
  if (!Clipper.Clipper.Orientation(outline)) outline.reverse()
  let size = Math.max(1, requestedSize)
  let rings = inset(outline, size * 0.45)
  // A wide nib can erase a narrow neck on the very first inset.
  while (rings.length !== 1 && size > 1) {
    size = Math.max(1, size / 2)
    rings = inset(outline, size * 0.45)
  }
  const points = []
  function add(p) {
    const x = p.X/SCALE, y = p.Y/SCALE
    const last = points[points.length-1]
    if (!last || last[0] !== x || last[1] !== y) points.push([x,y])
  }
  // A full circuit establishes the silhouette. When erosion splits a concave
  // region, visit its lobes via the parent contour, never across the empty gap.
  function visit(ring, returnToStart) {
    for (const p of ring) add(p)
    add(ring[0])
    const branches = inset(ring, size * 0.43).map(child => {
      let start = 0
      for (let i=1; i<child.length; i++) {
        if (Math.hypot(child[i].X-ring[0].X, child[i].Y-ring[0].Y) < Math.hypot(child[start].X-ring[0].X, child[start].Y-ring[0].Y)) start=i
      }
      return { child: child.slice(start).concat(child.slice(0,start)), ...nearestEdge(ring,child[start]) }
    }).sort((a,b) => a.edge-b.edge || a.t-b.t)
    let edge = 0
    for (const [i, branch] of branches.entries()) {
      while (edge < branch.edge) add(ring[++edge])
      add(branch.foot)
      const returning = returnToStart || i+1 < branches.length
      visit(branch.child, returning)
      if (returning) add(branch.foot)
    }
    if (returnToStart && branches.length) {
      while (++edge < ring.length) add(ring[edge])
      add(ring[0])
    }
  }
  // The browser clips the pigment footprint. Trace the true contour first to reach sharp tips.
  visit(outline, false)
  return { points, size }
}
