import { expect, test } from 'claude-code/testing'

const turn = (durationMs: number, extra: Record<string, unknown> = {}) => ({
  answer: 'ok',
  durationMs,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
  ...extra,
})

const capture = (on: any) => {
  const toasts: string[] = []
  const sounds: string[] = []
  on('ui.toast', (_$: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', (_$: unknown, e: { argv: readonly string[] }) => {
    sounds.push(e.argv.join(' '))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.complete', () => ({ text: 'ok' }))
  return { toasts, sounds }
}

test('notifies when a long main-loop turn finishes', async ($, on) => {
  const { toasts, sounds } = capture(on)
  await $.turn.complete(turn(42_000))
  expect(toasts).toEqual(['Claude finished (42s)'])
  expect(sounds.length).toBe(1)
  expect(sounds[0]).toContain("'C:/Windows/Media/Windows Notify System Generic.wav'")
})

test('stays quiet for short, aborted or subagent turns', async ($, on) => {
  const { toasts, sounds } = capture(on)
  await $.turn.complete(turn(3_000))
  await $.turn.complete(turn(60_000, { reason: 'aborted', isAborted: true }))
  await $.turn.complete(turn(60_000, { agentId: 'sub-1' }))
  expect(toasts).toEqual([])
  expect(sounds).toEqual([])
})

test('notifies when a tool call needs permission', async ($, on) => {
  const { toasts } = capture(on)
  on('tool.check', () => ({ decision: 'ask' as const }))
  await $.tool.check({ tool: 'Bash', input: { command: 'git push' } } as any)
  expect(toasts).toEqual(['Claude needs your input (Bash)'])
})

test('notifies on AskUserQuestion even when allowed', async ($, on) => {
  const { toasts } = capture(on)
  on('tool.check', () => ({ decision: 'allow' as const }))
  await $.tool.check({ tool: 'AskUserQuestion', input: {} } as any)
  expect(toasts).toEqual(['Claude needs your input (AskUserQuestion)'])
})

test('stays quiet when a tool is allowed', async ($, on) => {
  const { toasts } = capture(on)
  on('tool.check', () => ({ decision: 'allow' as const }))
  await $.tool.check({ tool: 'Read', input: { file_path: 'x' } } as any)
  expect(toasts).toEqual([])
})
