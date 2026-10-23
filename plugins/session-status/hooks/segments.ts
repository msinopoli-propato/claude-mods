import type { Color } from 'claude-code'

import type {
  SessionStatusAgents,
  SessionStatusBranch,
  SessionStatusContext,
  SessionStatusHealth,
  SessionStatusRun,
} from '../types'
import { countAgents } from './agents'
import { healthColors } from './health'
import { formatHours } from './timer'
import { describeTitle } from './title'

// One pill: `color` is its background. `hover` is the text of a card revealed while the pointer is on it.
export type Segment = { text: string; color: Color; bold?: true; hover?: string }

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

const contextColor = (percent: number): Color =>
  percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success'

// One cell per 12.5%, clamped: a context past 100% (or a bogus negative) still draws 8 cells.
export const contextBar = (percent: number) => {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round(percent / (100 / BAR_CELLS))))
  return '▰'.repeat(filled) + '▱'.repeat(BAR_CELLS - filled)
}

const branchSegment = ({ name, isDirty }: SessionStatusBranch): Segment => {
  const text = `⎇ ${name}${isDirty ? '*' : ''}`
  if (PROTECTED_BRANCHES.has(name.toLowerCase())) return { text, color: 'error', bold: true }
  return { text, color: isDirty ? 'warning' : 'success' }
}

const agentsSegment = (data: BandData): Segment | undefined => {
  const { running, done, failed } = countAgents(data.agents)
  if (running + done + failed === 0) return undefined
  const text = `🤖 ${running} ▸ ${done} ✓${failed > 0 ? ` ${failed} ✗` : ''}`
  // Running wins the color: a failure only turns it red once nothing is left in flight.
  if (running > 0) return { text, color: 'warning', bold: true }
  return { text, color: failed > 0 ? 'error' : 'success' }
}

const workItemSegment = (data: BandData): Segment | undefined => {
  // WI is shown once, first: the active run's work item wins over the branch's; `WI ?` only for a run with neither.
  const workItem = data.run?.workItem ?? data.workItem
  if (!workItem) return data.run ? { text: 'WI ?', color: 'claude', bold: true } : undefined
  const hover = describeTitle(data.title ?? undefined, CARD_TITLE_LIMIT)
  return { text: `WI #${workItem}`, color: 'claude', bold: true, ...(hover ? { hover } : {}) }
}

const contextSegment = (context: SessionStatusContext | null): Segment | undefined => {
  if (context?.percent === null || context?.percent === undefined) return undefined
  const { percent, tokens } = context
  const hover = tokens === null ? {} : { hover: `${compact(tokens)} tokens` }
  return { text: `ctx ${contextBar(percent)} ${percent}%`, color: contextColor(percent), ...hover }
}

const healthSegments = (health: SessionStatusHealth | null): Segment[] => {
  if (!health) return []
  const colors = healthColors(health)
  const segments: Segment[] = [
    { text: `CPU ${health.cpu}%`, color: colors.cpu },
    { text: `RAM ${health.ram}%`, color: colors.ram },
  ]
  if (health.tempC !== null && colors.temp) segments.push({ text: `${health.tempC}°C`, color: colors.temp })
  return segments
}

const present = (segments: (Segment | undefined)[]) => segments.filter((s): s is Segment => s !== undefined)

export const buildBand = (data: BandData): Band => ({
  work: present([
    workItemSegment(data),
    data.branch ? branchSegment(data.branch) : undefined,
    data.run ? { text: `⏱ ${formatHours(data.run.activeMs)}h`, color: 'permission' } : undefined,
    agentsSegment(data),
  ]),
  gauges: [...present([contextSegment(data.context)]), ...healthSegments(data.health)],
})
