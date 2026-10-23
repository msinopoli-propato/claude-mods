import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { SessionStatusBranch, SessionStatusContext, SessionStatusRun, SessionStatusSync } from '../types'
import { markEnded, mergeList, seedAgent } from './agents'
import { HEALTH_ARGV, parseHealth } from './health'
import { MACCHIATO, ROLE_COLORS } from './palette'
import { PR_INTERVAL_MS, PR_TIMEOUT_MS, TRUSTED_CWD, parseAzureRemote, parsePullRequests, prArgv } from './pull-request'
import { buildBand } from './segments'
import { rowAlt, svgRow } from './svg-band'
import { SYNC_ARGS, parseSync } from './sync'
import { SEGMENT_GAP, cardLeft, segmentRuns } from './text-band'
import { AZ_TIMEOUT_MS, azArgv, composeTitle, parseWorkItemTitle, titleKey } from './title'
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
const context = atom({ plugin: 'session-status', key: 'context' } as const, null)
const agents = atom({ plugin: 'session-status', key: 'agents' } as const, {})
const health = atom({ plugin: 'session-status', key: 'health' } as const, null)
const run = atom({ plugin: 'session-status', key: 'run' } as const, null)
const sync = atom({ plugin: 'session-status', key: 'sync' } as const, null)
const pr = atom({ plugin: 'session-status', key: 'pr' } as const, null)

const SECTION_ID = 'session-status:wi-time'

// The surfaces whose element table has Svg (the engine's Elements). Not `'Svg' in table`: a handed-out table is
// completed with every element name, a missing one drawing as a fragment, so the terminal's Svg draws nothing.
const SVG_SURFACES: ReadonlySet<string> = new Set(['desktop', 'vscode', 'mobile'])

const GIT_TIMEOUT_MS = 5000

const git = async ($: Engine, args: readonly string[]) => {
  const { exitCode, stdout } = await $.process.run(['git', ...args], { timeoutMs: GIT_TIMEOUT_MS })
  return exitCode === 0 ? stdout.trim() : undefined
}

const readBranch = async ($: Engine): Promise<SessionStatusBranch | undefined> => {
  const name = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!name) return undefined
  const changes = await git($, ['status', '--porcelain'])
  return { name, isDirty: Boolean(changes) }
}

