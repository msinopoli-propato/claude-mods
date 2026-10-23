// Catppuccin Macchiato. Raw hex, not theme keys: the band looks the same under every Claude theme.
export const MACCHIATO = {
  base: '#24273a',
  text: '#cad3f5',
  overlay0: '#6e738d',
  mauve: '#c6a0f6',
  blue: '#8aadf4',
  yellow: '#eed49f',
  red: '#ed8796',
  teal: '#8bd5ca',
  green: '#a6da95',
} as const

// What a segment means; the palette decides how it looks.
export type Role = 'workItem' | 'branch' | 'timer' | 'ok' | 'warning' | 'error'

export const ROLE_COLORS: Record<Role, string> = {
  workItem: MACCHIATO.mauve,
  branch: MACCHIATO.blue,
  timer: MACCHIATO.teal,
  ok: MACCHIATO.green,
  warning: MACCHIATO.yellow,
  error: MACCHIATO.red,
}

const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

// `amount` of `hex` over `base`, per channel: 0 is the base, 1 the color itself.
export const tint = (hex: string, base: string, amount = 0.16) => {
  const color = channels(hex)
  const mixed = channels(base).map((from, i) => Math.round(from + ((color[i] ?? from) - from) * amount))
  return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}
