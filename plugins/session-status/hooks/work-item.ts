import type { SessionStatusBlocker } from '../types'

const ORGANIZATION = 'https://dev.azure.com/propato'
const PREDECESSOR = 'System.LinkTypes.Dependency-Reverse'
const DONE_STATES = new Set(['closed', 'done', 'resolved', 'removed', 'completed'])
const TRAILING_ID = /\/workItems\/(\d+)$/i

// A blocked check reads the work item at most this often, and at most this many predecessors each time.
export const BLOCKED_INTERVAL_MS = 5 * 60_000
export const MAX_PREDECESSORS = 5

// Read-only, like azArgv, plus the work item's links. cmd /c re-parses its arguments: only a numeric id gets in.
export const workItemArgv = (workItem: string) => {
  if (!/^\d+$/.test(workItem)) throw new Error(`invalid work item id: ${workItem}`)
  return [
    'cmd', '/d', '/s', '/c', 'az', 'boards', 'work-item', 'show',
    '--id', workItem,
    '--organization', ORGANIZATION,
    '--expand', 'relations',
    '-o', 'json',
  ]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

// The title and the ids of the Predecessor links; undefined when the output is not a work item.
export const parseWorkItem = (stdout: string): { title?: string; predecessors: string[] } | undefined => {
  let item: unknown
  try {
    item = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!isRecord(item) || !isRecord(item.fields)) return undefined
  const relations = Array.isArray(item.relations) ? item.relations : []
  const predecessors = relations.flatMap(relation => {
    if (!isRecord(relation) || relation.rel !== PREDECESSOR || typeof relation.url !== 'string') return []
    const id = TRAILING_ID.exec(relation.url)?.[1]
    return id ? [id] : []
  })
  const title = text(item.fields['System.Title'])
  return title ? { title, predecessors } : { predecessors }
}

// A predecessor's state and title from its `fields` JSON; undefined without a state.
export const parseBlocker = (id: string, stdout: string): SessionStatusBlocker | undefined => {
  try {
    const fields: unknown = JSON.parse(stdout)
    if (!isRecord(fields)) return undefined
    const state = text(fields['System.State'])
    return state ? { id, state, title: text(fields['System.Title']) ?? null } : undefined
  } catch {
    return undefined
  }
}

export const isDoneState = (state: string) => DONE_STATES.has(state.trim().toLowerCase())
