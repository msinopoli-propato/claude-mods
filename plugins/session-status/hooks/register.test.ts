import { expect, mock, test } from 'claude-code/testing'

import { parseHealth, healthRoles } from './health'
import { LATTE, MACCHIATO, ROLE_COLORS, tint } from './palette'
import type { Role } from './palette'
import { contextBar } from './segments'
import type { Segment } from './segments'
import { escapeXml, rowAlt, svgRow } from './svg-band'
import { cardLeft, cellWidth } from './text-band'
import { azArgv, composeTitle, describeTitle, parseWorkItemTitle } from './title'
import { findWorkItem } from './register'

type World = {
  branch?: string
  porcelain?: string
  cwd?: string
  percent?: number
  tokens?: number
  // PowerShell health read: raw stdout, or undefined for a failing command.
  health?: string
  healthCalls?: number
  healthArgv?: { argv: readonly string[]; init?: { timeoutMs?: number } }
  healthGate?: Promise<void>
  // What $.agent.list() answers; `agentsFail` makes the call reject.
  agents?: { id: string; status: string }[]
  agentsFail?: boolean
  agentsGate?: Promise<void>
  agentListCalls?: number
  spawnId?: string
  // Azure CLI read: the work item title (undefined -> the command fails), calls seen and an optional gate.
  azTitle?: string
  azCalls?: number
  azArgv?: { argv: readonly string[]; init?: { timeoutMs?: number } }
  azGate?: Promise<void>
  store?: Record<string, unknown>
}

const MINUTE = 60_000
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const fail = { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }

// Bottom hooks standing for the engine: git, session facts, and the events the plugin chains onto.
const world = (on: any, w: World = {}) => {
  const registered: string[] = []
  const clock = mock.clock(on, { now: T0 })
  on('process.run', async (_$: unknown, e: { argv: readonly string[]; init?: { timeoutMs?: number } }) => {
    if (e.argv[0] === 'cmd') {
      w.azCalls = (w.azCalls ?? 0) + 1
      w.azArgv = e
      await w.azGate
      if (w.azTitle === undefined) return fail
      return ok(JSON.stringify({ 'System.Title': w.azTitle, 'System.State': 'Active' }))
    }
    if (e.argv[0] === 'powershell') {
      w.healthCalls = (w.healthCalls ?? 0) + 1
      w.healthArgv = e
      await w.healthGate
      return w.health === undefined ? fail : ok(w.health)
    }
    if (w.branch === undefined) return fail
    return e.argv.includes('rev-parse') ? ok(`${w.branch}\n`) : ok(w.porcelain ?? '')
  })
  on('session.cwd', () => ({ value: w.cwd ?? 'C:\\Repos\\app' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, percent: w.percent, tokens: w.tokens },
      rateLimits: [],
    },
  }))
  on('command.register', (_$: unknown, e: { name: string }) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's1' }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('agent.list', async () => {
    w.agentListCalls = (w.agentListCalls ?? 0) + 1
    if (w.agentsFail) return { deny: 'agent list unavailable' }
    const snapshot = w.agents ?? [] // what the engine knew when the call started
    await w.agentsGate
    return { value: snapshot.map(a => ({ description: 'task', type: 'general-purpose', ...a })) }
  })
  on('agent.spawn', () => ({ model: 'm', agentId: w.spawnId ?? 'spawned-1' }))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.SessionStart', () => ({}))
  mock.store(on, w.store ?? {})
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  // The engine's own AbovePrompt: an empty box, drawn when the plugin passes.
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  return { registered, clock }
}

const turn = (extra: Record<string, unknown> = {}) => ({
  answer: 'ok',
  durationMs: 1000,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
  ...extra,
})

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}

const SURFACES = ['terminal', 'desktop'] as const
type Surface = 'terminal' | 'desktop' | 'vscode' | 'mobile'

// One drawn segment, read the same way off either surface: `label` is icon and value (the bar left out),
// `isAlert` says the value takes the role color instead of the text color.
type Seg = { label: string; role: Role; bold?: unknown; isAlert: boolean; bar?: string; hover?: string; card?: Record<string, unknown> }

const textOf = (node: any): string =>
  typeof node === 'string' ? node : (node?.children ?? []).map(textOf).join('')

// One drawn Text: its props and its shown text.
type Part = { text: string; color?: unknown; backgroundColor?: unknown; dimColor?: unknown; bold?: unknown }
const partOf = (node: any): Part => ({ ...node.props, text: textOf(node) })

const ROLE_OF_COLOR = Object.fromEntries(Object.entries(ROLE_COLORS).map(([role, color]) => [color, role])) as Record<string, Role>
const ROLE_OF_CLASS: Record<string, Role> = { wi: 'workItem', branch: 'branch', timer: 'timer', ok: 'ok', warning: 'warning', error: 'error' }

// Terminal: a keyed Box per segment holding the dot, the dim icon, the bar of a percent gauge and the value,
// plus its hover card.
const terminalSeg = (node: any): Seg => {
  const [dot, icon, ...rest] = node.children.filter((c: any) => c.type === 'Text').map(partOf) as Part[]
  const value = rest.at(-1)!
  const bar = rest.length > 1 ? rest[0] : undefined
  const card = node.children.find((c: any) => c.type === 'Box')
  return {
    label: `${icon!.text.trim()} ${value.text}`,
    role: ROLE_OF_COLOR[dot!.color as string]!,
    bold: value.bold,
    isAlert: value.color === dot!.color,
    ...(bar ? { bar: bar.text.trim() } : {}),
    ...(card ? { hover: textOf(card).trim(), card: { ...card.props, hover: card.hover } } : {}),
  }
}

const unescapeXml = (text: string) =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

// Desktop: one <g> per segment in the row's SVG; the bar is read back as its fill width.
const svgSegs = (source: string): Seg[] =>
  [...source.matchAll(/<g>(.*?)<\/g>/g)].map(([, group = '']) => {
    const title = /<title>(.*?)<\/title>/.exec(group)?.[1]
    const dot = /<circle class="r-(\w+)"/.exec(group)![1]!
    const [icon, value] = [...group.matchAll(/<text class="([\w-]+)"([^>]*)>(.*?)<\/text>/g)]
    const fill = /<rect class="r-\w+"[^>]*width="([\d.]+)"/.exec(group)?.[1]
    const isBar = group.includes('class="track"')
    return {
      label: `${unescapeXml(icon![3]!)} ${unescapeXml(value![3]!)}`,
      role: ROLE_OF_CLASS[dot]!,
      bold: value![2]!.includes('font-weight="700"') || undefined,
      isAlert: value![1] === `r-${dot}`,
      ...(isBar ? { bar: fill ?? '0' } : {}),
      ...(title === undefined ? {} : { hover: unescapeXml(title) }),
    }
  })

// Untyped like the drawn tree it reads, so tests index rows freely.
const rowsOf = (tree: any): Seg[][] =>
  (tree.children ?? []).map((row: any) => (row.type === 'Svg' ? svgSegs(row.props.source) : row.children.map(terminalSeg)))

const mountBand = ($: any, surface: Surface = 'terminal', props: object = BAND_PROPS) =>
  $.ui.mount({ plugin: 'session-status', surface, component: 'AbovePrompt', props })

