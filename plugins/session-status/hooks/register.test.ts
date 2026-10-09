import { expect, mock, test } from 'claude-code/testing'

import { parseHealth, healthColors } from './health'
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

type Segment = { text: string; color?: unknown; bold?: unknown; dimColor?: unknown }

const drawBand = async ($: any, surface: (typeof SURFACES)[number], props: object = BAND_PROPS) => {
  const ui = await $.ui.mount({ plugin: 'session-status', surface, component: 'AbovePrompt', props })
  const texts = await ui.findAll({ type: 'Text' })
  return texts.map((t: any): Segment => ({ text: t.text, ...t.props }))
}

const segmentsOf = (all: Segment[]) => all.filter(s => s.text !== ' · ')
const named = (all: Segment[], prefix: string) => segmentsOf(all).find(s => s.text.startsWith(prefix))!
const branchOf = (all: Segment[]) => segmentsOf(all).find(s => s.text.startsWith('⎇'))

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

    expect(all.map(s => s.text).join('')).toBe('WI #8423 · ⎇ feature/issue-8423* · ctx 42% (84k)')
    const [wi, branch, ctx] = segmentsOf(all)
    expect(branch.color).toBe('warning')
    expect(wi).toMatchObject({ color: 'claude', bold: true })
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
    const all = await drawBand($, surface)
    expect(all.map(s => s.text).join('')).toBe('WI #8423 · ⎇ feature/issue-8423 · ⏱ 1.3h · ctx 10%')
    expect(named(all, '⏱')).toMatchObject({ text: '⏱ 1.3h', color: 'permission' })
  })
}

test('an active run wins over the branch work item and WI is shown once', async ($, on) => {
  world(on, { branch: 'feature/issue-1111', percent: 10 })
  await $.prompt.submit({ text: '/prosuite-comandos:work-item 8423' })
  await $.turn.complete(turn())
  const all = await drawBand($, 'terminal')
  expect(all.map(s => s.text).join('')).toBe('WI #8423 · ⎇ feature/issue-1111 · ⏱ 0.0h · ctx 10%')
})

test('a run with unknown work item and no branch work item shows WI ?', async ($, on) => {
  world(on, { branch: 'desarrollo' })
  await $.prompt.submit({ text: '/prosuite-comandos:test-en-vivo' })
  await $.turn.complete(turn())
  const all = await drawBand($, 'terminal')
  expect(all.map(s => s.text).join('')).toBe('WI ? · ⎇ desarrollo · ⏱ 0.0h')
  expect(segmentsOf(all)[0]).toMatchObject({ color: 'claude', bold: true })
})

test('a run with unknown work item falls back to the branch work item', async ($, on) => {
  const w: World = { branch: 'desarrollo' }
  world(on, w)
  await $.prompt.submit({ text: '/prosuite-comandos:test-en-vivo' }) // unknown at start
  w.branch = 'feature/issue-77'
  await $.turn.complete(turn())
  const all = await drawBand($, 'terminal')
  expect(all.map(s => s.text).join('')).toBe('WI #77 · ⎇ feature/issue-77 · ⏱ 0.0h')
})

test('clean branch is green, protected branches are bold red even when clean', async ($, on) => {
  const w: World = { branch: 'feature/issue-5' }
  world(on, w)
  await $.turn.complete(turn())
  expect(branchOf(await drawBand($, 'terminal'))).toMatchObject({ text: '⎇ feature/issue-5', color: 'success' })

  for (const name of ['main', 'master', 'dev', 'desarrollo', 'UAT']) {
    w.branch = name
    await $.turn.complete(turn())
    expect(branchOf(await drawBand($, 'terminal'))).toMatchObject({ text: `⎇ ${name}`, color: 'error', bold: true })
  }
})

test('dirty protected branch stays red and shows the asterisk', async ($, on) => {
  world(on, { branch: 'main', porcelain: ' M a.cs\n' })
  await $.turn.complete(turn())
  expect(branchOf(await drawBand($, 'desktop'))).toMatchObject({ text: '⎇ main*', color: 'error', bold: true })
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
  expect(all.map(s => s.text).join('')).toBe('WI #912 · ⎇ desarrollo')
})

