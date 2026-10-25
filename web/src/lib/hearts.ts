const THANKS = /\b(thanks|thank\s*you)\b/i

export function saysThanks(text: string): boolean {
  return THANKS.test(text)
}

const HEART =
  '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path fill="currentColor" d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 2.9 4.5 6.6 4.5c2.1 0 3.6 1.2 4.4 2.6.8-1.4 2.3-2.6 4.4-2.6 3.7 0 5.7 3.9 4.2 7.3C19.5 16.4 12 21 12 21z"/></svg>'

// A short burst of hearts floating up from the composer.
export function burstHearts(origin?: Element | null) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
  const box = origin?.getBoundingClientRect()
  const left = box ? box.left : 0
  const width = box ? box.width : window.innerWidth
  const y = box ? box.top : window.innerHeight - 80
  // One heart per ~32px, spaced evenly across the composer with a little jitter.
  const count = Math.max(8, Math.min(28, Math.round(width / 32)))
  const slot = width / count

  const layer = document.createElement("div")
  layer.className = "hearts-layer"
  let longest = 0
  for (let i = 0; i < count; i++) {
    const heart = document.createElement("span")
    heart.className = "heart"
    heart.innerHTML = HEART
    const size = 14 + Math.random() * 14
    const duration = 1400 + Math.random() * 1000
    const delay = Math.random() * 400
    longest = Math.max(longest, duration + delay)
    Object.assign(heart.style, {
      left: `${Math.min(Math.max(left + slot * (i + 0.2 + Math.random() * 0.6) - size / 2, left), left + width - size)}px`,
      top: `${y - size}px`,
      width: `${size}px`,
      height: `${size}px`,
      animationDuration: `${duration}ms`,
      animationDelay: `${delay}ms`,
    })
    heart.style.setProperty("--dx", `${(Math.random() - 0.5) * 40}px`)
    heart.style.setProperty("--rise", `${-(120 + Math.random() * 180)}px`)
    heart.style.setProperty("--rot", `${(Math.random() - 0.5) * 40}deg`)
    layer.appendChild(heart)
  }
  document.body.appendChild(layer)
  window.setTimeout(() => layer.remove(), longest + 100)
}