// The band's rows of segments; the engine's own empty Box (the plugin passed) is no rows.
const drawRows = async ($: any, surface: Surface = 'terminal', props: object = BAND_PROPS) =>
  rowsOf(await (await mountBand($, surface, props)).drawn())

const textOfRows = (rows: Seg[][]) => rows.map(row => row.map(s => s.label).join(' | ')).join('\n')
const named = (rows: Seg[][], prefix: string) => rows.flat().find(s => s.label.startsWith(prefix))!
const branchOf = (rows: Seg[][]) => rows.flat().find(s => s.label.startsWith('⎇'))
const bandText = async ($: any, surface: Surface = 'terminal') => textOfRows(await drawRows($, surface))

const compose = ($: any) =>
  $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })

// The kit's inputs carry every field the engine fills; the plugin reads only these.
const submit = ($: any, text: string) => $.prompt.submit({ text })
const spawn = ($: any, prompt: string) => $.agent.spawn({ prompt })

const wiTime = async ($: any) => (await $.command.run({ command: 'wi-time' })).text as string

test('finds the work item in branch and worktree names', () => {
  expect(findWorkItem('feature/issue-8423')).toBe('8423')
  expect(findWorkItem('fix/issue-77')).toBe('77')
  expect(findWorkItem('main', 'C:/Repos/worktrees/stock-api-issue-912')).toBe('912')
  expect(findWorkItem('desarrollo', 'C:/Repos/app')).toBe(undefined)
  expect(findWorkItem('feature/tissue-12')).toBe(undefined)
})

// ---------------------------------------------------------------- band

test('the context bar has 8 cells, one per 12.5%, clamped', () => {
  expect(contextBar(0)).toBe('▱▱▱▱▱▱▱▱')
  expect(contextBar(5)).toBe('▱▱▱▱▱▱▱▱')
  expect(contextBar(42)).toBe('▰▰▰▱▱▱▱▱')
  expect(contextBar(50)).toBe('▰▰▰▰▱▱▱▱')
  expect(contextBar(100)).toBe('▰▰▰▰▰▰▰▰')
  expect(contextBar(130)).toBe('▰▰▰▰▰▰▰▰')
  expect(contextBar(-5)).toBe('▱▱▱▱▱▱▱▱')
})

for (const surface of SURFACES) {
  test(`band draws work and gauge rows of status dots on ${surface}`, async ($, on) => {
    world(on, { branch: 'feature/issue-8423', porcelain: ' M a.cs\n', percent: 42, tokens: 84_200 })
    await $.turn.complete(turn())
    const rows = await drawRows($, surface)

    expect(textOfRows(rows)).toBe('◆ #8423 | ⎇ feature/issue-8423*\nctx 42%')
    const [[wi, branch], [ctx]] = rows as [[Seg, Seg], [Seg]]
    expect(wi).toMatchObject({ role: 'workItem', bold: true, isAlert: false })
    expect(branch).toMatchObject({ role: 'warning', isAlert: true })
    expect(ctx).toMatchObject({ role: 'ok', isAlert: false })
  })

  test(`every segment of a full band, in order, on ${surface}`, async ($, on) => {
    const { clock } = world(on, { branch: 'feature/issue-8423', percent: 42, health: SAMPLE, agents: [{ id: 'a', status: 'running' }] })
    await start($, clock)
    await submit($, '/prosuite-comandos:work-item 8423')
    const segs = (await drawRows($, surface)).flat()
    expect(segs.map(s => s.label.split(' ')[0])).toEqual(['◆', '⎇', '⏱', '🤖', 'ctx', 'cpu', 'ram', 'temp'])
    // Percent gauges carry a bar; temperature is text.
    expect(segs.map(s => s.bar !== undefined)).toEqual([false, false, false, false, true, true, true, false])
  })

  test(`band shows the timer segment on ${surface}`, async ($, on) => {
    const { clock } = world(on, { branch: 'feature/issue-8423', percent: 10 })
    await submit($, '/prosuite-comandos:work-item 8423')
    for (let i = 0; i < 9; i++) {
      await clock.advance(9 * MINUTE) // 81 minutes of steady activity: 1.35h
      await $.turn.complete(turn())
    }
    const rows = await drawRows($, surface)
    expect(textOfRows(rows)).toBe('◆ #8423 | ⎇ feature/issue-8423 | ⏱ 1.3h\nctx 10%')
    expect(named(rows, '⏱')).toMatchObject({ label: '⏱ 1.3h', role: 'timer', isAlert: false })
  })

  test(`only warning and error values take the role color on ${surface}`, async ($, on) => {
    const { clock } = world(on, { branch: 'main', percent: 70, health: '95|1000|4000|3352' })
    await start($, clock)
    const segs = (await drawRows($, surface)).flat()
    expect(segs.map(s => [s.label.split(' ')[0], s.role, s.isAlert])).toEqual([
      ['⎇', 'error', true],
      ['ctx', 'warning', true],
      ['cpu', 'error', true],
      ['ram', 'warning', true],
      ['temp', 'ok', false],
    ])
  })
}

// ---------------------------------------------------------------- terminal drawing

test('a terminal segment is a role dot, the dim icon and the value, with no background', async ($, on) => {
  world(on, { branch: 'feature/issue-8423', porcelain: ' M a.cs\n' })
  await $.turn.complete(turn())
  const tree: any = await (await mountBand($)).drawn()
  const [wi, branch] = tree.children[0].children
  expect(wi.children.map(partOf)).toEqual([
    { text: '●', color: ROLE_COLORS.workItem },
    { text: ' ◆ ', dimColor: true },
    { text: '#8423', bold: true },
  ])
  expect(branch.children.map(partOf)).toEqual([
    { text: '●', color: ROLE_COLORS.warning },
    { text: ' ⎇ ', dimColor: true },
    { text: 'feature/issue-8423*', color: ROLE_COLORS.warning },
  ])
  // Segments sit two cells apart in their row.
  expect(tree.children[0].props).toMatchObject({ gap: 2 })
})

test('a terminal percent gauge draws the text bar in the role color before the percent', async ($, on) => {
  world(on, { branch: 'x', percent: 42 })
  await $.turn.complete(turn())
  const tree: any = await (await mountBand($)).drawn()
  expect(tree.children[1].children[0].children.map(partOf)).toEqual([
    { text: '●', color: ROLE_COLORS.ok },
    { text: ' ctx ', dimColor: true },
    { text: '▰▰▰▱▱▱▱▱ ', color: ROLE_COLORS.ok },
    { text: '42%' },
  ])
})

test('no terminal band text has a background color; only hover cards do', async ($, on) => {
  const { clock } = world(on, { branch: 'main', percent: 90, health: SAMPLE, agents: [{ id: 'a', status: 'running' }] })
  await start($, clock)
  const ui = await mountBand($)
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.length).toBeGreaterThan(0)
  for (const text of texts) expect(text.props.backgroundColor).toBe(undefined)
})

test('the terminal draws no Svg', async ($, on) => {
  world(on, { branch: 'x', percent: 42 })
  await $.turn.complete(turn())
  expect(await (await mountBand($)).findAll({ type: 'Svg' })).toHaveLength(0)
})

// ---------------------------------------------------------------- desktop drawing

