import { expect, mock, test } from 'claude-code/testing'

import { parseHealth, healthColors } from './health'
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
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
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

type Segment = { text: string; color?: unknown; bold?: unknown; dimColor?: unknown }

const drawBand = async ($: any, surface: (typeof SURFACES)[number], props: object = BAND_PROPS) => {
  const ui = await $.ui.mount({ plugin: 'session-status', surface, component: 'AbovePrompt', props })
  const texts = await ui.findAll({ type: 'Text' })
  return texts.map((t: any): Segment => ({ text: t.text, ...t.props }))
}

const segmentsOf = (all: Segment[]) => all.filter(s => s.text !== ' · ')

const compose = ($: any) =>
  $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })

const wiTime = async ($: any) => (await $.command.run({ command: 'wi-time' })).text as string

test('finds the work item in branch and worktree names', () => {
  expect(findWorkItem('feature/issue-8423')).toBe('8423')
  expect(findWorkItem('fix/issue-77')).toBe('77')
  expect(findWorkItem('main', 'C:/Repos/worktrees/stock-api-issue-912')).toBe('912')
  expect(findWorkItem('desarrollo', 'C:/Repos/app')).toBe(undefined)
  expect(findWorkItem('feature/tissue-12')).toBe(undefined)
})

// ---------------------------------------------------------------- band

for (const surface of SURFACES) {
  test(`band draws colored segments on ${surface}`, async ($, on) => {
    world(on, { branch: 'feature/issue-8423', porcelain: ' M a.cs\n', percent: 42, tokens: 84_200 })
    await $.turn.complete(turn())
    const all = await drawBand($, surface)

    expect(all.map(s => s.text).join('')).toBe('⎇ feature/issue-8423* · WI #8423 · claude-opus-5-5 · ctx 42% (84k)')
    const [branch, wi, model, ctx] = segmentsOf(all)
    expect(branch.color).toBe('warning')
    expect(wi).toMatchObject({ color: 'claude', bold: true })
    expect(model.color).toBe('suggestion')
    expect(ctx.color).toBe('success')
    expect(all.filter(s => s.text === ' · ').every(s => s.dimColor === true)).toBe(true)
  })

  test(`band shows the timer segment on ${surface}`, async ($, on) => {
    const { clock } = world(on, { branch: 'feature/issue-8423', percent: 10 })
    await $.prompt.submit({ text: '/prosuite-comandos:work-item 8423' })
    for (let i = 0; i < 9; i++) {
      await clock.advance(9 * MINUTE) // 81 minutes of steady activity: 1.35h
      await $.turn.complete(turn())
    }
    const timer = segmentsOf(await drawBand($, surface)).at(-1)!
    expect(timer).toMatchObject({ text: '⏱ WI #8423 1.3h', color: 'permission' })
  })
}

test('clean branch is green, protected branches are bold red even when clean', async ($, on) => {
  const w: World = { branch: 'feature/issue-5' }
  world(on, w)
  await $.turn.complete(turn())
  expect(segmentsOf(await drawBand($, 'terminal'))[0]).toMatchObject({ text: '⎇ feature/issue-5', color: 'success' })

  for (const name of ['main', 'master', 'dev', 'desarrollo', 'UAT']) {
    w.branch = name
    await $.turn.complete(turn())
    expect(segmentsOf(await drawBand($, 'terminal'))[0]).toMatchObject({ text: `⎇ ${name}`, color: 'error', bold: true })
  }
})

test('dirty protected branch stays red and shows the asterisk', async ($, on) => {
  world(on, { branch: 'main', porcelain: ' M a.cs\n' })
  await $.turn.complete(turn())
  expect(segmentsOf(await drawBand($, 'desktop'))[0]).toMatchObject({ text: '⎇ main*', color: 'error', bold: true })
})

test('context color follows the thresholds', async ($, on) => {
  const cases: [number, string][] = [[0, 'success'], [59, 'success'], [60, 'warning'], [84, 'warning'], [85, 'error'], [100, 'error']]
  const w: World = { branch: 'feature/x' }
  world(on, w)
  for (const [percent, color] of cases) {
    w.percent = percent
    await $.turn.complete(turn())
    const ctx = segmentsOf(await drawBand($, 'terminal')).find(s => s.text.startsWith('ctx'))!
    expect([percent, ctx.color]).toEqual([percent, color])
  }
})

test('reads the work item from a Windows worktree path', async ($, on) => {
  world(on, { branch: 'desarrollo', cwd: 'C:\\Repos\\worktrees\\stock-api-issue-912' })
  await $.turn.complete(turn())
  const all = await drawBand($, 'terminal')
  expect(all.map(s => s.text).join('')).toBe('⎇ desarrollo · WI #912 · claude-opus-5-5')
})

