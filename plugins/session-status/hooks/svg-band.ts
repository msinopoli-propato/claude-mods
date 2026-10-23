import { LATTE, MACCHIATO, ROLE_HUES, tint } from './palette'
import type { Flavor, Role } from './palette'
import type { Segment } from './segments'
import { cellWidth } from './text-band'

// No script measures text in the frame, so widths are counted: a monospace face at 12px and 0.6em a cell,
// a little generous for Consolas so a value never overflows its capsule.
const FONT = "Consolas, 'Cascadia Mono', ui-monospace, monospace"
const FONT_SIZE = 12
const ADVANCE = 7.2
const HEIGHT = 24
const CAPSULE = 22
const CY = HEIGHT / 2
const INSET = 10
const DOT_RADIUS = 3.5
const ICON_X = 12
const VALUE_GAP = 5
const SEGMENT_GAP = 16
const BAR = 40
const BAR_GAP = 6
const BAR_MIN = 6

const ROLE_CLASSES: Record<Role, string> = {
  workItem: 'r-wi',
  branch: 'r-branch',
  timer: 'r-timer',
  ok: 'r-ok',
  warning: 'r-warning',
  error: 'r-error',
  muted: 'r-muted',
}

export const escapeXml = (text: string) =>
  text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char] ?? char)

// One decimal: 7.2px cells add up to float noise otherwise.
const px = (value: number) => String(Math.round(value * 10) / 10)

const textWidth = (text: string) => cellWidth(text) * ADVANCE

const rules = (flavor: Flavor) =>
  [
    `.cap{fill:${flavor.surface}}`,
    `.muted{fill:${flavor.overlay}}`,
    `.text{fill:${flavor.text}}`,
    `.track{fill:${tint(flavor.text, flavor.base, 0.2)}}`,
    ...Object.entries(ROLE_CLASSES).map(([role, name]) => `.${name}{fill:${flavor[ROLE_HUES[role as Role]]}}`),
  ].join('')

// The mod cannot know the app's theme, so the frame's own color scheme picks the flavor.
const STYLE = `<style>${rules(LATTE)}@media (prefers-color-scheme: dark){${rules(MACCHIATO)}}</style>`

const text = (name: string, x: number, content: string, bold = false) =>
  `<text class="${name}" x="${px(x)}" y="${CY}"${bold ? ' font-weight="700"' : ''} dominant-baseline="central">` +
  `${escapeXml(content)}</text>`

const bar = (name: string, x: number, width: number) =>
  `<rect class="${name}" x="${px(x)}" y="${CY - 3}" width="${px(width)}" height="6" rx="3"/>`

const valueWidth = ({ value, percent }: Segment) => (percent === undefined ? 0 : BAR + BAR_GAP) + textWidth(value)

// A warning or an error colors the value too; anything else reads in the text color.
const valueClass = ({ role }: Segment) => (role === 'warning' || role === 'error' ? ROLE_CLASSES[role] : 'text')

const drawSegment = (segment: Segment, x: number) => {
  const role = ROLE_CLASSES[segment.role]
  const valueX = x + ICON_X + textWidth(segment.icon) + VALUE_GAP
  const fill = segment.percent === undefined ? 0 : (Math.min(100, Math.max(0, segment.percent)) / 100) * BAR
  const gauge =
    segment.percent === undefined
      ? ''
      : bar('track', valueX, BAR) + (fill > 0 ? bar(role, valueX, Math.max(BAR_MIN, fill)) : '')
  const percentX = segment.percent === undefined ? valueX : valueX + BAR + BAR_GAP
  return (
    '<g>' +
    (segment.hover ? `<title>${escapeXml(segment.hover)}</title>` : '') +
    `<circle class="${role}" cx="${px(x + DOT_RADIUS)}" cy="${CY}" r="${DOT_RADIUS}"/>` +
    text('muted', x + ICON_X, segment.icon) +
    gauge +
    text(valueClass(segment), percentX, segment.value, segment.bold) +
    '</g>'
  )
}

// One row as a single SVG: a rounded capsule holding a dot, the muted icon and the value per segment.
export const svgRow = (segments: readonly Segment[]) => {
  let x = INSET
  const parts = segments.map(segment => {
    const drawn = drawSegment(segment, x)
    x += ICON_X + textWidth(segment.icon) + VALUE_GAP + valueWidth(segment) + SEGMENT_GAP
    return drawn
  })
  const width = Math.ceil(x - SEGMENT_GAP + INSET)
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}"` +
    ` font-family="${FONT}" font-size="${FONT_SIZE}">${STYLE}` +
    `<rect class="cap" x="0" y="1" width="${width}" height="${CAPSULE}" rx="${CAPSULE / 2}"/>${parts.join('')}</svg>`
  return { source, width, height: HEIGHT }
}

// What the row says to a reader that cannot see it: plain text, bars left out.
export const rowAlt = (segments: readonly Segment[]) =>
  segments.map(({ icon, word, value }) => `${word ?? icon} ${value}`).join(' · ')
