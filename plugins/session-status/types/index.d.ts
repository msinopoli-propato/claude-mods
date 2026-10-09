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

/**
 * One measured prosuite-comandos run. `activeMs` only grows by the gaps between
 * consecutive activity events that are at most ten minutes long.
 */
export type SessionStatusRun = {
  /** Work item number, or null when neither the args nor the branch name one. */
  workItem: string | null
  /** Epoch ms, as `$.clock.now()` reports it. */
  startedAt: number
  /** Epoch ms of the last activity event of the run. */
  lastEventAt: number
  /** Active time accumulated so far, in milliseconds. */
  activeMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-status': {
      branch: SessionStatusBranch | null
      workItem: string | null
      context: SessionStatusContext | null
      agents: SessionStatusAgents
      health: SessionStatusHealth | null
      run: SessionStatusRun | null
    }
  }
}
