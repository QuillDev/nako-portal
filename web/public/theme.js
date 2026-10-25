// Runs before first paint so a light-mode page never flashes dark. Keep in step with src/lib/theme.ts.
;(() => {
  let choice = "system"
  try {
    choice = localStorage.getItem("theme") || "system"
  } catch {}
  const light = choice === "light" || (choice === "system" && matchMedia("(prefers-color-scheme: light)").matches)
  document.documentElement.classList.toggle("light", light)
  document.documentElement.classList.toggle("dark", !light)
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", light ? "#fbfbfc" : "#09090b")
})()