for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
  test(`each row is one interactive Svg in a column on ${surface}`, async ($, on) => {
    const { clock } = world(on, { branch: 'feature/issue-8423', porcelain: ' M a.cs\n', percent: 42, health: SAMPLE })
    await start($, clock)
    await submit($, '/prosuite-comandos:work-item 8423')
    const tree: any = await (await mountBand($, surface)).drawn()
    expect(tree).toMatchObject({ type: 'Box', props: { flexDirection: 'column' } })
    expect(tree.children.map((row: any) => row.type)).toEqual(['Svg', 'Svg'])
    const [work, gauges] = tree.children.map((row: any) => row.props)
    expect(work.alt).toBe('WI #8423 · ⎇ feature/issue-8423* · ⏱ 0.0h')
    expect(gauges.alt).toBe('ctx 42% · cpu 27% · ram 75% · temp 62°C')
    for (const row of [work, gauges]) {
      expect(row.isInteractive).toBe(true)
      expect(row.height).toBe(24)
      expect(row.source.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${row.width}" height="24" viewBox="0 0 ${row.width} 24"`)).toBe(true)
    }
  })
}

test('the desktop draws no Text', async ($, on) => {
  world(on, { branch: 'x', percent: 42, tokens: 1000 })
  await $.turn.complete(turn())
  expect(await (await mountBand($, 'desktop')).findAll({ type: 'Text' })).toHaveLength(0)
})

test('a desktop gauge bar fills its share of 40px, at least 6, none at 0%', async ($, on) => {
  const w: World = { branch: 'x' }
  world(on, w)
  for (const [percent, fill] of [[42, '16.8'], [5, '6'], [100, '40'], [130, '40'], [0, '0']] as const) {
    w.percent = percent
    await $.turn.complete(turn())
    expect([percent, named(await drawRows($, 'desktop'), 'ctx').bar]).toEqual([percent, fill])
  }
})

// ---------------------------------------------------------------- svg rows

const seg = (icon: string, value: string, role: Role, extra: Partial<Segment> = {}): Segment => ({ icon, value, role, ...extra })

test('an svg row is a capsule with a dot, the muted icon and the value per segment', () => {
  const { source, width, height } = svgRow([seg('⎇', 'main', 'error', { bold: true })])
  // 10 inset + (12 + 1 cell + 5 + 4 cells + 16 gap) - 16 + 10 inset, at 7.2px a cell
  expect([width, height]).toEqual([73, 24])
  expect(source).toContain(`font-family="Consolas, 'Cascadia Mono', ui-monospace, monospace" font-size="12"`)
  expect(source).toContain('<rect class="cap" x="0" y="1" width="73" height="22" rx="11"/>')
  expect(source).toContain(
    '<g><circle class="r-error" cx="13.5" cy="12" r="3.5"/>' +
      '<text class="muted" x="22" y="12" dominant-baseline="central">⎇</text>' +
      '<text class="r-error" x="34.2" y="12" font-weight="700" dominant-baseline="central">main</text></g>',
  )
  expect(source.endsWith('</svg>')).toBe(true)
})

test('a plain value is drawn in the text class', () => {
  const { source } = svgRow([seg('⏱', '1.3h', 'timer')])
  expect(source).toContain('<circle class="r-timer"')
  expect(source).toContain('<text class="text" x="34.2" y="12" dominant-baseline="central">1.3h</text>')
})

test('a percent gauge draws a rounded track and fill before the percent', () => {
  const { source, width } = svgRow([seg('ctx', '42%', 'ok', { percent: 42 })])
  expect(width).toBe(127) // 10 + (12 + 3 cells + 5 + 40 + 6 + 3 cells) + 10
  expect(source).toContain(
    '<rect class="track" x="48.6" y="9" width="40" height="6" rx="3"/>' +
      '<rect class="r-ok" x="48.6" y="9" width="16.8" height="6" rx="3"/>' +
      '<text class="text" x="94.6" y="12" dominant-baseline="central">42%</text>',
  )
})

test('svg widths count an emoji as two cells and add up segments with a 16px gap', () => {
  expect(svgRow([seg('🤖', '1 ▸ 0 ✓', 'warning')]).width).toBe(102) // 10 + 12 + 14.4 + 5 + 50.4 + 10 = 101.8
  expect(svgRow([seg('⎇', 'main', 'branch'), seg('⏱', '1.3h', 'timer')]).width).toBe(142)
})

test('the svg style is Latte by default and Macchiato when dark', () => {
  const { source } = svgRow([seg('⎇', 'main', 'branch')])
  const style = /<style>(.*)<\/style>/.exec(source)![1]!
  const [light, dark] = style.split('@media (prefers-color-scheme: dark)') as [string, string]
  for (const [css, flavor] of [[light, LATTE], [dark, MACCHIATO]] as const) {
    expect(css).toContain(`.cap{fill:${flavor.surface}}`)
    expect(css).toContain(`.muted{fill:${flavor.overlay}}`)
    expect(css).toContain(`.text{fill:${flavor.text}}`)
    expect(css).toContain(`.r-wi{fill:${flavor.mauve}}`)
    expect(css).toContain(`.r-branch{fill:${flavor.blue}}`)
    expect(css).toContain(`.r-timer{fill:${flavor.teal}}`)
    expect(css).toContain(`.r-ok{fill:${flavor.green}}`)
    expect(css).toContain(`.r-warning{fill:${flavor.yellow}}`)
    expect(css).toContain(`.r-error{fill:${flavor.red}}`)
    expect(css).toContain('.track{fill:')
  }
})

test('the palettes are Catppuccin Latte and Macchiato', () => {
  expect(LATTE).toEqual({
    base: '#eff1f5', surface: '#dce0e8', text: '#4c4f69', overlay: '#8c8fa1',
    mauve: '#8839ef', blue: '#1e66f5', teal: '#179299', green: '#40a02b', yellow: '#df8e1d', red: '#d20f39',
  })
  expect(MACCHIATO).toEqual({
    base: '#24273a', surface: '#363a4f', text: '#cad3f5', overlay: '#8087a2',
    mauve: '#c6a0f6', blue: '#8aadf4', teal: '#8bd5ca', green: '#a6da95', yellow: '#eed49f', red: '#ed8796',
  })
})

test('tint mixes a color into the base per channel', () => {
  expect(tint(MACCHIATO.red, MACCHIATO.base, 0.16)).toBe('#443649')
  expect(tint(MACCHIATO.red, MACCHIATO.base, 0)).toBe(MACCHIATO.base)
  expect(tint(MACCHIATO.red, MACCHIATO.base, 1)).toBe(MACCHIATO.red)
  expect(tint('#FFFFFF', '#000000', 0.5)).toBe('#808080')
})

test('every text that reaches the svg is XML-escaped', () => {
  expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f')
  const { source } = svgRow([seg('◆', '#1', 'workItem', { hover: '</title><script>x</script>' }), seg('⎇', `a&"b'<i>`, 'branch')])
  expect(source).not.toContain('<script')
  expect(source).toContain('<title>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title>')
  expect(source).toContain('>a&amp;&quot;b&apos;&lt;i&gt;</text>')
})

test('a segment carries a title only when it has a hover text', () => {
  expect(svgRow([seg('⎇', 'main', 'branch')]).source).not.toContain('<title>')
  expect(svgRow([seg('ctx', '42%', 'ok', { percent: 42, hover: '84k tokens' })]).source).toContain('<g><title>84k tokens</title><circle')
})