test('outside a git repo it shows only the work item, if any, and usage', async ($, on) => {
  world(on, { percent: 5 })
  await $.turn.complete(turn())
  const all = await drawBand($, 'desktop')
  expect(all.map(s => s.text).join('')).toBe('ctx 5%')
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
  const timer = segmentsOf(await drawBand($, 'terminal')).find(s => s.text.startsWith('⏱'))!
  expect(timer).toMatchObject({ text: '⏱ 0.0h', color: 'permission' })
})

test('hours are rounded down, never up', async ($, on) => {
  const { clock } = world(on, { branch: 'main' })
  await $.prompt.submit({ text: '/prosuite-comandos:work-item 8423' })
  for (let i = 0; i < 11; i++) {
    await clock.advance(9 * MINUTE) // 99 minutes in total: 1.65h
    await $.turn.complete(turn())
  }
  const timer = segmentsOf(await drawBand($, 'terminal')).find(s => s.text.startsWith('⏱'))!
  expect(timer.text).toBe('⏱ 1.6h')
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
  test(`band draws CPU, RAM and temperature after ctx on ${surface}`, async ($, on) => {
    const { clock } = world(on, { branch: 'feature/issue-8423', percent: 42, tokens: 84_200, health: SAMPLE })
    await start($, clock)
    await $.prompt.submit({ text: '/prosuite-comandos:work-item 8423' })
    const all = await drawBand($, surface)

    expect(all.map(s => s.text).join('')).toBe(
      'WI #8423 · ⎇ feature/issue-8423 · ⏱ 0.0h · ctx 42% (84k) · CPU 27% · RAM 75% · 62°C',
    )
    const [cpu, ram, temp] = ['CPU', 'RAM', '62'].map(prefix => named(all, prefix))
    expect([cpu.color, ram.color, temp.color]).toEqual(['success', 'warning', 'success'])
  })
}

test('colors reach the band per metric', async ($, on) => {
  const { clock } = world(on, { branch: 'x', health: '95|1000|4000|3700' })
  await start($, clock)
  const all = await drawBand($, 'terminal')
  const [cpu, ram, temp] = ['CPU', 'RAM', '97'].map(prefix => named(all, prefix))
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
  expect(texts).toBe('⎇ x · CPU 27% · RAM 75%')
})

test('a failing or unparsable read omits the whole segment', async ($, on) => {
  const failing = world(on, { branch: 'x' })
  await start($, failing.clock)
  expect((await drawBand($, 'terminal')).map(s => s.text).join('')).toBe('⎇ x')
})

test('unparsable stdout omits the segment too', async ($, on) => {
  const { clock } = world(on, { branch: 'x', health: 'garbage' })
  await start($, clock)
  expect((await drawBand($, 'desktop')).map(s => s.text).join('')).toBe('⎇ x')
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

// ---------------------------------------------------------------- subagents

const bandText = async ($: any, surface: (typeof SURFACES)[number] = 'terminal') =>
  (await drawBand($, surface)).map(s => s.text).join('')

for (const surface of SURFACES) {
  test(`subagents segment sits after the timer and before ctx on ${surface}`, async ($, on) => {
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
    await $.prompt.submit({ text: '/prosuite-comandos:work-item 8423' })
    await $.turn.complete(turn())
    const all = await drawBand($, surface)
    expect(all.map(s => s.text).join('')).toBe('WI #8423 · ⎇ feature/issue-8423 · ⏱ 0.0h · 🤖 2 running · 3 done · ctx 10%')

    const [running, done] = ['🤖', '3 done'].map(prefix => named(all, prefix))
    expect(running).toMatchObject({ color: 'warning', bold: true })
    expect(done.color).toBe('success')
  })
}

test('without a timer the segment follows the branch', async ($, on) => {
  world(on, { branch: 'feature/issue-8423', agents: [{ id: 'a', status: 'running' }] })
  await $.turn.complete(turn())
  expect(await bandText($)).toBe('WI #8423 · ⎇ feature/issue-8423 · 🤖 1 running · 0 done')
})

test('running is dim when nothing runs, and failed shows only when above zero', async ($, on) => {
  world(on, { branch: 'x', agents: [{ id: 'a', status: 'completed' }] })
  await $.turn.complete(turn())
  const all = await drawBand($, 'terminal')
  expect(all.map(s => s.text).join('')).toBe('⎇ x · 🤖 0 running · 1 done')
  const running = named(all, '🤖')
  expect(running.dimColor).toBe(true)
  expect(running.bold).toBe(undefined)
})

test('failed and killed agents land in the failed bucket', async ($, on) => {
  world(on, { branch: 'x', agents: [{ id: 'a', status: 'failed' }, { id: 'b', status: 'killed' }, { id: 'c', status: 'completed' }] })
  await $.turn.complete(turn())
  const all = await drawBand($, 'terminal')
  expect(all.map(s => s.text).join('')).toBe('⎇ x · 🤖 0 running · 1 done · 2 failed')
  expect(named(all, '2 failed')).toMatchObject({ text: '2 failed', color: 'error' })
})

test('idle teammates are neither running nor done', async ($, on) => {
  const w: World = { branch: 'x', agents: [{ id: 'a', status: 'idle' }] }
  world(on, w)
  await $.turn.complete(turn())
  expect(await bandText($)).toBe('⎇ x')

  w.agents = [{ id: 'a', status: 'idle' }, { id: 'b', status: 'running' }]
  await $.turn.complete(turn())
  expect(await bandText($)).toBe('⎇ x · 🤖 1 running · 0 done')
})

test('the tally survives the engine dropping finished agents', async ($, on) => {
  const w: World = {
    branch: 'x',
    agents: [{ id: 'a', status: 'completed' }, { id: 'b', status: 'failed' }, { id: 'c', status: 'running' }],
  }
  world(on, w)
  await $.turn.complete(turn())
  expect(await bandText($)).toBe('⎇ x · 🤖 1 running · 1 done · 1 failed')

  w.agents = [] // the engine forgot them all; c vanished while still active, so it counts as done
  await $.turn.complete(turn())
  expect(await bandText($)).toBe('⎇ x · 🤖 0 running · 2 done · 1 failed')
})

test('a subagent turn marks its own spawned agent by reason', async ($, on) => {
  const w: World = { branch: 'x', agents: [] }
  world(on, w)
  for (const id of ['s1', 's2', 's3']) {
    w.spawnId = id
    await $.agent.spawn({ prompt: 'work' })
  }
  expect(await bandText($)).toBe('🤖 3 running · 0 done')
  await $.turn.complete(turn({ agentId: 's1', reason: 'answer' }))
  await $.turn.complete(turn({ agentId: 's2', reason: 'error' }))
  await $.turn.complete(turn({ agentId: 's3', reason: 'aborted' }))
  expect(await bandText($)).toBe('🤖 0 running · 1 done · 2 failed')
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
  await $.agent.spawn({ prompt: 'work' })
  await $.turn.complete(turn()) // the list does not name it yet
  expect(await bandText($)).toBe('⎇ x · 🤖 1 running · 0 done')

  w.agents = [{ id: 'spawned-1', status: 'running' }] // now seen in the list...
  await $.turn.complete(turn())
  w.agents = [] // ...and then the engine drops it while it was still active
  await $.turn.complete(turn())
  expect(await bandText($)).toBe('⎇ x · 🤖 0 running · 1 done')
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
  expect(await bandText($)).toBe('⎇ x · 🤖 0 running · 1 done')
})

test('a subagent turn overrides a stale running status in the list', async ($, on) => {
  world(on, { branch: 'x', agents: [{ id: 's1', status: 'running' }] })
  await $.turn.complete(turn({ agentId: 's1', reason: 'answer' }))
  expect(await bandText($)).toBe('🤖 0 running · 1 done')
})

test('spawning an agent refreshes the tally', async ($, on) => {
  const w: World = { branch: 'x', agents: [] }
  world(on, w)
  w.agents = [{ id: 'spawned-1', status: 'running' }]
  await $.agent.spawn({ prompt: 'read the readme' })
  expect(await bandText($)).toBe('🤖 1 running · 0 done')
})

test('the 20 second tick refreshes the tally', async ($, on) => {
  const w: World = { branch: 'x', agents: [] }
  const { clock } = world(on, w)
  await start($, clock)
  expect(await bandText($)).toBe('⎇ x')
  w.agents = [{ id: 'a', status: 'running' }]
  await clock.advance(20_000)
  expect(await bandText($)).toBe('⎇ x · 🤖 1 running · 0 done')
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
  await $.prompt.submit({ text: '/prosuite-comandos:work-item 9001' })
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
