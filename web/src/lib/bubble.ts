// The portal inside the Android app's floating Nako panel: a compact view, with the panel's own
// open/close in the header. Her sticker already floats outside the panel, so the chat drops its own.
type BubbleBridge = { openInApp(): void; close(): void }
const bridge = () => (window as unknown as { NakoBubble?: BubbleBridge }).NakoBubble

export const inBubble = /NakoBubble\//.test(navigator.userAgent)

if (inBubble) document.documentElement.classList.add("bubble")

export const openBubbleInApp = () => bridge()?.openInApp()
export const closeBubble = () => bridge()?.close()
