// Names for the ways into Hermes other than the portal, as the app shows them.
const NAMES: Record<string, string> = {
  cli: "CLI",
  tui: "TUI",
  sms: "SMS",
  api: "API",
  whatsapp: "WhatsApp",
  imessage: "iMessage",
  homeassistant: "Home Assistant",
  oneshot: "One-shot",
}

export function sourceName(source: string) {
  const known = NAMES[source.toLowerCase()]
  if (known) return known
  const words = source.replace(/[_-]+/g, " ").trim()
  return words ? words[0].toUpperCase() + words.slice(1) : "Other"
}
