import { contextBar } from './segments'
import type { Segment } from './segments'

export const DOT = '●'
export const SEGMENT_GAP = 2

// Terminal cells: astral characters (emoji like 🤖) take two, the rest one.
export const cellWidth = (text: string) =>
  [...text].reduce((cells, char) => cells + ((char.codePointAt(0) ?? 0) > 0xffff ? 2 : 1), 0)

// The runs a terminal segment draws, in order: dot, padded icon, the bar of a percent gauge, value.
export const segmentRuns = ({ icon, value, percent }: Pick<Segment, 'icon' | 'value' | 'percent'>) => ({
  dot: DOT,
  icon: ` ${icon} `,
  ...(percent === undefined ? {} : { bar: `${contextBar(percent)} ` }),
  value,
})

// A hover card opens on the segment's own row, just past the drawn segment and the gap after it.
export const cardLeft = (segment: Pick<Segment, 'icon' | 'value' | 'percent'>) =>
  cellWidth(Object.values(segmentRuns(segment)).join('')) + SEGMENT_GAP