test('a row alt is its plain text, the work item spelled WI', () => {
  expect(rowAlt([seg('◆', '#8423', 'workItem', { word: 'WI' }), seg('⎇', 'main', 'error'), seg('ctx', '42%', 'ok', { percent: 42 })]))
    .toBe('WI #8423 · ⎇ main · ctx 42%')
})

// ---------------------------------------------------------------- widths

test('cell width counts astral characters as two cells', () => {
  expect(cellWidth('ctx')).toBe(3)
  expect(cellWidth('🤖')).toBe(2)
  expect(cellWidth(' 🤖 ')).toBe(4)
  expect(cellWidth('▰▱ 42%')).toBe(6)
})

test('a terminal hover card opens past the drawn segment and the row gap', () => {
  // '●' + ' 🤖 ' + '1 ▸ 0 ✓' + gap
  expect(cardLeft(seg('🤖', '1 ▸ 0 ✓', 'ok'))).toBe(1 + 4 + 7 + 2)
  // '●' + ' ctx ' + '▰▰▰▱▱▱▱▱ ' + '42%' + gap
  expect(cardLeft(seg('ctx', '42%', 'ok', { percent: 42 }))).toBe(1 + 5 + 9 + 3 + 2)
})

test('an active run wins over the branch work item and WI is shown once', async ($, on) => {
  world(on, { branch: 'feature/issue-1111', percent: 10 })
  await submit($, '/prosuite-comandos:work-item 8423')
  await $.turn.complete(turn())
  expect(textOfRows(await drawRows($))).toBe('◆ #8423 | ⎇ feature/issue-1111 | ⏱ 0.0h\nctx 10%')
})

test('a run with unknown work item and no branch work item shows WI ?', async ($, on) => {
  world(on, { branch: 'desarrollo' })
  await submit($, '/prosuite-comandos:test-en-vivo')
  await $.turn.complete(turn())
  const rows = await drawRows($)
  expect(textOfRows(rows)).toBe('◆ ? | ⎇ desarrollo | ⏱ 0.0h')
  expect(rows[0]![0]).toMatchObject({ role: 'workItem', bold: true })
})

test('a run with unknown work item falls back to the branch work item', async ($, on) => {
  const w: World = { branch: 'desarrollo' }
  world(on, w)
  await submit($, '/prosuite-comandos:test-en-vivo') // unknown at start
  w.branch = 'feature/issue-77'
  await $.turn.complete(turn())
  expect(textOfRows(await drawRows($))).toBe('◆ #77 | ⎇ feature/issue-77 | ⏱ 0.0h')
})

test('clean branch is blue, protected branches are bold red even when clean', async ($, on) => {
  const w: World = { branch: 'feature/issue-5' }
  world(on, w)
  await $.turn.complete(turn())
  expect(branchOf(await drawRows($))).toMatchObject({ label: '⎇ feature/issue-5', role: 'branch' })

  for (const name of ['main', 'master', 'dev', 'desarrollo', 'UAT']) {
    w.branch = name
    await $.turn.complete(turn())
    expect(branchOf(await drawRows($))).toMatchObject({ label: `⎇ ${name}`, role: 'error', bold: true })
  }
})

test('dirty protected branch stays red and shows the asterisk', async ($, on) => {
  world(on, { branch: 'main', porcelain: ' M a.cs\n' })
  await $.turn.complete(turn())
  expect(branchOf(await drawRows($, 'desktop'))).toMatchObject({ label: '⎇ main*', role: 'error', bold: true })
})

test('context role follows the thresholds', async ($, on) => {
  const cases: [number, Role][] = [[0, 'ok'], [59, 'ok'], [60, 'warning'], [84, 'warning'], [85, 'error'], [100, 'error']]
  const w: World = { branch: 'feature/x' }
  world(on, w)
  for (const [percent, role] of cases) {
    w.percent = percent
    await $.turn.complete(turn())
    const ctx = named(await drawRows($), 'ctx')
    expect([percent, ctx.role]).toEqual([percent, role])
  }
})

test('reads the work item from a Windows worktree path', async ($, on) => {
  world(on, { branch: 'desarrollo', cwd: 'C:\\Repos\\worktrees\\stock-api-issue-912' })
  await $.turn.complete(turn())
  expect(textOfRows(await drawRows($))).toBe('◆ #912 | ⎇ desarrollo')
})

test('outside a git repo the empty work row is omitted and only the gauges show', async ($, on) => {
  world(on, { percent: 5 })
  await $.turn.complete(turn())
  const rows = await drawRows($, 'desktop')
  expect(rows).toHaveLength(1)
  expect(textOfRows(rows)).toBe('ctx 5%')
})

test('ignores subagent turns', async ($, on) => {
  world(on, { branch: 'feature/issue-1' })
  await $.turn.complete(turn({ agentId: 'sub-1' }))
  // Branch, work item and usage were not refreshed, and an id no list or spawn named never enters the tally.
  expect(await bandText($)).toBe('')
})

test('yields the band to a survey', async ($, on) => {
  world(on, { branch: 'feature/x' })
  await $.turn.complete(turn())
  for (const surface of SURFACES) {
    const ui = await mountBand($, surface, { ...BAND_PROPS, hasSurvey: true })
    expect(await ui.findAll({ type: 'Text' })).toHaveLength(0)
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  }
})

// ---------------------------------------------------------------- hover cards and titles

const REVEAL = { position: 'absolute', top: 0, display: 'none', hover: { display: 'flex' } }

test('a cached work item title is a hover card beside the WI segment on the terminal', async ($, on) => {
  world(on, { branch: 'feature/issue-8423', store: { 'wi-title:8423': 'Licenses endpoint' } })
  await $.turn.complete(turn())
  const wi = named(await drawRows($), '◆')
  expect(wi).toMatchObject({ label: '◆ #8423', role: 'workItem', hover: 'Licenses endpoint' })
  // Opens right after the segment and its gap, over the rest of the row: '●', ' ◆ ', '#8423', gap.
  expect(wi.card).toMatchObject({ ...REVEAL, left: 1 + 3 + 5 + 2 })
})

test('the token count is a hover card on the ctx segment on the terminal', async ($, on) => {
  world(on, { branch: 'x', percent: 42, tokens: 84_200 })
  await $.turn.complete(turn())
  const ctx = named(await drawRows($), 'ctx')
  expect(ctx).toMatchObject({ label: 'ctx 42%', bar: '▰▰▰▱▱▱▱▱', hover: '84k tokens' })
  expect(ctx.card).toMatchObject({ ...REVEAL, left: 1 + 5 + 9 + 3 + 2 })
})

test('on the desktop the title and the token count are svg titles', async ($, on) => {
  world(on, { branch: 'feature/issue-8423', percent: 42, tokens: 84_200, store: { 'wi-title:8423': 'Licenses <endpoint>' } })
  await $.turn.complete(turn())
  const rows = await drawRows($, 'desktop')
  expect(named(rows, '◆').hover).toBe('Licenses <endpoint>')
  expect(named(rows, 'ctx').hover).toBe('84k tokens')
  expect(named(rows, '⎇').hover).toBe(undefined)
})

