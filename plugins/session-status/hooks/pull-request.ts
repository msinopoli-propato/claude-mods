import type { SessionStatusPullRequest } from '../types'

export const PR_TIMEOUT_MS = 20_000
export const PR_INTERVAL_MS = 120_000

export type AzureRepo = { org: string; project: string; repo: string }

// Any `user[:token]@` is matched but never captured.
const REMOTE_FORMS = [
  /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)$/i,
  /^https:\/\/(?:[^@/]+@)?([^./@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+)$/i,
  /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/i,
]

export const parseAzureRemote = (url: string): AzureRepo | undefined => {
  const match = REMOTE_FORMS.map(form => form.exec(url.trim())).find(Boolean)
  if (!match) return undefined
  try {
    const [org, project, repo] = [match[1], match[2], match[3]].map(part => decodeURIComponent(part ?? ''))
    return org && project && repo ? { org, project, repo } : undefined
  } catch {
    return undefined
  }
}

// cmd /c re-parses its arguments, so only these characters may reach the argv.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/
const SAFE_PROJECT = /^[A-Za-z0-9._ -]+$/
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/

// A leading hyphen would make a value read as an az option.
const isSafe = (value: string, whitelist: RegExp) =>
  whitelist.test(value) && !value.includes('..') && !value.startsWith('-')

// Read-only; undefined when any value falls outside its whitelist.
export const prArgv = ({ org, project, repo, branch }: AzureRepo & { branch: string }): readonly string[] | undefined => {
  const isValid = isSafe(org, SAFE_NAME) && isSafe(project, SAFE_PROJECT) && isSafe(repo, SAFE_NAME) && isSafe(branch, SAFE_BRANCH)
  if (!isValid) return undefined
  return [
    'cmd', '/d', '/s', '/c', 'az', 'repos', 'pr', 'list', '--detect', 'false',
    '--organization', `https://dev.azure.com/${org}`, '--project', project, '--repository', repo,
    '--source-branch', branch, '--status', 'all', '--top', '20', '-o', 'json',
  ]
}

export type PullRequestSummary = Omit<SessionStatusPullRequest, 'branch'>

type Reviewer = { vote: number; isContainer: boolean }

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

const reviewersOf = (pr: Record<string, unknown>): Reviewer[] =>
  (Array.isArray(pr['reviewers']) ? pr['reviewers'] : []).flatMap(item => {
    const reviewer = record(item)
    return reviewer ? [{ vote: Number(reviewer['vote']) || 0, isContainer: reviewer['isContainer'] === true }] : []
  })

const summarize = (pr: Record<string, unknown>): PullRequestSummary => {
  const id = typeof pr['pullRequestId'] === 'number' ? pr['pullRequestId'] : null
  const all = reviewersOf(pr)
  // Group reviewers (teams) only mirror their members: people decide approval.
  const people = all.filter(r => !r.isContainer)
  const approved = people.filter(r => r.vote >= 5).length
  const counts = { id, approved, reviewers: people.length }
  if (pr['status'] === 'completed') return { state: 'completed', ...counts }
  if (pr['status'] === 'abandoned') return { state: 'abandoned', ...counts }
  if (pr['isDraft'] === true) return { state: 'draft', ...counts }
  // -10 rejected, -5 waiting for the author.
  if (all.some(r => r.vote === -10 || r.vote === -5)) return { state: 'changes', ...counts }
  if (people.length > 0 && approved === people.length) return { state: 'approved', ...counts }
  return { state: 'waiting', ...counts }
}

// The newest PR whose source is exactly this branch; undefined when the output is not a JSON array.
export const parsePullRequests = (stdout: string, branch: string): PullRequestSummary | undefined => {
  let list: unknown
  try {
    list = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!Array.isArray(list)) return undefined
  const ref = `refs/heads/${branch}`
  const created = (pr: Record<string, unknown>) => Date.parse(String(pr['creationDate'])) || 0
  const newest = list
    .flatMap(item => {
      const pr = record(item)
      return pr && pr['sourceRefName'] === ref ? [pr] : []
    })
    .sort((a, b) => created(b) - created(a))[0]
  return newest ? summarize(newest) : { state: 'none', id: null, approved: 0, reviewers: 0 }
}
