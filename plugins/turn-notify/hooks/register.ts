import type { Engine, Register } from 'claude-code'

// Short turns are usually watched live; only longer ones warrant a nudge.
const MIN_TURN_MS = 10_000

const SOUNDS = {
  done: 'C:/Windows/Media/Windows Notify System Generic.wav',
  input: 'C:/Windows/Media/Windows Notify Messaging.wav',
}

// Tools that always stop and wait for the person, whatever the permission mode.
const WAITS_FOR_PERSON = new Set(['AskUserQuestion', 'ExitPlanMode'])

// Terminals on Windows have no clip player, so play through PowerShell instead of $.audio.
const play = ($: Engine, file: string) => {
  $.process
    .run([
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(New-Object Media.SoundPlayer '${file}').PlaySync()`,
    ])
    .catch(() => undefined)
}

const notify = ($: Engine, text: string, sound: string) => {
  $.ui.toast(text, { timeoutMs: 8000 })
  play($, sound)
}

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const isMainLoop = e.agentId === undefined

    if (isMainLoop && e.reason === 'answer' && e.durationMs >= MIN_TURN_MS) {
      notify($, `Claude finished (${Math.round(e.durationMs / 1000)}s)`, SOUNDS.done)
    }

    return result
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)

    if (verdict.decision === 'ask' || WAITS_FOR_PERSON.has(e.tool)) {
      notify($, `Claude needs your input (${e.tool})`, SOUNDS.input)
    }

    return verdict
  }).catch(($, e, next) => next(e))
}
