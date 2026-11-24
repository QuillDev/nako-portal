// Runs before first paint so a light-mode page never flashes dark. Keep in step with src/lib/theme.ts.
;(() => {
  let choice = "system"
  try {
    choice = localStorage.getItem("theme") || "system"
  } catch {}
  let seenSession = false
  try {
    seenSession = sessionStorage.getItem("portal-seen-session") === "1"
    const width = Math.min(480, Math.max(220, Number(localStorage.getItem("sidebar:width")) || 288))
    document.documentElement.style.setProperty("--opening-rail", `${localStorage.getItem("sidebar:collapsed") === "1" ? 0 : width}px`)
  } catch {}
  const list = !location.hash || location.hash === "#/"
  document.documentElement.dataset.opening = list && !seenSession || /^#(?:setup=|signin=|\/desktop)/.test(location.hash) ? "auth" : list ? "list" : "page"
  const light = choice === "light" || (choice === "system" && matchMedia("(prefers-color-scheme: light)").matches)
  document.documentElement.classList.toggle("light", light)
  document.documentElement.classList.toggle("dark", !light)
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", light ? "#fbfbfc" : "#09090b")
})()