test('the card text is base on the solid role color, padded', async ($, on) => {
  world(on, { branch: 'feature/issue-8423', store: { 'wi-title:8423': 'Licenses endpoint' } })
  await $.turn.complete(turn())
  const ui = await mountBand($)
  const card = await ui.find({ type: 'Text', text: 'Licenses endpoint' })
  expect(card).toMatchObject({ text: ' Licenses endpoint ', props: { color: MACCHIATO.base, backgroundColor: ROLE_COLORS.workItem } })
})

for (const surface of SURFACES) {
  test(`long titles are cut to 60 characters on ${surface}`, async ($, on) => {
    const title = 'Connector.Visma - BE Endpoint de listado de licencias con filtros por fecha y estado'
    world(on, { branch: 'feature/issue-8423', store: { 'wi-title:8423': title } })
    await $.turn.complete(turn())
    expect(named(await drawRows($, surface), '◆').hover).toBe(`${title.slice(0, 59)}…`)
  })

  test(`no cached title, no card or title, and drawing never runs az on ${surface}`, async ($, on) => {
    const w: World = { branch: 'feature/issue-8423', azTitle: 'Licenses endpoint' }
    const { clock } = world(on, w)
    await $.turn.complete(turn())
    expect(named(await drawRows($, surface), '◆').hover).toBe(undefined)
    await clock.settle()
    expect(w.azCalls).toBe(undefined)
  })

  test(`unknown tokens leave the ctx segment without a card or title on ${surface}`, async ($, on) => {
    world(on, { branch: 'x', percent: 42 })
    await $.turn.complete(turn())
    expect(named(await drawRows($, surface), 'ctx').hover).toBe(undefined)
  })
}

test('describeTitle takes a longer limit for the card', () => {
  expect(describeTitle('a'.repeat(60), 60)).toBe('a'.repeat(60))
  expect(describeTitle('a'.repeat(61), 60)).toBe(`${'a'.repeat(59)}…`)
})

test('the card follows the run work item', async ($, on) => {
  world(on, { branch: 'feature/issue-1111', store: { 'wi-title:1111': 'Branch item', 'wi-title:9001': 'Run item' } })
  await submit($, '/prosuite-comandos:work-item 9001')
  expect(named(await drawRows($), '◆').hover).toBe('Run item')
})


// ---------------------------------------------------------------- timer

test('excludes gaps longer than ten minutes entirely', async ($, on) => {
  const { clock } = world(on, { branch: 'main' })
  await submit($, '/prosuite-comandos:work-item 8423') // t = 0
  await clock.advance(5 * MINUTE)
  await $.tool.call({ tool: 'Bash', command: 'ls' }) // t = 5
  await clock.advance(15 * MINUTE)
  await $.turn.complete(turn()) // t = 20: a 15 minute gap, ignored
  expect(await wiTime($)).toContain('active 0h 5m')
})

test('a gap of exactly ten minutes still counts', async ($, on) => {
  const { clock } = world(on, { branch: 'main' })
  await submit($, '/prosuite-comandos:work-item 8423')
  await clock.advance(10 * MINUTE)
  await $.turn.complete(turn())
  expect(await wiTime($)).toContain('active 0h 10m')
})

test('prompts, tool calls and main turns are all activity; subagent turns are not', async ($, on) => {
  const { clock } = world(on, { branch: 'main' })
  await submit($, '/prosuite-comandos:work-item 8423')
  await clock.advance(2 * MINUTE)
  await submit($, 'continue')
  await clock.advance(3 * MINUTE)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(4 * MINUTE)
  await $.turn.complete(turn({ agentId: 'sub-1' })) // not activity
  await clock.advance(1 * MINUTE)
  await $.turn.complete(turn())
  expect(await wiTime($)).toContain('active 0h 10m')
})

test('a new prosuite-comandos command resets the run', async ($, on) => {
  const { clock } = world(on, { branch: 'main' })
  await submit($, '/prosuite-comandos:work-item 8423')
  await clock.advance(8 * MINUTE)
  await $.turn.complete(turn())
  expect(await wiTime($)).toContain('WI #8423 · active 0h 8m')

  await clock.advance(2 * MINUTE)
  await submit($, '/prosuite-comandos:code-review-jueces 9001')
  expect(await wiTime($)).toContain('WI #9001 · active 0h 0m')
})

test('other slash commands do not start a run', async ($, on) => {
  world(on, { branch: 'main' })
  await submit($, '/compact')
  await submit($, 'hello')
  expect(await wiTime($)).toBe('No prosuite-comandos run is active.')
})

test('work item comes from the first standalone number of 2+ digits in the args', async ($, on) => {
  world(on, { branch: 'feature/issue-1111' })
  await submit($, '/prosuite-comandos:work-item-tdd 7 fix v2 8423 9999')
  expect(await wiTime($)).toContain('WI #8423')
  await submit($, '/prosuite-comandos:work-item #4567')
  expect(await wiTime($)).toContain('WI #4567')
})

test('falls back to the branch, then the worktree path, when the args name no work item', async ($, on) => {
  const w: World = { branch: 'feature/issue-1111' }
  world(on, w)
  await submit($, '/prosuite-comandos:refine-item-perf')
  expect(await wiTime($)).toContain('WI #1111')

  w.branch = 'desarrollo'
  w.cwd = 'C:\\Repos\\worktrees\\api-issue-912'
  await submit($, '/prosuite-comandos:refine-item-perf 5 words')
  expect(await wiTime($)).toContain('WI #912')
})

test('unknown work item shows a question mark in the band', async ($, on) => {
  world(on, { branch: 'desarrollo' })
  await submit($, '/prosuite-comandos:test-en-vivo')
  await $.turn.complete(turn())
  expect(await wiTime($)).toContain('WI ?')
  expect(named(await drawRows($), '⏱')).toMatchObject({ label: '⏱ 0.0h', role: 'timer' })
})

test('hours are rounded down, never up', async ($, on) => {
  const { clock } = world(on, { branch: 'main' })
  await submit($, '/prosuite-comandos:work-item 8423')
  for (let i = 0; i < 11; i++) {
    await clock.advance(9 * MINUTE) // 99 minutes in total: 1.65h
    await $.turn.complete(turn())
  }
  expect(named(await drawRows($), '⏱').label).toBe('⏱ 1.6h')
})

test('the session ending closes the run', async ($, on) => {
  world(on, { branch: 'main' })
  await submit($, '/prosuite-comandos:work-item 8423')
  await $.session.end({ reason: 'other', sessionId: 's1', resume: {} as never })
  expect(await wiTime($)).toBe('No prosuite-comandos run is active.')
})

test('no run, no timer segment', async ($, on) => {
  world(on, { branch: 'feature/issue-8423' })
  await $.turn.complete(turn())
  expect(named(await drawRows($), '⏱')).toBe(undefined)
})

// ------------------------------------------------------- prompt injection

test('injects the measured time into the system prompt only while a run is active', async ($, on) => {
  const { clock } = world(on, { branch: 'main' })

  const before = await compose($)
  expect(before.sections.map((s: { id: string }) => s.id)).toEqual(['intro'])

  await submit($, '/prosuite-comandos:work-item 8423')
  await clock.advance(5 * MINUTE)
  await $.turn.complete(turn())

  const after = await compose($)
  const section = after.sections.at(-1)!
  expect(after.sections[0].id).toBe('intro')
  expect(section).toMatchObject({ id: 'session-status:wi-time', scope: 'session' })
  expect(section.text).toBe(
    'Measured active time for WI 8423 in the current prosuite-comandos run: 0.0h (gaps over 10 minutes excluded). Use this measured value for CompletedWork instead of estimating.',
  )
})

