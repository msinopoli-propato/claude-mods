import { expect, mock, test } from 'claude-code/testing'

import { parseHealth, healthColors } from './health'
import { contextBar } from './segments'
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

// A pill as drawn: its Text's props, its shown text and, for a keyed pill, the hover card beside it.
type Pill = {
  text: string
  label: string
  color?: unknown
  backgroundColor?: unknown
  bold?: unknown
  hover?: string
  card?: Record<string, unknown>
}

const textOf = (node: any): string =>
  typeof node === 'string' ? node : (node?.children ?? []).map(textOf).join('')

const pillOf = (node: any): Pill => {
  if (node.type === 'Text') {
    const text = textOf(node)
    return { ...node.props, text, label: text.trim() }
  }
  const [glyph, card] = node.children
  return { ...pillOf(glyph), hover: textOf(card).trim(), card: { ...card.props, hover: card.hover } }
}

// The band's rows of pills; the engine's own empty Box (the plugin passed) is no rows.
const drawRows = async ($: any, surface: (typeof SURFACES)[number] = 'terminal', props: object = BAND_PROPS) => {
  const ui = await $.ui.mount({ plugin: 'session-status', surface, component: 'AbovePrompt', props })
  const tree: any = await ui.drawn()
  return (tree.children ?? []).map((row: any): Pill[] => row.children.map(pillOf))
}

const textOfRows = (rows: Pill[][]) => rows.map(row => row.map(p => p.label).join(' | ')).join('\n')
const named = (rows: Pill[][], prefix: string) => rows.flat().find(p => p.label.startsWith(prefix))!
const branchOf = (rows: Pill[][]) => rows.flat().find(p => p.label.startsWith('⎇'))
const bandText = async ($: any, surface: (typeof SURFACES)[number] = 'terminal') => textOfRows(await drawRows($, surface))

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
  test(`band draws work and gauge rows of pills on ${surface}`, async ($, on) => {
    world(on, { branch: 'feature/issue-8423', porcelain: ' M a.cs\n', percent: 42, tokens: 84_200 })
    await $.turn.complete(turn())
    const rows = await drawRows($, surface)

    expect(textOfRows(rows)).toBe('WI #8423 | ⎇ feature/issue-8423*\nctx ▰▰▰▱▱▱▱▱ 42%')
    const [[wi, branch], [ctx]] = rows
    expect(wi).toMatchObject({ backgroundColor: 'claude', bold: true })
    expect(branch.backgroundColor).toBe('warning')
    expect(ctx.backgroundColor).toBe('success')
  })

  test(`every pill is inverse text on its color, padded one space each side, on ${surface}`, async ($, on) => {
    const { clock } = world(on, { branch: 'feature/issue-8423', percent: 42, health: SAMPLE, agents: [{ id: 'a', status: 'running' }] })
    await start($, clock)
    await submit($, '/prosuite-comandos:work-item 8423')
    const pills = (await drawRows($, surface)).flat()
    expect(pills).toHaveLength(8)
    for (const pill of pills) {
      expect(pill.color).toBe('inverseText')
      expect(typeof pill.backgroundColor).toBe('string')
      expect(pill.text).toBe(` ${pill.label} `)
    }
  })

  test(`band shows the timer pill on ${surface}`, async ($, on) => {
    const { clock } = world(on, { branch: 'feature/issue-8423', percent: 10 })
    await submit($, '/prosuite-comandos:work-item 8423')
    for (let i = 0; i < 9; i++) {
      await clock.advance(9 * MINUTE) // 81 minutes of steady activity: 1.35h
      await $.turn.complete(turn())
    }
    const rows = await drawRows($, surface)
    expect(textOfRows(rows)).toBe('WI #8423 | ⎇ feature/issue-8423 | ⏱ 1.3h\nctx ▰▱▱▱▱▱▱▱ 10%')
    expect(named(rows, '⏱')).toMatchObject({ label: '⏱ 1.3h', backgroundColor: 'permission' })
  })
}

