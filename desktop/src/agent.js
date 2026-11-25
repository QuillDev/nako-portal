// The user agent the desktop app's webviews see.

/** Chromium's agent without the Electron and app tokens some sites refuse. */
export const browserAgent = fallback => fallback.replace(/ Electron\/\S+/, "").replace(/ nako\/\S+/i, "")