test('the injected hours track the measured time', async ($, on) => {
  const { clock } = world(on, { branch: 'main' })
  await submit($, '/prosuite-comandos:work-item 8423')
  for (let i = 0; i < 9; i++) {
    await clock.advance(9 * MINUTE)
    await $.turn.complete(turn())
  }
  const { sections } = await compose($)
  expect(sections.at(-1)!.text).toContain('WI 8423 in the current prosuite-comandos run: 1.3h')
})

test('the injection says the work item is unknown when none was found', async ($, on) => {
  world(on, { branch: 'main' })
  await submit($, '/prosuite-comandos:test-en-vivo')
  const { sections } = await compose($)
  expect(sections.at(-1)!.text).toContain('(work item unknown)')
})

// -------------------------------------------------------------- /wi-time

test('registers /wi-time at session start', async ($, on) => {
  const { registered } = world(on)
  await $.session.start({ cwd: 'C:\\Repos\\app', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['wi-time'])
})

test('/wi-time prints work item, active time and run start', async ($, on) => {
  const { clock } = world(on, { branch: 'main' })
  await submit($, '/prosuite-comandos:work-item 8423')
  for (let i = 0; i < 9; i++) {
    await clock.advance(9 * MINUTE)
    await $.turn.complete(turn())
  }
  expect(await wiTime($)).toMatch(/^WI #8423 · active 1h 21m \(1\.3h\) · run started \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

// ---------------------------------------------------------------- PC health

const SAMPLE = '27|8195448|33177908|3352'

const start = async ($: any, clock: { settle: () => Promise<void> }) => {
  await $.session.start({ cwd: 'C:\\Repos\\app', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

test('parses the PowerShell output into CPU, RAM and temperature', () => {
  expect(parseHealth(SAMPLE)).toEqual({ cpu: 27, ram: 75, tempC: 62 })
  expect(parseHealth(`${SAMPLE}\r\n`)).toEqual({ cpu: 27, ram: 75, tempC: 62 })
  expect(parseHealth('27.4|1000|4000|')).toEqual({ cpu: 27, ram: 75, tempC: null })
  expect(parseHealth('27|1000|4000')).toEqual({ cpu: 27, ram: 75, tempC: null })
  expect(parseHealth('27|1000|4000|0')).toEqual({ cpu: 27, ram: 75, tempC: null })
})

test('unparsable output yields no health', () => {
  for (const raw of ['', 'garbage', '|||', 'a|b|c|d', '27|1000|0|3000', '|1000|4000|3000', '27|x|4000|3000', 'Get-CimInstance : denied']) {
    expect(parseHealth(raw)).toBe(null)
  }
})

test('roles follow the thresholds of each metric', () => {
  const colors = (cpu: number, ram: number, tempC: number | null) => healthRoles({ cpu, ram, tempC })
  expect(colors(69, 74, 69)).toEqual({ cpu: 'ok', ram: 'ok', temp: 'ok' })
  expect(colors(70, 75, 70)).toEqual({ cpu: 'warning', ram: 'warning', temp: 'warning' })
  expect(colors(89, 89, 84)).toEqual({ cpu: 'warning', ram: 'warning', temp: 'warning' })
  expect(colors(90, 90, 85)).toEqual({ cpu: 'error', ram: 'error', temp: 'error' })
})

for (const surface of SURFACES) {
  test(`band draws CPU, RAM and temperature after ctx in the gauge row on ${surface}`, async ($, on) => {
    const { clock } = world(on, { branch: 'feature/issue-8423', percent: 42, tokens: 84_200, health: SAMPLE })
    await start($, clock)
    await submit($, '/prosuite-comandos:work-item 8423')
    const rows = await drawRows($, surface)

    expect(textOfRows(rows)).toBe(
      '◆ #8423 | ⎇ feature/issue-8423 | ⏱ 0.0h\nctx 42% | cpu 27% | ram 75% | temp 62°C',
    )
    const [cpu, ram, temp] = (['cpu', 'ram', 'temp'] as const).map(prefix => named(rows, prefix)) as [Seg, Seg, Seg]
    expect([cpu.role, ram.role, temp.role]).toEqual(['ok', 'warning', 'ok'])
  })
}

test('colors reach the band per metric', async ($, on) => {
  const { clock } = world(on, { branch: 'x', health: '95|1000|4000|3700' })
  await start($, clock)
  const rows = await drawRows($)
  const [cpu, ram, temp] = (['cpu', 'ram', 'temp'] as const).map(prefix => named(rows, prefix)) as [Seg, Seg, Seg]
  expect([cpu, ram, temp].map(s => [s.label, s.role])).toEqual([
    ['cpu 95%', 'error'],
    ['ram 75%', 'warning'],
    ['temp 97°C', 'error'],
  ])
})

test('missing temperature leaves CPU and RAM only', async ($, on) => {
  const { clock } = world(on, { branch: 'x', health: '27|8195448|33177908|' })
  await start($, clock)
  expect(await bandText($)).toBe('⎇ x\ncpu 27% | ram 75%')
})

test('a failing or unparsable read omits the health segments', async ($, on) => {
  const failing = world(on, { branch: 'x' })
  await start($, failing.clock)
  expect(await bandText($)).toBe('⎇ x')
})

test('unparsable stdout omits them too', async ($, on) => {
  const { clock } = world(on, { branch: 'x', health: 'garbage' })
  await start($, clock)
  expect(await bandText($, 'desktop')).toBe('⎇ x')
})

test('reads on an interval of 20 seconds and redraws the new value', async ($, on) => {
  const w: World = { branch: 'x', health: '27|1000|4000|3352' }
  const { clock } = world(on, w)
  await start($, clock)
  const ui = await mountBand($)
  const cpu = async () => named(rowsOf(await ui.drawn()), 'cpu').label
  expect(await cpu()).toBe('cpu 27%')

  w.health = '50|1000|4000|3352'
  await clock.advance(19_000)
  expect(await cpu()).toBe('cpu 27%')
  await clock.advance(1_000)
  expect(await cpu()).toBe('cpu 50%')
  expect(w.healthCalls).toBe(2)
})

test('the read is a PowerShell argv with a 10 second timeout', async ($, on) => {
  const w: World = { branch: 'x', health: SAMPLE }
  const { clock } = world(on, w)
  await start($, clock)
  expect(w.healthArgv?.argv.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command'])
  expect(w.healthArgv?.argv).toHaveLength(5)
  expect(w.healthArgv?.init?.timeoutMs).toBe(10_000)
})

test('never starts a read while another is in flight', async ($, on) => {
  let release!: () => void
  const w: World = { branch: 'x', health: SAMPLE, healthGate: new Promise<void>(resolve => (release = resolve)) }
  const { clock } = world(on, w)
  await start($, clock)
  expect(w.healthCalls).toBe(1)

  await clock.advance(20_000)
  await clock.advance(20_000)
  expect(w.healthCalls).toBe(1)

  release()
  await clock.settle()
  await clock.advance(20_000)
  expect(w.healthCalls).toBe(2)
})

test('the interval stops when the session ends', async ($, on) => {
  const w: World = { branch: 'x', health: SAMPLE }
  const { clock } = world(on, w)
  await start($, clock)
  await $.session.end({ reason: 'other', sessionId: 's1', resume: {} as never })
  await clock.advance(60_000)
  expect(w.healthCalls).toBe(1)
})

// ---------------------------------------------------------------- subagents

for (const surface of SURFACES) {
  test(`one agents segment closes the work row, after the timer, on ${surface}`, async ($, on) => {
    const w: World = {
      branch: 'feature/issue-8423',
      percent: 10,
      agents: [
        { id: 'a', status: 'running' },
        { id: 'b', status: 'waiting' },
        { id: 'c', status: 'completed' },
        { id: 'd', status: 'completed' },
        { id: 'e', status: 'completed' },
      ],
    }
    world(on, w)
    await submit($, '/prosuite-comandos:work-item 8423')
    await $.turn.complete(turn())
    const rows = await drawRows($, surface)
    expect(textOfRows(rows)).toBe('◆ #8423 | ⎇ feature/issue-8423 | ⏱ 0.0h | 🤖 2 ▸ 3 ✓\nctx 10%')
    expect(named(rows, '🤖')).toMatchObject({ role: 'warning', bold: true })
  })
}

test('without a timer the agents segment follows the branch', async ($, on) => {
  world(on, { branch: 'feature/issue-8423', agents: [{ id: 'a', status: 'running' }] })
  await $.turn.complete(turn())
  expect(await bandText($)).toBe('◆ #8423 | ⎇ feature/issue-8423 | 🤖 1 ▸ 0 ✓')
})

test('nothing running is green, and failed shows only when above zero', async ($, on) => {
  world(on, { branch: 'x', agents: [{ id: 'a', status: 'completed' }] })
  await $.turn.complete(turn())
  const rows = await drawRows($)
  expect(textOfRows(rows)).toBe('⎇ x | 🤖 0 ▸ 1 ✓')
  const agents = named(rows, '🤖')
  expect(agents.role).toBe('ok')
  expect(agents.bold).toBe(undefined)
})

test('failed and killed agents land in the failed count, red when nothing runs', async ($, on) => {
  world(on, { branch: 'x', agents: [{ id: 'a', status: 'failed' }, { id: 'b', status: 'killed' }, { id: 'c', status: 'completed' }] })
  await $.turn.complete(turn())
  const rows = await drawRows($)
  expect(textOfRows(rows)).toBe('⎇ x | 🤖 0 ▸ 1 ✓ 2 ✗')
  expect(named(rows, '🤖').role).toBe('error')
})

test('running wins the color over failed', async ($, on) => {
  world(on, { branch: 'x', agents: [{ id: 'a', status: 'failed' }, { id: 'b', status: 'running' }] })
  await $.turn.complete(turn())
  const rows = await drawRows($)
  expect(textOfRows(rows)).toBe('⎇ x | 🤖 1 ▸ 0 ✓ 1 ✗')
  expect(named(rows, '🤖')).toMatchObject({ role: 'warning', bold: true })
})

test('idle teammates are neither running nor done', async ($, on) => {
  const w: World = { branch: 'x', agents: [{ id: 'a', status: 'idle' }] }
  world(on, w)
  await $.turn.complete(turn())
  expect(await bandText($)).toBe('⎇ x')

  w.agents = [{ id: 'a', status: 'idle' }, { id: 'b', status: 'running' }]
  await $.turn.complete(turn())
  expect(await bandText($)).toBe('⎇ x | 🤖 1 ▸ 0 ✓')
})

test('the tally survives the engine dropping finished agents', async ($, on) => {
  const w: World = {
    branch: 'x',
    agents: [{ id: 'a', status: 'completed' }, { id: 'b', status: 'failed' }, { id: 'c', status: 'running' }],
  }
  world(on, w)
  await $.turn.complete(turn())
  expect(await bandText($)).toBe('⎇ x | 🤖 1 ▸ 1 ✓ 1 ✗')

  w.agents = [] // the engine forgot them all; c vanished while still active, so it counts as done
  await $.turn.complete(turn())
  expect(await bandText($)).toBe('⎇ x | 🤖 0 ▸ 2 ✓ 1 ✗')
})

test('a subagent turn marks its own spawned agent by reason', async ($, on) => {
  const w: World = { branch: 'x', agents: [] }
  world(on, w)
  for (const id of ['s1', 's2', 's3']) {
    w.spawnId = id
    await spawn($, 'work')
  }
  expect(await bandText($)).toBe('🤖 3 ▸ 0 ✓')
  await $.turn.complete(turn({ agentId: 's1', reason: 'answer' }))
  await $.turn.complete(turn({ agentId: 's2', reason: 'error' }))
  await $.turn.complete(turn({ agentId: 's3', reason: 'aborted' }))
  expect(await bandText($)).toBe('🤖 0 ▸ 1 ✓ 2 ✗')
})

test('engine forks (compaction, memory) never enter the tally', async ($, on) => {
  world(on, { branch: 'x', agents: [] })
  for (const agentId of ['fork-compact', 'fork-memory']) {
    await $.turn.complete(turn({ agentId, reason: 'answer' }))
    await $.turn.complete(turn({ agentId, reason: 'error' }))
  }
  await $.turn.complete(turn())
  expect(await bandText($)).toBe('⎇ x')
})

test('a freshly spawned agent absent from the list is not counted done', async ($, on) => {
  const w: World = { branch: 'x', agents: [] }
  world(on, w)
  await spawn($, 'work')
  await $.turn.complete(turn()) // the list does not name it yet
  expect(await bandText($)).toBe('⎇ x | 🤖 1 ▸ 0 ✓')

  w.agents = [{ id: 'spawned-1', status: 'running' }] // now seen in the list...
  await $.turn.complete(turn())
  w.agents = [] // ...and then the engine drops it while it was still active
  await $.turn.complete(turn())
  expect(await bandText($)).toBe('⎇ x | 🤖 0 ▸ 1 ✓')
})

test('list reads are serialized and the newest one wins', async ($, on) => {
  let release!: () => void
  const w: World = {
    branch: 'x',
    agents: [{ id: 'a', status: 'running' }],
    agentsGate: new Promise<void>(resolve => (release = resolve)),
  }
  const { clock } = world(on, w)
  const turns = [$.turn.complete(turn()), $.turn.complete(turn()), $.turn.complete(turn())]
  await clock.settle()
  expect(w.agentListCalls).toBe(1) // one read in flight, the others wait

  w.agents = [{ id: 'a', status: 'completed' }] // newer than what the first read captured
  release()
  await Promise.all(turns)
  expect(w.agentListCalls).toBe(2) // exactly one rerun for all the requests that arrived meanwhile
  expect(await bandText($)).toBe('⎇ x | 🤖 0 ▸ 1 ✓')
})

test('a subagent turn overrides a stale running status in the list', async ($, on) => {
  world(on, { branch: 'x', agents: [{ id: 's1', status: 'running' }] })
  await $.turn.complete(turn({ agentId: 's1', reason: 'answer' }))
  expect(await bandText($)).toBe('🤖 0 ▸ 1 ✓')
})

test('spawning an agent refreshes the tally', async ($, on) => {
  const w: World = { branch: 'x', agents: [] }
  world(on, w)
  w.agents = [{ id: 'spawned-1', status: 'running' }]
  await spawn($, 'read the readme')
  expect(await bandText($)).toBe('🤖 1 ▸ 0 ✓')
})

test('the 20 second tick refreshes the tally', async ($, on) => {
  const w: World = { branch: 'x', agents: [] }
  const { clock } = world(on, w)
  await start($, clock)
  expect(await bandText($)).toBe('⎇ x')
  w.agents = [{ id: 'a', status: 'running' }]
  await clock.advance(20_000)
  expect(await bandText($)).toBe('⎇ x | 🤖 1 ▸ 0 ✓')
})

test('no subagents, no segment; a failing list never breaks a turn', async ($, on) => {
  const w: World = { branch: 'x', agentsFail: true }
  world(on, w)
  const result = await $.turn.complete(turn())
  expect(result.text).toBe('ok')
  expect(await bandText($)).toBe('⎇ x')
})

test('the session ending forgets the tally', async ($, on) => {
  world(on, { branch: 'x', agents: [{ id: 'a', status: 'completed' }] })
  await $.turn.complete(turn())
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  const w2 = await bandText($)
  expect(w2.includes('🤖')).toBe(false)
})

// ---------------------------------------------------------------- session title

const titleOf = async ($: any) => (await $.classic.UserPromptSubmit({ prompt: 'hi' })).sessionTitle as string | undefined

test('composes the title from work item, description and context', () => {
  expect(composeTitle('8423', 'Licenses endpoint', 42)).toBe('WI #8423 · Licenses endpoint · ctx 42%')
  expect(composeTitle('8423', undefined, 42)).toBe('WI #8423 · ctx 42%')
  expect(composeTitle('8423', 'Licenses endpoint', undefined)).toBe('WI #8423 · Licenses endpoint')
  expect(composeTitle('8423', undefined, undefined)).toBe('WI #8423')
})

test('descriptions are trimmed, collapsed and cut to 40 characters with an ellipsis', () => {
  expect(describeTitle('  Connector.Visma \n  -   BE  ')).toBe('Connector.Visma - BE')
  expect(describeTitle('a'.repeat(40))).toBe('a'.repeat(40))
  expect(describeTitle('a'.repeat(50))).toBe(`${'a'.repeat(39)}…`)
  expect(describeTitle('   ')).toBe(undefined)
})

test('extracts System.Title from the az JSON and ignores garbage', () => {
  expect(parseWorkItemTitle('{"System.Title":"Hello","x":1}')).toBe('Hello')
  expect(parseWorkItemTitle('not json')).toBe(undefined)
  expect(parseWorkItemTitle('{"System.State":"Active"}')).toBe(undefined)
  expect(parseWorkItemTitle('{"System.Title":""}')).toBe(undefined)
})

test('no work item, no title', async ($, on) => {
  world(on, { branch: 'main', percent: 42 })
  await $.turn.complete(turn())
  const result = await $.classic.UserPromptSubmit({ prompt: 'hi' })
  expect(result.sessionTitle).toBe(undefined)
})

test('an uncached title is set without the description and never awaits az', async ($, on) => {
  let release!: () => void
  const w: World = { branch: 'feature/issue-8423', percent: 42, azTitle: 'Licenses endpoint', azGate: new Promise<void>(r => (release = r)) }
  const { clock } = world(on, w)
  await $.turn.complete(turn())

  expect(await titleOf($)).toBe('WI #8423 · ctx 42%') // resolved while az has not even finished
  await clock.settle()
  expect(w.azCalls).toBe(1)
  release()
  await clock.settle()

  expect(await titleOf($)).toBe('WI #8423 · Licenses endpoint · ctx 42%') // the next prompt picks it up
})

test('the az call is a cmd /d /s /c argv with a 15 second timeout', async ($, on) => {
  const w: World = { branch: 'feature/issue-8423', azTitle: 'T' }
  const { clock } = world(on, w)
  await $.turn.complete(turn())
  await titleOf($)
  await clock.settle()
  expect(w.azArgv?.argv).toEqual([
    'cmd', '/d', '/s', '/c', 'az', 'boards', 'work-item', 'show', '--id', '8423',
    '--organization', 'https://dev.azure.com/propato', '--query', 'fields', '-o', 'json',
  ])
  expect(w.azArgv?.init?.timeoutMs).toBe(15_000)
})

test('a cached title is used and az never runs', async ($, on) => {
  const w: World = { branch: 'feature/issue-8423', percent: 42, azTitle: 'Other', store: { 'wi-title:8423': 'Cached title' } }
  const { clock } = world(on, w)
  await $.turn.complete(turn())
  expect(await titleOf($)).toBe('WI #8423 · Cached title · ctx 42%')
  await clock.settle()
  expect(w.azCalls).toBe(undefined)
})

test('long cached titles are truncated in the session title', async ($, on) => {
  world(on, { branch: 'feature/issue-8423', store: { 'wi-title:8423': 'Connector.Visma - BE Endpoint de listado de licencias' } })
  await $.turn.complete(turn())
  expect(await titleOf($)).toBe('WI #8423 · Connector.Visma - BE Endpoint de listad…')
})

test('an unknown context percent drops the ctx part', async ($, on) => {
  world(on, { branch: 'feature/issue-8423', store: { 'wi-title:8423': 'Cached' } })
  await $.turn.complete(turn())
  expect(await titleOf($)).toBe('WI #8423 · Cached')
})

test('concurrent prompts fetch each work item once', async ($, on) => {
  let release!: () => void
  const w: World = { branch: 'feature/issue-8423', azTitle: 'T', azGate: new Promise<void>(r => (release = r)) }
  const { clock } = world(on, w)
  await $.turn.complete(turn())
  await titleOf($)
  await clock.settle()
  await titleOf($)
  await titleOf($)
  await clock.settle()
  expect(w.azCalls).toBe(1)
  release()
  await clock.settle()
})

test('failures are silent, cache nothing and retry once per session', async ($, on) => {
  const w: World = { branch: 'feature/issue-8423', percent: 10 } // azTitle undefined: az fails
  const { clock } = world(on, w)
  await $.turn.complete(turn())
  for (let i = 0; i < 4; i++) {
    expect(await titleOf($)).toBe('WI #8423 · ctx 10%')
    await clock.settle()
  }
  expect(w.azCalls).toBe(2)
})

test('an active run work item wins over the branch one', async ($, on) => {
  world(on, { branch: 'feature/issue-8423', store: { 'wi-title:9001': 'Run item' } })
  await submit($, '/prosuite-comandos:work-item 9001')
  expect(await titleOf($)).toBe('WI #9001 · Run item')
})

test('the title is also set when the session starts', async ($, on) => {
  const { clock } = world(on, { branch: 'feature/issue-8423', percent: 5, store: { 'wi-title:8423': 'Cached' } })
  await $.session.start({ cwd: 'C:\\Repos\\app', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const result = await $.classic.SessionStart({ source: 'startup' })
  expect(result.sessionTitle).toBe('WI #8423 · Cached · ctx 5%')
})

test('only a numeric work item id can reach cmd', () => {
  expect(azArgv('8423')).toContain('8423')
  expect(() => azArgv('8423 & calc')).toThrow('invalid work item id')
  expect(() => azArgv('')).toThrow('invalid work item id')
})
