// Catppuccin, raw hex, not theme keys: the band looks the same under every Claude theme.
// Latte draws on a light page, Macchiato on a dark one.
export const LATTE = {
  base: '#eff1f5',
  surface: '#dce0e8',
  text: '#4c4f69',
  overlay: '#8c8fa1',
  mauve: '#8839ef',
  blue: '#1e66f5',
  teal: '#179299',
  green: '#40a02b',
  yellow: '#df8e1d',
  red: '#d20f39',
} as const

export const MACCHIATO = {
  base: '#24273a',
  surface: '#363a4f',
  text: '#cad3f5',
  overlay: '#8087a2',
  mauve: '#c6a0f6',
  blue: '#8aadf4',
  teal: '#8bd5ca',
  green: '#a6da95',
  yellow: '#eed49f',
  red: '#ed8796',
} as const

export type Flavor = { readonly [K in keyof typeof LATTE]: string }

// What a segment means; the palette decides how it looks.
export type Role = 'workItem' | 'branch' | 'timer' | 'ok' | 'warning' | 'error' | 'muted'

export const ROLE_HUES: Record<Role, keyof Flavor> = {
  workItem: 'mauve',
  branch: 'blue',
  timer: 'teal',
  ok: 'green',
  warning: 'yellow',
  error: 'red',
  muted: 'overlay',
}

// The terminal's role colors: Macchiato, whatever the terminal's theme (it has no keys for these hues).
export const ROLE_COLORS = Object.fromEntries(
  Object.entries(ROLE_HUES).map(([role, hue]) => [role, MACCHIATO[hue]]),
) as Record<Role, string>

const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

// `amount` of `hex` over `base`, per channel: 0 is the base, 1 the color itself.
export const tint = (hex: string, base: string, amount: number) => {
  const color = channels(hex)
  const mixed = channels(base).map((from, i) => Math.round(from + ((color[i] ?? from) - from) * amount))
  return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}