test('outside a git repo it shows only the model and usage', async ($, on) => {
  world(on, { percent: 5 })
  await $.turn.complete(turn())
  const all = await drawBand($, 'desktop')
  expect(all.map(s => s.text).join('')).toBe('claude-opus-5-5 · ctx 5%')
})

test('ignores subagent turns', async ($, on) => {
  world(on, { branch: 'feature/issue-1' })
  await $.turn.complete(turn({ agentId: 'sub-1' }))
  // Nothing was refreshed: the band has nothing to draw yet.
  const ui = await $.ui.mount({ plugin: 'session-status', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.findAll({ type: 'Text' })).toHaveLength(0)
})

test('yields the band to a survey', async ($, on) => {
  world(on, { branch: 'feature/x' })
  await $.turn.complete(turn())
  const ui = await $.ui.mount({ plugin: 'session-status', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, hasSurvey: true } })
  expect(await ui.findAll({ type: 'Text' })).toHaveLength(0)
})

// ---------------------------------------------------------------- timer

test('excludes gaps longer than ten minutes entirely', async ($, on) => {
  const { clock } = world(on, { branch: 'main' })
  await $.prompt.submit({ text: '/prosuite-comandos:work-item 8423' }) // t = 0
  await clock.advance(5 * MINUTE)
  await $.tool.call({ tool: 'Bash', command: 'ls' }) // t = 5
  await clock.advance(15 * MINUTE)
  await $.turn.complete(turn()) // t = 20: a 15 minute gap, ignored
  expect(await wiTime($)).toContain('active 0h 5m')
})

test('a gap of exactly ten minutes still counts', async ($, on) => {
  const { clock } = world(on, { branch: 'main' })
  await $.prompt.submit({ text: '/prosuite-comandos:work-item 8423' })
  await clock.advance(10 * MINUTE)
  await $.turn.complete(turn())
  expect(await wiTime($)).toContain('active 0h 10m')
})

test('prompts, tool calls and main turns are all activity; subagent turns are not', async ($, on) => {
  const { clock } = world(on, { branch: 'main' })
  await $.prompt.submit({ text: '/prosuite-comandos:work-item 8423' })
  await clock.advance(2 * MINUTE)
  await $.prompt.submit({ text: 'continue' })
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
  await $.prompt.submit({ text: '/prosuite-comandos:work-item 8423' })
  await clock.advance(8 * MINUTE)
  await $.turn.complete(turn())
  expect(await wiTime($)).toContain('WI #8423 · active 0h 8m')

  await clock.advance(2 * MINUTE)
  await $.prompt.submit({ text: '/prosuite-comandos:code-review-jueces 9001' })
  expect(await wiTime($)).toContain('WI #9001 · active 0h 0m')
})

test('other slash commands do not start a run', async ($, on) => {
  world(on, { branch: 'main' })
  await $.prompt.submit({ text: '/compact' })
  await $.prompt.submit({ text: 'hello' })
  expect(await wiTime($)).toBe('No prosuite-comandos run is active.')
})

test('work item comes from the first standalone number of 2+ digits in the args', async ($, on) => {
  world(on, { branch: 'feature/issue-1111' })
  await $.prompt.submit({ text: '/prosuite-comandos:work-item-tdd 7 fix v2 8423 9999' })
  expect(await wiTime($)).toContain('WI #8423')
  await $.prompt.submit({ text: '/prosuite-comandos:work-item #4567' })
  expect(await wiTime($)).toContain('WI #4567')
})

test('falls back to the branch, then the worktree path, when the args name no work item', async ($, on) => {
  const w: World = { branch: 'feature/issue-1111' }
  world(on, w)
  await $.prompt.submit({ text: '/prosuite-comandos:refine-item-perf' })
  expect(await wiTime($)).toContain('WI #1111')

  w.branch = 'desarrollo'
  w.cwd = 'C:\\Repos\\worktrees\\api-issue-912'
  await $.prompt.submit({ text: '/prosuite-comandos:refine-item-perf 5 words' })
  expect(await wiTime($)).toContain('WI #912')
})

test('unknown work item shows a question mark in the band', async ($, on) => {
  world(on, { branch: 'desarrollo' })
  await $.prompt.submit({ text: '/prosuite-comandos:test-en-vivo' })
  await $.turn.complete(turn())
  expect(await wiTime($)).toContain('WI ?')
  const timer = segmentsOf(await drawBand($, 'terminal')).at(-1)!
  expect(timer).toMatchObject({ text: '⏱ WI ? 0.0h', color: 'permission' })
})

test('hours are rounded down, never up', async ($, on) => {
  const { clock } = world(on, { branch: 'main' })
  await $.prompt.submit({ text: '/prosuite-comandos:work-item 8423' })
  for (let i = 0; i < 11; i++) {
    await clock.advance(9 * MINUTE) // 99 minutes in total: 1.65h
    await $.turn.complete(turn())
  }
  const timer = segmentsOf(await drawBand($, 'terminal')).at(-1)!
  expect(timer.text).toBe('⏱ WI #8423 1.6h')
})