test('an active run wins over the branch work item and WI is shown once', async ($, on) => {
  world(on, { branch: 'feature/issue-1111', percent: 10 })
  await submit($, '/prosuite-comandos:work-item 8423')
  await $.turn.complete(turn())
  expect(textOfRows(await drawRows($))).toBe('WI #8423 | ⎇ feature/issue-1111 | ⏱ 0.0h\nctx ▰▱▱▱▱▱▱▱ 10%')
})

test('a run with unknown work item and no branch work item shows WI ?', async ($, on) => {
  world(on, { branch: 'desarrollo' })
  await submit($, '/prosuite-comandos:test-en-vivo')
  await $.turn.complete(turn())
  const rows = await drawRows($)
  expect(textOfRows(rows)).toBe('WI ? | ⎇ desarrollo | ⏱ 0.0h')
  expect(rows[0][0]).toMatchObject({ backgroundColor: 'claude', bold: true })
})

test('a run with unknown work item falls back to the branch work item', async ($, on) => {
  const w: World = { branch: 'desarrollo' }
  world(on, w)
  await submit($, '/prosuite-comandos:test-en-vivo') // unknown at start
  w.branch = 'feature/issue-77'
  await $.turn.complete(turn())
  expect(textOfRows(await drawRows($))).toBe('WI #77 | ⎇ feature/issue-77 | ⏱ 0.0h')
})

test('clean branch is green, protected branches are bold red even when clean', async ($, on) => {
  const w: World = { branch: 'feature/issue-5' }
  world(on, w)
  await $.turn.complete(turn())
  expect(branchOf(await drawRows($))).toMatchObject({ label: '⎇ feature/issue-5', backgroundColor: 'success' })

  for (const name of ['main', 'master', 'dev', 'desarrollo', 'UAT']) {
    w.branch = name
    await $.turn.complete(turn())
    expect(branchOf(await drawRows($))).toMatchObject({ label: `⎇ ${name}`, backgroundColor: 'error', bold: true })
  }
})

test('dirty protected branch stays red and shows the asterisk', async ($, on) => {
  world(on, { branch: 'main', porcelain: ' M a.cs\n' })
  await $.turn.complete(turn())
  expect(branchOf(await drawRows($, 'desktop'))).toMatchObject({ label: '⎇ main*', backgroundColor: 'error', bold: true })
})

test('context color follows the thresholds', async ($, on) => {
  const cases: [number, string][] = [[0, 'success'], [59, 'success'], [60, 'warning'], [84, 'warning'], [85, 'error'], [100, 'error']]
  const w: World = { branch: 'feature/x' }
  world(on, w)
  for (const [percent, color] of cases) {
    w.percent = percent
    await $.turn.complete(turn())
    const ctx = named(await drawRows($), 'ctx')
    expect([percent, ctx.backgroundColor]).toEqual([percent, color])
  }
})

test('reads the work item from a Windows worktree path', async ($, on) => {
  world(on, { branch: 'desarrollo', cwd: 'C:\\Repos\\worktrees\\stock-api-issue-912' })
  await $.turn.complete(turn())
  expect(textOfRows(await drawRows($))).toBe('WI #912 | ⎇ desarrollo')
})

test('outside a git repo the empty work row is omitted and only the gauges show', async ($, on) => {
  world(on, { percent: 5 })
  await $.turn.complete(turn())
  const rows = await drawRows($, 'desktop')
  expect(rows).toHaveLength(1)
  expect(textOfRows(rows)).toBe('ctx ▱▱▱▱▱▱▱▱ 5%')
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
  const ui = await $.ui.mount({ plugin: 'session-status', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, hasSurvey: true } })
  expect(await ui.findAll({ type: 'Text' })).toHaveLength(0)
})

// ---------------------------------------------------------------- hover cards

const REVEAL = { position: 'absolute', top: 0, display: 'none', hover: { display: 'flex' } }

