import type { FolioSheetFacts } from '../../../main/folio-version-sheet'
import type { SaveChoice } from './folio-version-save'

type FolioBasis = Readonly<{ kind: 'collection' | 'part'; path: string }>

// Each navigation has its own subject object, even when the path values match an earlier visit.
export type NameVersionSubject = Readonly<{ part: string | null; basis: FolioBasis | null }>

export type NameVersionQuestion = Readonly<{
  last: SaveChoice
  dir: string
  partName: string
  parts: number | null
}>

type VersionTarget =
  | { scope: 'part'; path: string | null }
  | { scope: 'folio'; dir: string }

type ChooserHost = {
  currentSubject: () => NameVersionSubject | null
  busy: () => boolean
  readDir: (basis: FolioBasis) => Promise<string | null>
  readLastChoice: () => Promise<SaveChoice>
  readFacts: (dir: string) => Promise<Pick<FolioSheetFacts, 'parts' | 'partList' | 'refused'>>
  openPartSheet: (path: string | null) => void
  showQuestion: (question: NameVersionQuestion) => void
}

type Request = {
  host: ChooserHost
  subject: NameVersionSubject
  question: NameVersionQuestion | null
}

export function createNameVersionChooser() {
  let current: Request | null = null
  const cancel = (): void => { current = null }
  const cancelPreparation = (): void => {
    if (current?.question === null) cancel()
  }
  const cancelQuestion = (question: NameVersionQuestion): void => {
    if (current?.question === question) cancel()
  }
  const isLive = (request: Request): boolean =>
    current === request && request.host.currentSubject() === request.subject && !request.host.busy()

  const request = async (host: ChooserHost): Promise<void> => {
    cancel()
    const subject = host.currentSubject()
    if (!subject || host.busy()) return

    const preparing: Request = { host, subject, question: null }
    current = preparing
    try {
      const dir = subject.basis === null ? null : await host.readDir(subject.basis).catch(() => null)
      if (!isLive(preparing)) return
      if (dir === null) {
        cancel()
        host.openPartSheet(subject.part)
        return
      }

      const last = await host.readLastChoice().catch((): SaveChoice => 'folio')
      if (!isLive(preparing)) return
      const facts = await host.readFacts(dir).catch(() => null)
      if (!isLive(preparing)) return

      const here = facts?.partList.find((entry) => entry.path === subject.part)
      preparing.question = {
        dir,
        last,
        partName: here ? `${here.order} ${here.title}` : '',
        parts: facts && facts.refused === undefined ? facts.parts : null,
      }
      host.showQuestion(preparing.question)
    } finally {
      // A stale read must never clear a newer request or touch the separate sheet's save gate.
      if (current === preparing && preparing.question === null) cancel()
    }
  }

  const take = (question: NameVersionQuestion, choice: SaveChoice): VersionTarget | null => {
    const offered = current
    if (offered?.question !== question) return null
    const live = isLive(offered)
    cancel()
    if (!live) return null
    return choice === 'part' ? { scope: 'part', path: offered.subject.part } : { scope: 'folio', dir: question.dir }
  }

  return {
    request, take, cancel, cancelPreparation, cancelQuestion,
    isOffered: (question: NameVersionQuestion): boolean => current?.question === question,
  }
}
