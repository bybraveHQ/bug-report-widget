import { describe, it, expect } from 'vitest'
import {
  hitTest,
  moveAnnotation,
  distToSegment,
  type RectAnn,
  type ArrowAnn,
  type PencilAnn,
  type TextAnn,
} from './geometry'

const rect: RectAnn = { tool: 'rect', start: { x: 10, y: 10 }, end: { x: 100, y: 50 } }
const arrow: ArrowAnn = { tool: 'arrow', start: { x: 0, y: 0 }, end: { x: 100, y: 0 } }
const pencil: PencilAnn = {
  tool: 'pencil',
  points: [
    { x: 0, y: 0 },
    { x: 50, y: 50 },
    { x: 100, y: 0 },
  ],
}
const text: TextAnn = { tool: 'text', pos: { x: 20, y: 40 }, text: 'note', fontSize: 18 }

describe('distToSegment', () => {
  it('measures perpendicular distance to the segment', () => {
    expect(distToSegment({ x: 50, y: 10 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(10)
  })

  it('clamps to endpoints beyond the segment', () => {
    expect(distToSegment({ x: -30, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(30)
  })

  it('degenerates to point distance for zero-length segments', () => {
    expect(distToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5)
  })
})

describe('hitTest', () => {
  it('hits inside and near a rect (with padding), misses far away', () => {
    expect(hitTest(rect, { x: 50, y: 30 })).toBe(true)
    expect(hitTest(rect, { x: 5, y: 5 })).toBe(true) // within HIT_PAD
    expect(hitTest(rect, { x: 200, y: 200 })).toBe(false)
  })

  it('normalizes inverted rect corners', () => {
    const inverted: RectAnn = { tool: 'rect', start: { x: 100, y: 50 }, end: { x: 10, y: 10 } }
    expect(hitTest(inverted, { x: 50, y: 30 })).toBe(true)
  })

  it('hits near the arrow line only', () => {
    expect(hitTest(arrow, { x: 50, y: 10 })).toBe(true)
    expect(hitTest(arrow, { x: 50, y: 60 })).toBe(false)
  })

  it('hits near any pencil segment', () => {
    expect(hitTest(pencil, { x: 25, y: 25 })).toBe(true)
    expect(hitTest(pencil, { x: 50, y: 0 })).toBe(false)
  })

  it('hits the text box area', () => {
    expect(hitTest(text, { x: 60, y: 35 })).toBe(true)
    expect(hitTest(text, { x: 60, y: 100 })).toBe(false)
  })
})

describe('moveAnnotation', () => {
  it('shifts rect and arrow endpoints', () => {
    const moved = moveAnnotation(rect, 5, -5) as RectAnn
    expect(moved.start).toEqual({ x: 15, y: 5 })
    expect(moved.end).toEqual({ x: 105, y: 45 })
    const movedArrow = moveAnnotation(arrow, 1, 2) as ArrowAnn
    expect(movedArrow.end).toEqual({ x: 101, y: 2 })
  })

  it('shifts every pencil point', () => {
    const moved = moveAnnotation(pencil, 10, 10) as PencilAnn
    expect(moved.points).toEqual([
      { x: 10, y: 10 },
      { x: 60, y: 60 },
      { x: 110, y: 10 },
    ])
  })

  it('shifts text position and keeps content', () => {
    const moved = moveAnnotation(text, -5, 5) as TextAnn
    expect(moved.pos).toEqual({ x: 15, y: 45 })
    expect(moved.text).toBe('note')
  })

  it('does not mutate the original annotation', () => {
    moveAnnotation(rect, 100, 100)
    expect(rect.start).toEqual({ x: 10, y: 10 })
  })
})
