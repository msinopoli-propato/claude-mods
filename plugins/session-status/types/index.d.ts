/** Git facts shown in the band; null outside a git repository. */
export type SessionStatusBranch = { name: string; isDirty: boolean }

/** Context window usage; both fields are null when the engine has no reading. */
export type SessionStatusContext = { percent: number | null; tokens: number | null }

/** PC health sample: percentages, and the CPU temperature in Celsius when the machine reports one. */
export type SessionStatusHealth = { cpu: number; ram: number; tempC: number | null }

/** An agent's last known status, as `$.agent.list()` spells it. */
export type SessionStatusAgentStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

/**
 * Every agent known this session by id; kept after the engine drops finished ones from its list.
 * `seen` is true once a `$.agent.list()` read has named the agent (a just-spawned one is not listed yet).
 */
export type SessionStatusAgents = Record<string, { status: SessionStatusAgentStatus; seen: boolean }>

/** Where a work item is on the road refine → código → review → prueba → merge. */
export type SessionStatusStepWord = 'refine' | 'código' | 'review' | 'prueba'

/** The step a prosuite command puts the work item in, and the command (its name after `/prosuite-comandos:`). */
export type SessionStatusStep = { word: SessionStatusStepWord; command: string }

/**
 * One measured prosuite-comandos run. `activeMs` only grows by the gaps between
 * consecutive activity events that are at most ten minutes long.
 */
export type SessionStatusRun = {
  /** Work item number, or null when neither the args nor the branch name one. */
  workItem: string | null
  /** The step the run's command stands for; null for a command with none. Missing on runs from before 0.11. */
  step?: SessionStatusStep | null
  /** Epoch ms, as `$.clock.now()` reports it. */
  startedAt: number
  /** Epoch ms of the last activity event of the run. */
  lastEventAt: number
  /** Active time accumulated so far, in milliseconds. */
  activeMs: number
}

/**
 * How the branch stands against its upstream, from local refs only (as fresh as the last fetch);
 * `'local'` when it has no upstream yet.
 */
export type SessionStatusSync = { ahead: number; behind: number } | 'local'

/** The pull request state shown in the band. */
export type SessionStatusPullRequestState =
  | 'none'
  | 'draft'
  | 'waiting'
  | 'changes'
  | 'approved'
  | 'completed'
  | 'abandoned'

/**
 * The newest Azure DevOps pull request of `branch`, as last read. `approved` counts person reviewers
 * voting 5 or 10, `reviewers` every person reviewer (groups left out); `id` is null for `none`.
 */
export type SessionStatusPullRequest = {
  branch: string
  state: SessionStatusPullRequestState
  id: number | null
  approved: number
  reviewers: number
}

/** A predecessor work item as last read: its state and its title, when it has one. */
export type SessionStatusBlocker = { id: string; state: string; title: string | null }

/** The predecessors of `workItem` that are not done yet, as of the last successful check. */
export type SessionStatusBlocked = { workItem: string; by: SessionStatusBlocker[] }

declare module 'claude-code' {
  interface PluginState {
    'session-status': {
      branch: SessionStatusBranch | null
      workItem: string | null
      context: SessionStatusContext | null
      agents: SessionStatusAgents
      health: SessionStatusHealth | null
      run: SessionStatusRun | null
      sync: SessionStatusSync | null
      pr: SessionStatusPullRequest | null
      blocked: SessionStatusBlocked | null
    }
  }
}
