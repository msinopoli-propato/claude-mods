import type { Segment } from './segments'

// Nerd Font round caps; only the terminal is sure to have the glyphs.
export const CAP_LEFT = ''
export const CAP_RIGHT = ''
export const PILL_GAP = 1

export const pad = (text: string) => ` ${text} `

// Terminal cells: astral characters (emoji like 🤖) take two, the rest one.
export const cellWidth = (text: string) =>
  [...text].reduce((cells, char) => cells + ((char.codePointAt(0) ?? 0) > 0xffff ? 2 : 1), 0)

// A hover card opens on the pill's own row, just past the drawn pill and the gap after it.
export const hoverCardLeft = ({ icon, value }: Pick<Segment, 'icon' | 'value'>, hasCaps: boolean) =>
  (hasCaps ? cellWidth(CAP_LEFT) + cellWidth(CAP_RIGHT) : 0) + cellWidth(pad(icon)) + cellWidth(pad(value)) + PILL_GAP
