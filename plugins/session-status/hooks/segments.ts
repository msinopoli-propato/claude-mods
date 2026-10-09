import type { Color } from 'claude-code'

import type { SessionStatusBranch, SessionStatusContext, SessionStatusHealth, SessionStatusRun } from '../types'
import { healthColors } from './health'
import { formatHours } from './timer'

export type Segment = { text: string; color?: Color; bold?: true; dimColor?: true }

export type BandData = {
  branch: SessionStatusBranch | null
  workItem: string | null
  context: SessionStatusContext | null
  health: SessionStatusHealth | null
  run: SessionStatusRun | null
}

const PROTECTED_BRANCHES = new Set(['main', 'master', 'dev', 'desarrollo', 'uat'])

const compact = (tokens: number) =>
  tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)

const contextColor = (percent: number): Color =>
  percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success'

const branchSegment = ({ name, isDirty }: SessionStatusBranch): Segment => {
  const text = `⎇ ${name}${isDirty ? '*' : ''}`
  if (PROTECTED_BRANCHES.has(name.toLowerCase())) return { text, color: 'error', bold: true }
  return { text, color: isDirty ? 'warning' : 'success' }
}

export const buildSegments = (data: BandData): Segment[] => {
  const segments: Segment[] = []

  // WI is shown once, first: the active run's work item wins over the branch's; `WI ?` only for a run with neither.
  const workItem = data.run?.workItem ?? data.workItem
  if (workItem) segments.push({ text: `WI #${workItem}`, color: 'claude', bold: true })
  else if (data.run) segments.push({ text: 'WI ?', color: 'claude', bold: true })

  if (data.run) segments.push({ text: `⏱ ${formatHours(data.run.activeMs)}h`, color: 'permission' })

  if (data.branch) segments.push(branchSegment(data.branch))

  const percent = data.context?.percent
  if (percent !== null && percent !== undefined) {
    const tokens = data.context?.tokens
    const detail = tokens !== null && tokens !== undefined ? ` (${compact(tokens)})` : ''
    segments.push({ text: `ctx ${percent}%${detail}`, color: contextColor(percent) })
  }

  if (data.health) {
    const colors = healthColors(data.health)
    segments.push({ text: `CPU ${data.health.cpu}%`, color: colors.cpu })
    segments.push({ text: `RAM ${data.health.ram}%`, color: colors.ram })
    if (data.health.tempC !== null) segments.push({ text: `${data.health.tempC}°C`, color: colors.temp })
  }

  return segments
}
