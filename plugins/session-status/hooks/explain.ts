import type { SessionStatusPullRequest, SessionStatusSync } from '../types'

// The hover texts of the sync and PR segments, in one place: user-facing copy, in Spanish, for a git beginner.

const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`

export const explainSync = (sync: SessionStatusSync, branch: string) => {
  if (sync === 'local') return `Tu rama: existe solo en tu compu; el servidor no la conoce. Qué hacer: git push -u origin ${branch}`
  const { ahead, behind } = sync
  if (ahead > 0 && behind > 0)
    return (
      `Tu rama: se separó del servidor: ${ahead} tuyos sin subir y ${behind} del servidor sin bajar ` +
      '(según el último fetch). Qué hacer: git pull y después git push'
    )
  if (ahead > 0) return `Tu rama: tenés ${commits(ahead)} solo en tu compu; nadie más los ve. Qué hacer: git push`
  if (behind > 0)
    return `Tu rama: el servidor tiene ${commits(behind)} que vos no tenés (según el último fetch). Qué hacer: git pull`
  return 'Tu rama: está igual en tu compu y en el servidor. No hay nada para subir ni para bajar.'
}

export const explainPullRequest = ({ state, id, approved, reviewers }: Omit<SessionStatusPullRequest, 'branch'>) => {
  switch (state) {
    case 'none':
      return (
        'El PR: todavía no abriste un Pull Request para esta rama, así que nadie está revisando tu trabajo. ' +
        'Qué hacer: cuando termines y subas todo, abrilo en Azure DevOps.'
      )
    case 'draft':
      return `El PR: #${id} está en borrador; nadie tiene que revisarlo todavía. Qué hacer: cuando esté listo, tocá Publish en el PR.`
    case 'waiting':
      return (
        `El PR: #${id} espera revisión; aprobaron ${approved} de ${reviewers}. ` +
        'Qué hacer: esperá, o avisale a quien revisa si es urgente.'
      )
    case 'changes':
      return (
        `El PR: en #${id} pidieron cambios o lo rechazaron. ` +
        'Qué hacer: leé los comentarios, corregí, commiteá y hacé git push; el PR se actualiza solo.'
      )
    case 'approved':
      return `El PR: #${id} está aprobado (${approved} de ${reviewers}). Qué hacer: tocá Complete en el PR para mezclarlo.`
    case 'completed':
      return `El PR: #${id} ya se mezcló en la rama principal. Qué hacer: nada; podés pasar al próximo WI.`
    case 'abandoned':
      return `El PR: #${id} se cerró sin mezclar. Qué hacer: si fue un error, reactivalo desde Azure DevOps.`
  }
}
