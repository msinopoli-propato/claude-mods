import type { SessionStatusRun } from '../types'

// Any silence longer than this between two activity events is dead time and counts for nothing.
export const GAP_LIMIT_MS = 10 * 60 * 1000

const COMMAND_PREFIX = '/prosuite-comandos:'

// A standalone number of 2+ digits, optionally written as #1234.
const ARGS_WORK_ITEM = /(?:^|\s)#?(\d{2,})(?=\s|$)/

export const isProsuiteCommand = (text: string) => text.trimStart().startsWith(COMMAND_PREFIX)

const argsOf = (text: string) => {
  const trimmed = text.trim()
  const space = trimmed.search(/\s/)
  return space === -1 ? '' : trimmed.slice(space + 1)
}

export const workItemFromCommand = (text: string): string | undefined =>
  ARGS_WORK_ITEM.exec(argsOf(text))?.[1]

export const startRun = (workItem: string | undefined, now: number): SessionStatusRun => ({
  workItem: workItem ?? null,
  startedAt: now,
  lastEventAt: now,
  activeMs: 0,
})

// Registers an activity event: the interval since the previous one counts only when it is short enough.
export const tick = (run: SessionStatusRun, now: number): SessionStatusRun => {
  const gap = now - run.lastEventAt
  const isActive = gap >= 0 && gap <= GAP_LIMIT_MS
  return { ...run, activeMs: run.activeMs + (isActive ? gap : 0), lastEventAt: Math.max(now, run.lastEventAt) }
}

// Hours with one decimal, rounded DOWN so the figure never overstates the work done.
export const formatHours = (ms: number) => (Math.floor(ms / 360_000) / 10).toFixed(1)

export const formatDuration = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const pad = (n: number) => String(n).padStart(2, '0')

export const formatTimestamp = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const workItemLabel = (run: SessionStatusRun) => (run.workItem ? `WI #${run.workItem}` : 'WI ?')
