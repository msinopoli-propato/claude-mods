import type { SessionStatusAgents, SessionStatusAgentStatus } from '../types'

// The engine drops finished subagents from $.agent.list() seconds after they end, so the mod keeps its own
// tally (id -> last known status) and never forgets an id once seen. An id enters the tally only from the
// list or from an agent.spawn result: other loops carry agent ids too (compaction and memory forks, workflow
// agents) that the list never names and that must not be counted.

const ACTIVE = new Set<SessionStatusAgentStatus>(['pending', 'running', 'waiting'])

type Listed = { id: string; status: SessionStatusAgentStatus }

// Takes the list as the truth for every agent it still shows. An agent that vanished while active counts as
// done, but only if a list read named it before: a freshly spawned one may just not be listed yet.
export const mergeList = (tally: SessionStatusAgents, list: readonly Listed[]): SessionStatusAgents => {
  const next: SessionStatusAgents = {}
  for (const [id, entry] of Object.entries(tally)) {
    next[id] = entry.seen && ACTIVE.has(entry.status) ? { status: 'completed', seen: true } : entry
  }
  for (const { id, status } of list) next[id] = { status, seen: true }
  return next
}

// Registers a spawned agent as running, not yet seen in any list; an id already tallied is left alone.
export const seedAgent = (tally: SessionStatusAgents, id: string): SessionStatusAgents =>
  id in tally ? tally : { ...tally, [id]: { status: 'running', seen: false } }

// A tallied agent's own turn ending says how it ended, whatever the list still shows. Unknown ids are ignored.
export const markEnded = (
  tally: SessionStatusAgents,
  id: string,
  reason: 'answer' | 'aborted' | 'refusal' | 'error',
): SessionStatusAgents => {
  const entry = tally[id]
  if (!entry) return tally
  const status = reason === 'answer' ? 'completed' : reason === 'aborted' ? 'killed' : 'failed'
  return { ...tally, [id]: { ...entry, status } }
}

// running = pending|running|waiting; done = completed; failed = failed|killed. Idle teammates count nowhere.
export const countAgents = (tally: SessionStatusAgents) => {
  const counts = { running: 0, done: 0, failed: 0 }
  for (const { status } of Object.values(tally)) {
    if (ACTIVE.has(status)) counts.running += 1
    else if (status === 'completed') counts.done += 1
    else if (status === 'failed' || status === 'killed') counts.failed += 1
  }
  return counts
}
