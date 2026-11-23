export type Draft = { value: string; revision: number }
export const editDraft = (draft: Draft, value: string): Draft => ({ value, revision: draft.revision + 1 })
export const submittedDraftIsCurrent = (draft: Draft, submitted: Draft) => draft.revision === submitted.revision
export const remainingAttachments = <T extends { id: string }>(current: T[], submitted: { id: string }[]) => {
  const sent = new Set(submitted.map(file => file.id))
  return current.filter(file => !sent.has(file.id))
}
