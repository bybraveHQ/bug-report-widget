interface Point {
  x: number
  y: number
}

export type RectAnn = { tool: 'rect'; start: Point; end: Point }
export type ArrowAnn = { tool: 'arrow'; start: Point; end: Point }
export type PencilAnn = { tool: 'pencil'; points: Point[] }
export type TextAnn = { tool: 'text'; pos: Point; text: string; fontSize: number }
export type Annotation = RectAnn | ArrowAnn | PencilAnn | TextAnn

const HIT_PAD = 12

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x,
    dy = b.y - a.y
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

export function hitTest(ann: Annotation, p: Point): boolean {
  if (ann.tool === 'rect') {
    const x0 = Math.min(ann.start.x, ann.end.x),
      x1 = Math.max(ann.start.x, ann.end.x)
    const y0 = Math.min(ann.start.y, ann.end.y),
      y1 = Math.max(ann.start.y, ann.end.y)
    return p.x >= x0 - HIT_PAD && p.x <= x1 + HIT_PAD && p.y >= y0 - HIT_PAD && p.y <= y1 + HIT_PAD
  }
  if (ann.tool === 'arrow') return distToSegment(p, ann.start, ann.end) < HIT_PAD * 2
  if (ann.tool === 'pencil') {
    for (let i = 1; i < ann.points.length; i++) {
      if (distToSegment(p, ann.points[i - 1]!, ann.points[i]!) < HIT_PAD) return true
    }
    return false
  }
  if (ann.tool === 'text') {
    return (
      p.x >= ann.pos.x - HIT_PAD &&
      p.x <= ann.pos.x + 200 &&
      p.y >= ann.pos.y - ann.fontSize &&
      p.y <= ann.pos.y + HIT_PAD
    )
  }
  return false
}

export function moveAnnotation(ann: Annotation, dx: number, dy: number): Annotation {
  if (ann.tool === 'rect' || ann.tool === 'arrow') {
    return {
      ...ann,
      start: { x: ann.start.x + dx, y: ann.start.y + dy },
      end: { x: ann.end.x + dx, y: ann.end.y + dy },
    }
  }
  if (ann.tool === 'pencil')
    return { ...ann, points: ann.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })) }
  if (ann.tool === 'text') return { ...ann, pos: { x: ann.pos.x + dx, y: ann.pos.y + dy } }
  return ann
}
