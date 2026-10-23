import type { SessionStatusStep, SessionStatusStepWord } from '../types'

const COMMAND = /^\/prosuite-comandos:(\S+)/

// Where each prosuite command sits on the road refine → código → review → prueba → merge.
const STEPS: ReadonlyMap<string, SessionStatusStepWord> = new Map<string, SessionStatusStepWord>([
  ['refine-item-perf', 'refine'],
  ['work-item-std', 'código'],
  ['work-item-tdd', 'código'],
  ['work-item-jueces', 'código'],
  ['work-item-tdd-jueces', 'código'],
  ['work-item-vivo', 'código'],
  ['code-review-jueces', 'review'],
  ['multi-code-review-jueces', 'review'],
  ['test-en-vivo', 'prueba'],
])

// The step a prompt's command puts the work item in; null for any other command or text.
export const stepFromCommand = (text: string): SessionStatusStep | null => {
  const command = COMMAND.exec(text.trimStart())?.[1]
  const word = command === undefined ? undefined : STEPS.get(command)
  return command && word ? { word, command } : null
}
