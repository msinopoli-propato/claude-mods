import type { Segment } from './segments'

// Half-disc caps from Geometric Shapes: every font has them, unlike Nerd Font powerline glyphs, so every
// surface rounds the pill. The engine has no border radius; a glyph is the only way to round a Text run.
export const CAP_LEFT = '◖'
export const CAP_RIGHT = '◗'
export const PILL_GAP = 1

export const pad = (text: string) => ` ${text} `

// Terminal cells: astral characters (emoji like 🤖) take two, the rest one.
export const cellWidth = (text: string) =>
  [...text].reduce((cells, char) => cells + ((char.codePointAt(0) ?? 0) > 0xffff ? 2 : 1), 0)

// A hover card opens on the pill's own row, just past the drawn pill and the gap after it.
export const hoverCardLeft = ({ icon, value }: Pick<Segment, 'icon' | 'value'>) =>
  cellWidth(CAP_LEFT) + cellWidth(pad(icon)) + cellWidth(pad(value)) + cellWidth(CAP_RIGHT) + PILL_GAP
