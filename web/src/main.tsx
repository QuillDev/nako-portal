import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app"
import "./index.css"

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
