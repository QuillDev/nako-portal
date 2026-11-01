// Where the floating Nako rests on screen, where her panel opens, and what she shows. All in
// screen points (Electron's DIPs); areas are a display's work area {x, y, width, height}.

/** The sticker's window: a little bigger than her, so the unread dot and the count pill under her fit. */
export const STICKER = { width: 76, height: 84 }
/** The panel's size until the screen is too small for it. */
export const PANEL = { width: 400, height: 640 }
/** Space between her and the panel, and between the panel and the screen edge. */
export const GAP = 8

const clamp = (value, least, most) => Math.min(Math.max(value, least), Math.max(least, most))

/** Keeps a sticker at (`x`, `y`) wholly inside `area`. */
export function inside(x, y, area, size = STICKER) {
  return {
    x: Math.round(clamp(x, area.x, area.x + area.width - size.width)),
    y: Math.round(clamp(y, area.y, area.y + area.height - size.height)),
  }
}

/** The area whose middle is nearest the sticker's middle at (`x`, `y`). */
export function nearest(x, y, areas, size = STICKER) {
  const cx = x + size.width / 2
  const cy = y + size.height / 2
  const distance = a => Math.hypot(clamp(cx, a.x, a.x + a.width) - cx, clamp(cy, a.y, a.y + a.height) - cy)
  return areas.reduce((best, a) => (distance(a) < distance(best) ? a : best))
}

/**
 * Where she starts: where she was left (`saved` {x, y}), pulled onto the nearest screen if that one
 * is gone or smaller now; with nothing saved, on the right edge of the main screen, a third down.
 */
export function rest(saved, areas, size = STICKER) {
  if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) return inside(saved.x, saved.y, nearest(saved.x, saved.y, areas, size), size)
  const main = areas[0]
  return inside(main.x + main.width - size.width - GAP, main.y + main.height * 0.3, main, size)
}

/**
 * Where the panel opens for a sticker at (`x`, `y`) in `area`: beside her on the roomier side, level
 * with her top in the top half of the screen and with her bottom in the bottom half. She never moves.
 */
export function panelSpot(x, y, area, size = STICKER, panel = PANEL, gap = GAP) {
  const width = Math.min(panel.width, area.width - gap * 2)
  const height = Math.min(panel.height, area.height - gap * 2)
  const right = x + size.width / 2 < area.x + area.width / 2
  const left = right ? x + size.width + gap : x - gap - width
  const top = y + size.height / 2 < area.y + area.height / 2 ? y : y + size.height - height
  return {
    x: Math.round(clamp(left, area.x + gap, area.x + area.width - gap - width)),
    y: Math.round(clamp(top, area.y + gap, area.y + area.height - gap - height)),
    width,
    height,
  }
}

const MOODS = new Set(["idle", "working", "needs-you"])
const count = value => (Number.isInteger(value) && value >= 0 ? value : null)

/**
 * What she shows, from the portal's `{"kind":"sticker"}` frame: her mood and the counts under her
 * (chats working, and chats finished that you haven't opened since). The portal does the counting;
 * null for any other frame.
 */
export function sticker(frame) {
  let value
  try {
    value = JSON.parse(frame)
  } catch {
    return null
  }
  if (value?.kind !== "sticker" || !MOODS.has(value.mood)) return null
  const working = count(value.working)
  const finished = count(value.finished)
  if (working === null || finished === null) return null
  return { mood: value.mood, working, finished }
}
