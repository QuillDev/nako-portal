// The user agent pages in the in-app browser see.

/** Chromium's agent without the Electron and app tokens some sites refuse to sign in with. */
export const browserAgent = fallback => fallback.replace(/ Electron\/\S+/, "").replace(/ nako\/\S+/i, "")

/**
 * Google's sign-in turns away embedded Chromium ("This browser or app may not be secure") even
 * with a plain Chrome agent, but lets a Firefox agent through to its usual steps. Only its sign-in
 * host gets that agent; every other site sees Chrome.
 */
export const GOOGLE_SIGN_IN = ["https://accounts.google.com/*"]

export function signInAgent(platform = process.platform) {
  const system = platform === "darwin" ? "Macintosh; Intel Mac OS X 10.15" : platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64"
  return `Mozilla/5.0 (${system}; rv:144.0) Gecko/20100101 Firefox/144.0`
}
