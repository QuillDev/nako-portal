// Where the portal, the divider and the in-app browser go across the window.

/** Below this window width the pane takes the whole window instead of sharing it. */
const SIDE_BY_SIDE = 760
/** How much of the window the pane takes until the divider is dragged. */
export const DEFAULT_SHARE = 0.45
const MIN_PANE = 360
const MIN_PORTAL = 380
/** The strip between the portal and the pane that drags sideways to resize them. */
export const DIVIDER_WIDTH = 8

/** The pane's width in a window `width` wide when it takes `share` of it, leaving both sides room. */
function paneWidth(width, share) {
  const wanted = Number.isFinite(share) ? Math.min(Math.max(share, 0), 1) : DEFAULT_SHARE
  return Math.round(Math.min(Math.max(width * wanted, MIN_PANE), width - DIVIDER_WIDTH - MIN_PORTAL))
}

/**
 * Where each part goes for a window `width` wide: [portal width, pane x, pane width]. The divider
 * sits between the portal and the pane. A narrow window gives the pane all of it.
 */
export function split(width, open, share = DEFAULT_SHARE) {
  if (!open) return [width, width, 0]
  if (width < SIDE_BY_SIDE) return [0, 0, width]
  const pane = paneWidth(width, share)
  return [width - pane - DIVIDER_WIDTH, width - pane, pane]
}

/** The share to keep after the divider is let go at `x` in a window `width` wide. */
export function shareFor(width, x) {
  return paneWidth(width, (width - x - DIVIDER_WIDTH / 2) / width) / width
}

/** How far the divider's middle may go in a window `width` wide while it's dragged: [least, most]. */
export function dragRange(width) {
  return [MIN_PORTAL + DIVIDER_WIDTH / 2, width - MIN_PANE - DIVIDER_WIDTH / 2]
}
