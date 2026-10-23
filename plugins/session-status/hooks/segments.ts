import type {
  SessionStatusAgents,
  SessionStatusBlocked,
  SessionStatusBranch,
  SessionStatusContext,
  SessionStatusHealth,
  SessionStatusPullRequest,
  SessionStatusRun,
  SessionStatusSync,
} from '../types'
import { countAgents } from './agents'
import { explainBlocked, explainPullRequest, explainStep, explainSync } from './explain'
import { healthRoles } from './health'
import type { Role } from './palette'
import { formatHours } from './timer'
import { describeTitle } from './title'

// One status dot: an icon (or short label) and a value, colored by `role`. `bold` weighs the value; `percent`
// makes it a gauge drawn with a bar; `word` spells the icon for a reader that cannot see it; `hover` is the
// text revealed while the pointer is on it.
export type Segment = {
  icon: string
  value: string
  role: Role
  bold?: true
  percent?: number
  word?: string
  hover?: string
}

// Row one is what is being worked on, row two how the session and the machine are holding up.
export type Band = { work: Segment[]; gauges: Segment[] }

export type BandData = {
  branch: SessionStatusBranch | null
  workItem: string | null
  // The cached work item title, if any; the band never fetches one.
  title: string | null
  context: SessionStatusContext | null
  agents: SessionStatusAgents
  health: SessionStatusHealth | null
  run: SessionStatusRun | null
  sync: SessionStatusSync | null
  // The last PR read; drawn only while it belongs to the current branch.
  pr: SessionStatusPullRequest | null
  // The last blocked check; drawn only while it belongs to the current work item.
  blocked: SessionStatusBlocked | null
}

const PROTECTED_BRANCHES = new Set(['main', 'master', 'dev', 'desarrollo', 'uat'])
const BAR_CELLS = 8
const CARD_TITLE_LIMIT = 60

const compact = (tokens: number) =>
  tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)

const contextRole = (percent: number): Role =>
  percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'ok'

// One cell per 12.5%, clamped: a context past 100% (or a bogus negative) still draws 8 cells.
export const contextBar = (percent: number) => {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round(percent / (100 / BAR_CELLS))))
  return '▰'.repeat(filled) + '▱'.repeat(BAR_CELLS - filled)
}

const branchSegment = ({ name, isDirty }: SessionStatusBranch): Segment => {
  const branch = { icon: '⎇', value: `${name}${isDirty ? '*' : ''}` }
  if (PROTECTED_BRANCHES.has(name.toLowerCase())) return { ...branch, role: 'error', bold: true }
  return { ...branch, role: isDirty ? 'warning' : 'branch' }
}

const syncValue = (sync: SessionStatusSync): Pick<Segment, 'value' | 'role'> => {
  if (sync === 'local') return { value: '↑ nueva', role: 'warning' }
  const { ahead, behind } = sync
  if (ahead > 0 && behind > 0) return { value: `↑${ahead} ↓${behind}`, role: 'error' }
  if (ahead > 0) return { value: `↑${ahead}`, role: 'warning' }
  if (behind > 0) return { value: `↓${behind}`, role: 'branch' }
  return { value: '✓', role: 'ok' }
}

const syncSegment = (data: BandData): Segment | undefined => {
  if (!data.branch || !data.sync) return undefined
  return { icon: '⇅', ...syncValue(data.sync), hover: explainSync(data.sync, data.branch.name) }
}

const prValue = ({ state, id, approved, reviewers }: SessionStatusPullRequest): Pick<Segment, 'value' | 'role'> => {
  switch (state) {
    case 'none':
      return { value: 'sin PR', role: 'muted' }
    case 'draft':
      return { value: `#${id} ✎`, role: 'muted' }
    case 'waiting':
      return { value: `#${id} ⏳ ${approved}/${reviewers}`, role: 'timer' }
    case 'changes':
      return { value: `#${id} ✗`, role: 'error' }
    case 'approved':
      return { value: `#${id} ✓ ${approved}/${reviewers}`, role: 'ok' }
    case 'completed':
      return { value: `#${id} ⛙`, role: 'workItem' }
    case 'abandoned':
      return { value: `#${id} ⊘`, role: 'muted' }
  }
}

