// Which clicked links leave the app for the system browser.

/**
 * Cmd-click (Ctrl-click off macOS) or a middle click on an outside web link asks Electron for a
 * background tab: that one goes to the system browser. `onPortal(url)` tells the portal's own pages apart.
 */
export const toSystemBrowser = (url, disposition, onPortal) => disposition === "background-tab" && /^https?:/i.test(url) && !onPortal(url)
