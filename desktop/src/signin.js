// Signing in through the browser. The app's own pages don't hold the portal's passkey, so the app
// opens the portal in the browser, which does. The signed-in page sends a one-time code back to a
// listener on 127.0.0.1, and the app trades that code plus a secret only it knows (PKCE, RFC 8252)
// for its own login cookie.
import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"

const SIGNED_IN =
  '<!doctype html><meta charset=utf-8><title>Nako</title><body style="background:#0d0a11;color:#f3eaef;font:16px Inter,system-ui,sans-serif;display:grid;place-items:center;height:90vh">Signed in. You can close this tab and go back to Nako.'

const random = () => randomBytes(32).toString("base64url")

/**
 * Starts a sign-in: `browserUrl` is where the browser goes to approve it, and `wait(ms)` resolves
 * with the page that signs the app in (null when nobody came back in time). Requests that don't
 * carry this sign-in's state are turned away and the wait goes on.
 */
export async function begin(origin) {
  const state = random()
  const verifier = random()
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  let finish
  const done = new Promise(resolve => (finish = resolve))
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")
    const code = url.pathname === "/callback" && url.searchParams.get("state") === state ? url.searchParams.get("code") : null
    response.writeHead(code ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", Connection: "close" })
    response.end(code ? SIGNED_IN : "This isn't a sign-in this app started.")
    if (code) {
      const page = new URL("/api/desktop/session", origin.url)
      page.searchParams.set("code", code)
      page.searchParams.set("verifier", verifier)
      finish(page.toString())
    }
  })
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).on("error", reject))
  const query = new URLSearchParams({ port: String(server.address().port), state, challenge })
  return {
    browserUrl: origin.page(`/#/desktop?${query}`),
    async wait(ms) {
      let timer
      const result = await Promise.race([done, new Promise(resolve => (timer = setTimeout(() => resolve(null), ms)))])
      clearTimeout(timer)
      server.close()
      return result
    },
    cancel() {
      finish(null)
    },
  }
}
