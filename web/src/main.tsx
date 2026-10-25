import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app"
import "@fontsource-variable/inter/opsz.css"
import "@fontsource/instrument-serif/latin-400.css"
import "@fontsource/instrument-serif/latin-400-italic.css"
import "./index.css"
import "./lib/table-copy"
import "./lib/theme"

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
