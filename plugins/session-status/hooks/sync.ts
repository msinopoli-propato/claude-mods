import type { SessionStatusSync } from '../types'

// Local refs only: never `git fetch` (network, credential prompts), so behind is as fresh as the last fetch.
export const SYNC_ARGS = ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'] as const

// `behind<TAB>ahead`: the left side is the upstream, the right side HEAD.
export const parseSync = (stdout: string): Exclude<SessionStatusSync, 'local'> | undefined => {
  const match = /^(\d+)\s+(\d+)$/.exec(stdout.trim())
  if (!match) return undefined
  return { ahead: Number(match[2]), behind: Number(match[1]) }
}
