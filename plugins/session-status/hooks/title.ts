const ORGANIZATION = 'https://dev.azure.com/propato'
const DESCRIPTION_LIMIT = 40

export const AZ_TIMEOUT_MS = 15_000

export const titleKey = (workItem: string) => `wi-title:${workItem}`

// Read-only: `az boards work-item show`. On Windows `az` is az.cmd, so it goes through cmd; asking for the
// `fields` object as JSON (and picking System.Title in TS) avoids quoting a JMESPath string through cmd.
// cmd /c re-parses its arguments, so only a plain numeric id may ever reach it.
export const azArgv = (workItem: string) => {
  if (!/^\d+$/.test(workItem)) throw new Error(`invalid work item id: ${workItem}`)
  return [
  'cmd', '/d', '/s', '/c', 'az', 'boards', 'work-item', 'show',
  '--id', workItem,
  '--organization', ORGANIZATION,
  '--query', 'fields',
  '-o', 'json',
  ]
}

export const parseWorkItemTitle = (stdout: string): string | undefined => {
  try {
    const title = (JSON.parse(stdout) as Record<string, unknown> | null)?.['System.Title']
    return typeof title === 'string' && title.trim() !== '' ? title : undefined
  } catch {
    return undefined
  }
}

// Trim, collapse whitespace, cut to 40 characters (the last one an ellipsis).
export const describeTitle = (raw: string | undefined): string | undefined => {
  const text = raw?.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 1)}…` : text
}

export const composeTitle = (workItem: string, description: string | undefined, contextPercent: number | undefined) =>
  [`WI #${workItem}`, describeTitle(description), contextPercent === undefined ? undefined : `ctx ${contextPercent}%`]
    .filter(Boolean)
    .join(' · ')
