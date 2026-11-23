// Small hook scheduler for exercising the actual portal hook with deferred I/O.
// State, effect dependencies and cleanup run as they do across render/commit cycles.
export function hookHarness() {
  const slots = []
  let cursor = 0, dirty = false, component, output
  let effects = []
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const hooks = {
    useState(initial) {
      const index = cursor++
      if (!slots[index]) {
        const slot = { value: typeof initial === "function" ? initial() : initial }
        slot.set = next => {
          const value = typeof next === "function" ? next(slot.value) : next
          if (!Object.is(value, slot.value)) { slot.value = value; dirty = true }
        }
        slots[index] = slot
      }
      return [slots[index].value, slots[index].set]
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial } },
    useMemo(fn, deps) {
      const index = cursor++
      if (!same(slots[index]?.deps, deps)) slots[index] = { deps, value: fn() }
      return slots[index].value
    },
    useCallback(fn, deps) {
      const index = cursor++
      if (!same(slots[index]?.deps, deps)) slots[index] = { deps, fn }
      return slots[index].fn
    },
    useEffect(fn, deps) {
      const index = cursor++
      if (!same(slots[index]?.deps, deps)) {
        const previous = slots[index]
        slots[index] = { deps }
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = fn() })
      }
    },
  }
  hooks.useLayoutEffect = hooks.useEffect
  hooks.useContext = context => context.value
  const render = () => {
    do {
      dirty = false
      cursor = 0
      output = component()
      const commit = effects
      effects = []
      commit.forEach(fn => fn())
    } while (dirty)
  }
  return {
    hooks,
    mount(fn) { component = fn; render() },
    async flush() {
      for (let i = 0; i < 12; i++) { await Promise.resolve(); if (dirty) render() }
      return output
    },
    get value() { return output },
    cleanup() { slots.forEach(slot => slot?.cleanup?.()) },
  }
}