const prSegment = ({ branch, pr }: BandData): Segment | undefined => {
  if (!branch || !pr || pr.branch !== branch.name) return undefined
  return { icon: 'PR', ...prValue(pr), hover: explainPullRequest(pr) }
}

const agentsSegment = (data: BandData): Segment | undefined => {
  const { running, done, failed } = countAgents(data.agents)
  if (running + done + failed === 0) return undefined
  const counts = { icon: '🤖', value: `${running} ▸ ${done} ✓${failed > 0 ? ` ${failed} ✗` : ''}` }
  // Running wins the color: a failure only turns it red once nothing is left in flight.
  if (running > 0) return { ...counts, role: 'warning', bold: true }
  return { ...counts, role: failed > 0 ? 'error' : 'ok' }
}

// The active run's work item wins over the branch's.
const currentWorkItem = (data: BandData) => data.run?.workItem ?? data.workItem

const workItemSegment = (data: BandData): Segment | undefined => {
  // WI is shown once, first; `WI ?` only for a run when neither the args nor the branch name one.
  const workItem = currentWorkItem(data)
  const mark = { icon: '◆', word: 'WI', role: 'workItem', bold: true } as const
  if (!workItem) return data.run ? { ...mark, value: '?' } : undefined
  const hover = describeTitle(data.title ?? undefined, CARD_TITLE_LIMIT)
  return { ...mark, value: `#${workItem}`, ...(hover ? { hover } : {}) }
}

// A lock checked for another work item says nothing about this one.
const blockedSegment = (data: BandData): Segment | undefined => {
  const [first, ...rest] = data.blocked?.by ?? []
  if (!first || data.blocked?.workItem !== currentWorkItem(data)) return undefined
  const title = describeTitle(first.title ?? undefined, CARD_TITLE_LIMIT) ?? null
  return {
    icon: '🔒',
    value: `#${first.id}${rest.length > 0 ? ` +${rest.length}` : ''}`,
    role: 'error',
    hover: explainBlocked([{ ...first, title }, ...rest]),
  }
}

const stepSegment = ({ run }: BandData): Segment | undefined =>
  run?.step ? { icon: '▶', value: run.step.word, role: 'workItem', hover: explainStep(run.step) } : undefined

const contextSegment = (context: SessionStatusContext | null): Segment | undefined => {
  if (context?.percent === null || context?.percent === undefined) return undefined
  const { percent, tokens } = context
  const hover = tokens === null ? {} : { hover: `${compact(tokens)} tokens` }
  return { icon: 'ctx', value: `${percent}%`, percent, role: contextRole(percent), ...hover }
}

const healthSegments = (health: SessionStatusHealth | null): Segment[] => {
  if (!health) return []
  const roles = healthRoles(health)
  const segments: Segment[] = [
    { icon: 'cpu', value: `${health.cpu}%`, percent: health.cpu, role: roles.cpu },
    { icon: 'ram', value: `${health.ram}%`, percent: health.ram, role: roles.ram },
  ]
  if (health.tempC !== null && roles.temp) segments.push({ icon: 'temp', value: `${health.tempC}°C`, role: roles.temp })
  return segments
}

const present = (segments: (Segment | undefined)[]) => segments.filter((s): s is Segment => s !== undefined)

export const buildBand = (data: BandData): Band => ({
  work: present([
    workItemSegment(data),
    blockedSegment(data),
    data.branch ? branchSegment(data.branch) : undefined,
    syncSegment(data),
    prSegment(data),
    stepSegment(data),
    data.run ? { icon: '⏱', value: `${formatHours(data.run.activeMs)}h`, role: 'timer' } : undefined,
    agentsSegment(data),
  ]),
  gauges: [...present([contextSegment(data.context)]), ...healthSegments(data.health)],
})
