import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { SessionStatusBranch, SessionStatusContext, SessionStatusRun } from '../types'
import { HEALTH_ARGV, parseHealth } from './health'
import { buildSegments } from './segments'
import type { Segment } from './segments'
import {
  GAP_LIMIT_MS,
  formatDuration,
  formatHours,
  formatTimestamp,
  isProsuiteCommand,
  startRun,
  tick,
  workItemFromCommand,
  workItemLabel,
} from './timer'

// Branches follow feature/issue-{ID} or fix/issue-{ID}; worktrees follow <repo>-issue-{ID}.
const WORK_ITEM = /(?:^|[/-])issue-(\d+)(?:$|[/-])/i

export const findWorkItem = (...candidates: readonly string[]) => {
  for (const candidate of candidates) {
    const match = WORK_ITEM.exec(candidate)
    if (match) return match[1]
  }
  return undefined
}

// Everything the band draws lives in $.state so a hot reload keeps it and the render hook only reads.
const branch = atom({ plugin: 'session-status', key: 'branch' } as const, null)
const workItem = atom({ plugin: 'session-status', key: 'workItem' } as const, null)
const model = atom({ plugin: 'session-status', key: 'model' } as const, null)
const context = atom({ plugin: 'session-status', key: 'context' } as const, null)
const health = atom({ plugin: 'session-status', key: 'health' } as const, null)
const run = atom({ plugin: 'session-status', key: 'run' } as const, null)

const SECTION_ID = 'session-status:wi-time'

const git = async ($: Engine, args: readonly string[]) => {
  const { exitCode, stdout } = await $.process.run(['git', ...args], { timeoutMs: 5000 })
  return exitCode === 0 ? stdout.trim() : undefined
}

const readBranch = async ($: Engine): Promise<SessionStatusBranch | undefined> => {
  const name = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!name) return undefined
  const changes = await git($, ['status', '--porcelain'])
  return { name, isDirty: Boolean(changes) }
}

const detectWorkItem = (name: string | undefined, cwd: string) =>
  findWorkItem(name ?? '', cwd.replaceAll('\\', '/'))

const refresh = async ($: Engine) => {
  const [current, cwd, modelName, usage] = await Promise.all([
    readBranch($).catch(() => undefined),
    $.session.cwd(),
    $.session.model(),
    $.session.usage(),
  ])

  const { percent, tokens } = usage.context
  const ctx: SessionStatusContext | null =
    percent === undefined ? null : { percent, tokens: tokens ?? null }

  await Promise.all([
    update($, branch, () => current ?? null),
    update($, workItem, () => detectWorkItem(current?.name, cwd) ?? null),
    update($, model, () => modelName),
    update($, context, () => ctx),
  ])
}

// The work item a command run belongs to: its args first, then the branch or worktree.
const resolveRunWorkItem = async ($: Engine, text: string) => {
  const fromArgs = workItemFromCommand(text)
  if (fromArgs) return fromArgs
  try {
    const [current, cwd] = await Promise.all([readBranch($).catch(() => undefined), $.session.cwd()])
    return detectWorkItem(current?.name, cwd)
  } catch {
    return undefined
  }
}

const recordActivity = async ($: Engine) => {
  const now = await $.clock.now()
  await update($, run, (current: SessionStatusRun | null) => (current ? tick(current, now) : current))
}

const describeRun = (current: SessionStatusRun) =>
  `${workItemLabel(current)} · active ${formatDuration(current.activeMs)} (${formatHours(current.activeMs)}h)` +
  ` · run started ${formatTimestamp(current.startedAt)}`

const HEALTH_INTERVAL_MS = 20_000
const HEALTH_TIMEOUT_MS = 10_000

// Guards against overlapping reads; a hot reload resets it, at worst allowing one extra read.
let isReadingHealth = false

// The read takes ~3s, so it runs off the timer only: never in a render hook or a gating chain.
const readHealth = async ($: Engine) => {
  if (isReadingHealth) return
  isReadingHealth = true
  try {
    const { exitCode, stdout } = await $.process.run(HEALTH_ARGV, { timeoutMs: HEALTH_TIMEOUT_MS })
    const sample = exitCode === 0 ? parseHealth(stdout) : null
    await update($, health, () => sample)
  } catch {
    await update($, health, () => null).catch(() => undefined)
  } finally {
    isReadingHealth = false
  }
}

export const register: Register = on => {
  let healthTimer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command
      .register({ name: 'wi-time', description: 'Show the active time measured for the current prosuite-comandos run' })
      .catch(() => undefined)
    healthTimer?.cancel()
    healthTimer = $.clock.every(HEALTH_INTERVAL_MS, () => void readHealth($))
    void readHealth($)
    await refresh($).catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    healthTimer?.cancel()
    healthTimer = undefined
    await update($, run, () => null)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (isProsuiteCommand(e.text)) {
      const [now, item] = await Promise.all([$.clock.now(), resolveRunWorkItem($, e.text)])
      await update($, run, () => startRun(item, now))
    } else {
      await recordActivity($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    await recordActivity($)
    const result = await next(e)
    // A long tool run is active time too: mark its end so it is not mistaken for silence.
    await recordActivity($)
    if (e.tool === 'Bash') await refresh($).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await recordActivity($)
      await refresh($).catch(() => undefined)
    }
    return result
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const current = await read($, run)
    if (!current) return composed

    const subject = current.workItem ? `WI ${current.workItem}` : 'the current work item (work item unknown)'
    const text =
      `Measured active time for ${subject} in the current prosuite-comandos run: ` +
      `${formatHours(current.activeMs)}h (gaps over ${GAP_LIMIT_MS / 60_000} minutes excluded). ` +
      'Use this measured value for CompletedWork instead of estimating.'
    return { sections: [...composed.sections, { id: SECTION_ID, text, scope: 'session' as const }] }
  })

  on('command.run', { command: 'wi-time' }, async $ => {
    const current = await read($, run)
    return { text: current ? describeRun(current) : 'No prosuite-comandos run is active.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const segments = buildSegments({
      branch: await read($, branch),
      workItem: await read($, workItem),
      model: await read($, model),
      context: await read($, context),
      health: await read($, health),
      run: await read($, run),
    })
    if (segments.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const drawn = segments.flatMap((segment: Segment, index: number) => {
      const { text, ...style } = segment
      const part = <Text {...style}>{text}</Text>
      return index === 0 ? [part] : [<Text dimColor>{' · '}</Text>, part]
    })

    return <Box>{drawn}</Box>
  })
}