test('the session ending closes the run', async ($, on) => {
  world(on, { branch: 'main' })
  await $.prompt.submit({ text: '/prosuite-comandos:work-item 8423' })
  await $.session.end({ reason: 'other', sessionId: 's1', resume: {} as never })
  expect(await wiTime($)).toBe('No prosuite-comandos run is active.')
})

test('no run, no timer segment', async ($, on) => {
  world(on, { branch: 'feature/issue-8423' })
  await $.turn.complete(turn())
  const all = await drawBand($, 'terminal')
  expect(all.some(s => s.text.startsWith('⏱'))).toBe(false)
})

// ------------------------------------------------------- prompt injection

test('injects the measured time into the system prompt only while a run is active', async ($, on) => {
  const { clock } = world(on, { branch: 'main' })

  const before = await compose($)
  expect(before.sections.map((s: { id: string }) => s.id)).toEqual(['intro'])

  await $.prompt.submit({ text: '/prosuite-comandos:work-item 8423' })
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
  await $.prompt.submit({ text: '/prosuite-comandos:work-item 8423' })
  for (let i = 0; i < 9; i++) {
    await clock.advance(9 * MINUTE)
    await $.turn.complete(turn())
  }
  const { sections } = await compose($)
  expect(sections.at(-1)!.text).toContain('WI 8423 in the current prosuite-comandos run: 1.3h')
})

test('the injection says the work item is unknown when none was found', async ($, on) => {
  world(on, { branch: 'main' })
  await $.prompt.submit({ text: '/prosuite-comandos:test-en-vivo' })
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
  await $.prompt.submit({ text: '/prosuite-comandos:work-item 8423' })
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
  test(`band draws CPU, RAM and temperature between ctx and the timer on ${surface}`, async ($, on) => {
    const { clock } = world(on, { branch: 'feature/issue-8423', percent: 42, tokens: 84_200, health: SAMPLE })
    await start($, clock)
    await $.prompt.submit({ text: '/prosuite-comandos:work-item 8423' })
    const all = await drawBand($, surface)

    expect(all.map(s => s.text).join('')).toBe(
      '⎇ feature/issue-8423 · WI #8423 · claude-opus-5-5 · ctx 42% (84k) · CPU 27% · RAM 75% · 62°C · ⏱ WI #8423 0.0h',
    )
    const [, , , , cpu, ram, temp] = segmentsOf(all)
    expect([cpu.color, ram.color, temp.color]).toEqual(['success', 'warning', 'success'])
  })
}

test('colors reach the band per metric', async ($, on) => {
  const { clock } = world(on, { branch: 'x', health: '95|1000|4000|3700' })
  await start($, clock)
  const [, , cpu, ram, temp] = segmentsOf(await drawBand($, 'terminal'))
  expect([cpu, ram, temp].map(s => [s.text, s.color])).toEqual([
    ['CPU 95%', 'error'],
    ['RAM 75%', 'warning'],
    ['97°C', 'error'],
  ])
})

test('missing temperature leaves CPU and RAM only', async ($, on) => {
  const { clock } = world(on, { branch: 'x', health: '27|8195448|33177908|' })
  await start($, clock)
  const texts = (await drawBand($, 'terminal')).map(s => s.text).join('')
  expect(texts).toBe('⎇ x · claude-opus-5-5 · CPU 27% · RAM 75%')
})

test('a failing or unparsable read omits the whole segment', async ($, on) => {
  const failing = world(on, { branch: 'x' })
  await start($, failing.clock)
  expect((await drawBand($, 'terminal')).map(s => s.text).join('')).toBe('⎇ x · claude-opus-5-5')
})

test('unparsable stdout omits the segment too', async ($, on) => {
  const { clock } = world(on, { branch: 'x', health: 'garbage' })
  await start($, clock)
  expect((await drawBand($, 'desktop')).map(s => s.text).join('')).toBe('⎇ x · claude-opus-5-5')
})

test('reads on an interval of 20 seconds and redraws the new value', async ($, on) => {
  const w: World = { branch: 'x', health: '27|1000|4000|3352' }
  const { clock } = world(on, w)
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'session-status', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect((await ui.find({ type: 'Text', text: /^CPU/ }))?.text).toBe('CPU 27%')

  w.health = '50|1000|4000|3352'
  await clock.advance(19_000)
  expect((await ui.find({ type: 'Text', text: /^CPU/ }))?.text).toBe('CPU 27%')
  await clock.advance(1_000)
  expect((await ui.find({ type: 'Text', text: /^CPU/ }))?.text).toBe('CPU 50%')
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