for (const surface of SURFACES) {
  test(`a cached work item title is a hover card beside the WI pill on ${surface}`, async ($, on) => {
    world(on, { branch: 'feature/issue-8423', store: { 'wi-title:8423': 'Licenses endpoint' } })
    await $.turn.complete(turn())
    const wi = named(await drawRows($, surface), 'WI')
    expect(wi).toMatchObject({ label: 'WI #8423', backgroundColor: 'claude', hover: 'Licenses endpoint' })
    // Opens right after the pill and its gap, over the rest of the row.
    expect(wi.card).toMatchObject({ ...REVEAL, left: ' WI #8423 '.length + 1 })
  })

  test(`the token count is a hover card on the ctx pill on ${surface}`, async ($, on) => {
    world(on, { branch: 'x', percent: 42, tokens: 84_200 })
    await $.turn.complete(turn())
    const ctx = named(await drawRows($, surface), 'ctx')
    expect(ctx).toMatchObject({ label: 'ctx ▰▰▰▱▱▱▱▱ 42%', hover: '84k tokens' })
    expect(ctx.card).toMatchObject({ ...REVEAL, left: ' ctx ▰▰▰▱▱▱▱▱ 42% '.length + 1 })
  })
}

test('the card text is inverse on the pill color, padded', async ($, on) => {
  world(on, { branch: 'feature/issue-8423', store: { 'wi-title:8423': 'Licenses endpoint' } })
  await $.turn.complete(turn())
  const ui = await $.ui.mount({ plugin: 'session-status', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const card = await ui.find({ type: 'Text', text: 'Licenses endpoint' })
  expect(card).toMatchObject({ text: ' Licenses endpoint ', props: { color: 'inverseText', backgroundColor: 'claude' } })
})

test('long titles are cut to 60 characters on the card', async ($, on) => {
  const title = 'Connector.Visma - BE Endpoint de listado de licencias con filtros por fecha y estado'
  world(on, { branch: 'feature/issue-8423', store: { 'wi-title:8423': title } })
  await $.turn.complete(turn())
  expect(named(await drawRows($), 'WI').hover).toBe(`${title.slice(0, 59)}…`)
})

test('describeTitle takes a longer limit for the card', () => {
  expect(describeTitle('a'.repeat(60), 60)).toBe('a'.repeat(60))
  expect(describeTitle('a'.repeat(61), 60)).toBe(`${'a'.repeat(59)}…`)
})

test('no cached title, no card, and drawing never runs az', async ($, on) => {
  const w: World = { branch: 'feature/issue-8423', azTitle: 'Licenses endpoint' }
  const { clock } = world(on, w)
  await $.turn.complete(turn())
  expect(named(await drawRows($), 'WI').hover).toBe(undefined)
  await clock.settle()
  expect(w.azCalls).toBe(undefined)
})

test('the card follows the run work item', async ($, on) => {
  world(on, { branch: 'feature/issue-1111', store: { 'wi-title:1111': 'Branch item', 'wi-title:9001': 'Run item' } })
  await submit($, '/prosuite-comandos:work-item 9001')
  expect(named(await drawRows($), 'WI').hover).toBe('Run item')
})

test('unknown tokens leave the ctx pill without a card', async ($, on) => {
  world(on, { branch: 'x', percent: 42 })
  await $.turn.complete(turn())
  expect(named(await drawRows($), 'ctx').hover).toBe(undefined)
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
  expect(named(await drawRows($), '⏱')).toMatchObject({ label: '⏱ 0.0h', backgroundColor: 'permission' })
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

test('no run, no timer pill', async ($, on) => {
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

test('colors follow the thresholds of each metric', () => {
  const colors = (cpu: number, ram: number, tempC: number | null) => healthColors({ cpu, ram, tempC })
  expect(colors(69, 74, 69)).toEqual({ cpu: 'success', ram: 'success', temp: 'success' })
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
      'WI #8423 | ⎇ feature/issue-8423 | ⏱ 0.0h\nctx ▰▰▰▱▱▱▱▱ 42% | CPU 27% | RAM 75% | 62°C',
    )
    const [cpu, ram, temp] = (['CPU', 'RAM', '62'] as const).map(prefix => named(rows, prefix)) as [Pill, Pill, Pill]
    expect([cpu.backgroundColor, ram.backgroundColor, temp.backgroundColor]).toEqual(['success', 'warning', 'success'])
  })
}

test('colors reach the band per metric', async ($, on) => {
  const { clock } = world(on, { branch: 'x', health: '95|1000|4000|3700' })
  await start($, clock)
  const rows = await drawRows($)
  const [cpu, ram, temp] = (['CPU', 'RAM', '97'] as const).map(prefix => named(rows, prefix)) as [Pill, Pill, Pill]
  expect([cpu, ram, temp].map(s => [s.label, s.backgroundColor])).toEqual([
    ['CPU 95%', 'error'],
    ['RAM 75%', 'warning'],
    ['97°C', 'error'],
  ])
})

test('missing temperature leaves CPU and RAM only', async ($, on) => {
  const { clock } = world(on, { branch: 'x', health: '27|8195448|33177908|' })
  await start($, clock)
  expect(await bandText($)).toBe('⎇ x\nCPU 27% | RAM 75%')
})

test('a failing or unparsable read omits the health pills', async ($, on) => {
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
  const ui = await $.ui.mount({ plugin: 'session-status', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect((await ui.find({ type: 'Text', text: /CPU/ }))?.text.trim()).toBe('CPU 27%')

  w.health = '50|1000|4000|3352'
  await clock.advance(19_000)
  expect((await ui.find({ type: 'Text', text: /CPU/ }))?.text.trim()).toBe('CPU 27%')
  await clock.advance(1_000)
  expect((await ui.find({ type: 'Text', text: /CPU/ }))?.text.trim()).toBe('CPU 50%')
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
  test(`one agents pill closes the work row, after the timer, on ${surface}`, async ($, on) => {
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
    expect(textOfRows(rows)).toBe('WI #8423 | ⎇ feature/issue-8423 | ⏱ 0.0h | 🤖 2 ▸ 3 ✓\nctx ▰▱▱▱▱▱▱▱ 10%')
    expect(named(rows, '🤖')).toMatchObject({ backgroundColor: 'warning', bold: true })
  })
}

test('without a timer the agents pill follows the branch', async ($, on) => {
  world(on, { branch: 'feature/issue-8423', agents: [{ id: 'a', status: 'running' }] })
  await $.turn.complete(turn())
  expect(await bandText($)).toBe('WI #8423 | ⎇ feature/issue-8423 | 🤖 1 ▸ 0 ✓')
})

test('nothing running is green, and failed shows only when above zero', async ($, on) => {
  world(on, { branch: 'x', agents: [{ id: 'a', status: 'completed' }] })
  await $.turn.complete(turn())
  const rows = await drawRows($)
  expect(textOfRows(rows)).toBe('⎇ x | 🤖 0 ▸ 1 ✓')
  const agents = named(rows, '🤖')
  expect(agents.backgroundColor).toBe('success')
  expect(agents.bold).toBe(undefined)
})

test('failed and killed agents land in the failed count, red when nothing runs', async ($, on) => {
  world(on, { branch: 'x', agents: [{ id: 'a', status: 'failed' }, { id: 'b', status: 'killed' }, { id: 'c', status: 'completed' }] })
  await $.turn.complete(turn())
  const rows = await drawRows($)
  expect(textOfRows(rows)).toBe('⎇ x | 🤖 0 ▸ 1 ✓ 2 ✗')
  expect(named(rows, '🤖').backgroundColor).toBe('error')
})

test('running wins the color over failed', async ($, on) => {
  world(on, { branch: 'x', agents: [{ id: 'a', status: 'failed' }, { id: 'b', status: 'running' }] })
  await $.turn.complete(turn())
  const rows = await drawRows($)
  expect(textOfRows(rows)).toBe('⎇ x | 🤖 1 ▸ 0 ✓ 1 ✗')
  expect(named(rows, '🤖')).toMatchObject({ backgroundColor: 'warning', bold: true })
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
