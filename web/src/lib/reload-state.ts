// A submission stays protected even if navigating unmounts its composer.
const pending = new Set<symbol>()
export function holdReload(): () => void {
  const token = Symbol()
  pending.add(token)
  return () => { pending.delete(token) }
}
export const reloadPending = () => pending.size > 0