// Ahead/behind from local refs. Called only once the branch read succeeded, so a failing rev-list means
// no upstream. A detached HEAD has no sync to show.
const readSync = async ($: Engine, name: string, cwd: string): Promise<SessionStatusSync | null> => {
  if (name === 'HEAD') return null
  try {
    const { exitCode, stdout } = await $.process.run(['git', ...SYNC_ARGS], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return exitCode === 0 ? (parseSync(stdout) ?? null) : 'local'
  } catch {
    return null
  }
}

const detectWorkItem = (name: string | undefined, cwd: string) =>
  findWorkItem(name ?? '', cwd.replaceAll('\\', '/'))

const refresh = async ($: Engine) => {
  const [current, cwd, usage] = await Promise.all([
    readBranch($).catch(() => undefined),
    $.session.cwd(),
    $.session.usage(),
  ])

  const { percent, tokens } = usage.context
  const ctx: SessionStatusContext | null =
    percent === undefined ? null : { percent, tokens: tokens ?? null }
  const [previous, currentSync] = await Promise.all([
    read($, branch),
    current ? readSync($, current.name, cwd) : null,
  ])

  await Promise.all([
    update($, branch, () => current ?? null),
    update($, sync, () => currentSync),
    update($, workItem, () => detectWorkItem(current?.name, cwd) ?? null),
    update($, context, () => ctx),
  ])
  // A new branch gets its PR read right away, off the hook chain that refreshed it.
  if (current && current.name !== previous?.name) $.clock.after(0, () => void readPullRequest($))
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

// Work item titles: fetched once per work item from Azure DevOps (read-only) and kept in $.store.
// Fetches run off a timer, never inside a hook chain; attempts are counted per session.
const titleFetches = new Set<string>()
const titleAttempts = new Map<string, number>()
const MAX_TITLE_ATTEMPTS = 2 // the first try plus one retry

const fetchWorkItemTitle = async ($: Engine, id: string) => {
  const attempts = titleAttempts.get(id) ?? 0
  if (titleFetches.has(id) || attempts >= MAX_TITLE_ATTEMPTS) return
  titleFetches.add(id)
  titleAttempts.set(id, attempts + 1)
  try {
    const { exitCode, stdout } = await $.process.run(azArgv(id), { timeoutMs: AZ_TIMEOUT_MS })
    const title = exitCode === 0 ? parseWorkItemTitle(stdout) : undefined
    if (title) await $.store.set(titleKey(id), title)
  } catch {
    // Not logged in, offline, az missing: silent, nothing cached.
  } finally {
    titleFetches.delete(id)
  }
}

// The session title for the current work item, or undefined to leave the engine's own. Never awaits az.
const buildSessionTitle = async ($: Engine): Promise<string | undefined> => {
  const [current, branchItem] = await Promise.all([read($, run), read($, workItem)])
  const id = current?.workItem ?? branchItem
  if (!id) return undefined

  const cached = await $.store.get(titleKey(id))
  if (typeof cached !== 'string') $.clock.after(0, () => void fetchWorkItemTitle($, id))

  const usage = await $.session.usage().catch(() => undefined)
  return composeTitle(id, typeof cached === 'string' ? cached : undefined, usage?.context.percent)
}

// The band's hover card: only what is already cached. A render never starts an az fetch; the session title does.
const readCachedTitle = async ($: Engine, id: string | null | undefined) => {
  if (!id) return null
  const cached = await $.store.get(titleKey(id)).catch(() => undefined)
  return typeof cached === 'string' ? cached : null
}

// The branch's Azure DevOps PR (read-only), off the timer or a clock.after only: never in a hook chain or a
// render. One read at a time, at most once per PR_INTERVAL_MS per branch; a hot reload resets both guards.
let isReadingPr = false
const prReads = new Map<string, number>()

async function readPullRequest($: Engine) {
  if (isReadingPr) return
  isReadingPr = true
  try {
    const name = (await read($, branch))?.name
    if (!name || name === 'HEAD') return
    const now = await $.clock.now()
    const last = prReads.get(name)
    if (last !== undefined && now - last < PR_INTERVAL_MS) return
    prReads.set(name, now)

    const cwd = await $.session.cwd()
    // Only Azure DevOps repos have a PR to show; GitHub and the rest show no segment.
    const remote = await $.process.run(['git', 'remote', 'get-url', 'origin'], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    const repo = remote.exitCode === 0 ? parseAzureRemote(remote.stdout) : undefined
    const argv = repo && prArgv({ ...repo, branch: name })
    if (!argv) return

    const { exitCode, stdout } = await $.process.run(argv, { cwd: TRUSTED_CWD, timeoutMs: PR_TIMEOUT_MS })
    const summary = exitCode === 0 ? parsePullRequests(stdout, name) : undefined
    if (summary) await update($, pr, () => ({ branch: name, ...summary }))
  } catch {
    // Not logged in, offline, az missing: silent, the last value stays.
  } finally {
    isReadingPr = false
  }
}

// Merges the engine's agent list into the session tally; callers never let a failure reach a turn or tool call.
// Serialized: a request that arrives while a read is in flight waits for it plus one fresh rerun, so a stale
// list can never overwrite a newer one.
let agentSync: Promise<void> | undefined
let isAgentSyncRequested = false

const syncAgents = ($: Engine): Promise<void> => {
  if (agentSync) {
    isAgentSyncRequested = true
    return agentSync
  }
  agentSync = (async () => {
    try {
      do {
        isAgentSyncRequested = false
        const list = await $.agent.list()
        await update($, agents, tally => mergeList(tally, list))
      } while (isAgentSyncRequested)
    } finally {
      agentSync = undefined
    }
  })()
  return agentSync
}

// One timer period: every read runs off the timer, never inside a hook chain.
const poll = async ($: Engine) => {
  await Promise.all([readHealth($), syncAgents($).catch(() => undefined), readPullRequest($)])
}

export const register: Register = on => {
  let healthTimer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command
      .register({ name: 'wi-time', description: 'Show the active time measured for the current prosuite-comandos run' })
      .catch(() => undefined)
    healthTimer?.cancel()
    healthTimer = $.clock.every(HEALTH_INTERVAL_MS, () => void poll($))
    void poll($)
    await refresh($).catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    healthTimer?.cancel()
    healthTimer = undefined
    await update($, run, () => null)
    await update($, agents, () => ({}))
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

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    const sessionTitle = await buildSessionTitle($).catch(() => undefined)
    return sessionTitle ? { ...result, sessionTitle } : result
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    const sessionTitle = await buildSessionTitle($).catch(() => undefined)
    return sessionTitle ? { ...result, sessionTitle } : result
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    // A just-spawned agent may not be listed yet: seed it so it is counted, not yet "seen in the list".
    const spawned = result.agentId
    if (spawned) await update($, agents, tally => seedAgent(tally, spawned)).catch(() => undefined)
    await syncAgents($).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await syncAgents($).catch(() => undefined)
    if (e.agentId !== undefined) {
      const { agentId, reason } = e
      await update($, agents, tally => markEnded(tally, agentId, reason)).catch(() => undefined)
    } else {
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

    const [currentBranch, branchItem, currentContext, currentAgents, currentHealth, currentRun, currentSync, currentPr] =
      await Promise.all([
        read($, branch),
        read($, workItem),
        read($, context),
        read($, agents),
        read($, health),
        read($, run),
        read($, sync),
        read($, pr),
      ])
    const band = buildBand({
      branch: currentBranch,
      workItem: branchItem,
      title: await readCachedTitle($, currentRun?.workItem ?? branchItem),
      context: currentContext,
      agents: currentAgents,
      health: currentHealth,
      run: currentRun,
      sync: currentSync,
      pr: currentPr,
    })
    // One row: the work segments, then the gauges.
    const rows = [[...band.work, ...band.gauges]].filter(row => row.length > 0)
    if (rows.length === 0) return next(e)

    const elements = $.ui.resolve(e)
    const { Box, Text } = elements

    // Desktop, editor and mobile: one SVG per row, rounded and themed by the frame; its <title>s are the hovers.
    if (SVG_SURFACES.has(e.surface) && 'Svg' in elements) {
      const { Svg } = elements
      return (
        <Box flexDirection="column">
          {rows.map((row, r) => {
            const { source, width, height } = svgRow(row)
            return <Svg key={`row-${r}`} source={source} alt={rowAlt(row)} width={width} height={height} isInteractive />
          })}
        </Box>
      )
    }

    // The terminal: the same dots as text. Role colors stay Macchiato (no theme key has these hues); the icon
    // and a plain value use the terminal's own dim and text colors, so they follow its light or dark theme.
    const drawSegment = (segment: Segment, key: string) => {
      const color = ROLE_COLORS[segment.role]
      const runs = segmentRuns(segment)
      const isAlert = segment.role === 'warning' || segment.role === 'error'
      // Every segment is a keyed Box (the hover scope). A hover card is hidden and absolute, opening on the same
      // row right after the segment and its gap: the band clips what lies outside it. Painting over moves nothing.
      return (
        <Box key={key}>
          <Text color={color}>{runs.dot}</Text>
          <Text dimColor>{runs.icon}</Text>
          {runs.bar ? <Text color={color}>{runs.bar}</Text> : null}
          <Text {...(isAlert ? { color } : {})} {...(segment.bold ? { bold: true } : {})}>{runs.value}</Text>
          {segment.hover ? (
            <Box position="absolute" top={0} left={cardLeft(segment)} display="none" hover={{ display: 'flex' }}>
              <Text color={MACCHIATO.base} backgroundColor={color}>{` ${segment.hover} `}</Text>
            </Box>
          ) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {rows.map((row, r) => (
          <Box key={`row-${r}`} gap={SEGMENT_GAP}>
            {row.map((segment, index) => drawSegment(segment, `seg-${r}-${index}`))}
          </Box>
        ))}
      </Box>
    )
  })
}
