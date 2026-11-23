/** One shared import at a time, with failures cleared so a user can retry. */
export function retryableLoader<T>(importer: () => Promise<T>) {
  let value: T | null = null
  let error: unknown = null
  let pending: Promise<T> | null = null
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const load = (): Promise<T> => {
    if (value !== null) return Promise.resolve(value)
    if (pending) return pending
    error = null
    pending = Promise.resolve().then(importer).then(result => {
      value = result
      pending = null
      notify()
      return result
    }, reason => {
      pending = null
      error = reason
      notify()
      throw reason
    })
    notify()
    return pending
  }
  return {
    load,
    get: () => value,
    error: () => error,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
