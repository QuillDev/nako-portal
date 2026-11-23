import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react"

/** Controlled props win; uncontrolled changes notify once after committing. */
export function useControllableState<T>({ prop, defaultProp, onChange }: {
  prop?: T
  defaultProp: T
  onChange?: (value: T) => void
}): [T, (next: SetStateAction<T>) => void] {
  const [state, setState] = useState(defaultProp)
  const previous = useRef(state)
  const change = useRef(onChange)
  useLayoutEffect(() => { change.current = onChange }, [onChange])
  useEffect(() => {
    if (!Object.is(previous.current, state)) {
      change.current?.(state)
      previous.current = state
    }
  }, [state])
  const controlled = prop !== undefined
  const set = useCallback((next: SetStateAction<T>) => {
    if (!controlled) return setState(next)
    const value = typeof next === "function" ? (next as (value: T) => T)(prop) : next
    if (!Object.is(value, prop)) change.current?.(value)
  }, [controlled, prop])
  return [controlled ? prop : state, set]
}
