import type {
  SessionStatusAgents,
  SessionStatusBranch,
  SessionStatusContext,
  SessionStatusHealth,
  SessionStatusRun,
} from '../types'
import { countAgents } from './agents'
import { healthRoles } from './health'
import type { Role } from './palette'
import { formatHours } from './timer'
import { describeTitle } from './title'

// One split pill: a solid icon part and a soft value part, both colored by `role`. `bold` weighs the value;
// `hover` is the text of a card revealed while the pointer is on it.
export type Segment = { icon: string; value: string; role: Role; bold?: true; hover?: string }

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

const agentsSegment = (data: BandData): Segment | undefined => {
  const { running, done, failed } = countAgents(data.agents)
  if (running + done + failed === 0) return undefined
  const counts = { icon: '🤖', value: `${running} ▸ ${done} ✓${failed > 0 ? ` ${failed} ✗` : ''}` }
  // Running wins the color: a failure only turns it red once nothing is left in flight.
  if (running > 0) return { ...counts, role: 'warning', bold: true }
  return { ...counts, role: failed > 0 ? 'error' : 'ok' }
}

const workItemSegment = (data: BandData): Segment | undefined => {
  // WI is shown once, first: the active run's work item wins over the branch's; `WI ?` only for a run with neither.
  const workItem = data.run?.workItem ?? data.workItem
  if (!workItem) return data.run ? { icon: '◆', value: '?', role: 'workItem', bold: true } : undefined
  const hover = describeTitle(data.title ?? undefined, CARD_TITLE_LIMIT)
  return { icon: '◆', value: `#${workItem}`, role: 'workItem', bold: true, ...(hover ? { hover } : {}) }
}

const contextSegment = (context: SessionStatusContext | null): Segment | undefined => {
  if (context?.percent === null || context?.percent === undefined) return undefined
  const { percent, tokens } = context
  const hover = tokens === null ? {} : { hover: `${compact(tokens)} tokens` }
  return { icon: 'ctx', value: `${contextBar(percent)} ${percent}%`, role: contextRole(percent), ...hover }
}

const healthSegments = (health: SessionStatusHealth | null): Segment[] => {
  if (!health) return []
  const roles = healthRoles(health)
  const segments: Segment[] = [
    { icon: 'cpu', value: `${health.cpu}%`, role: roles.cpu },
    { icon: 'ram', value: `${health.ram}%`, role: roles.ram },
  ]
  if (health.tempC !== null && roles.temp) segments.push({ icon: 'temp', value: `${health.tempC}°C`, role: roles.temp })
  return segments
}

const present = (segments: (Segment | undefined)[]) => segments.filter((s): s is Segment => s !== undefined)

export const buildBand = (data: BandData): Band => ({
  work: present([
    workItemSegment(data),
    data.branch ? branchSegment(data.branch) : undefined,
    data.run ? { icon: '⏱', value: `${formatHours(data.run.activeMs)}h`, role: 'timer' } : undefined,
    agentsSegment(data),
  ]),
  gauges: [...present([contextSegment(data.context)]), ...healthSegments(data.health)],
})
