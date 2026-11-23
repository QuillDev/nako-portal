// When a message was written, as the chat shows it. `at` is Unix seconds.

const clock = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

// Whole days between `at` and today: 0 today, 1 yesterday.
export function daysAgo(at: number, now: Date) {
  return Math.round((midnight(now) - midnight(new Date(at * 1000))) / 86_400_000)
}

export const dayOf = (at: number) => midnight(new Date(at * 1000))

// The line between days: "Today", "Yesterday", else "Thu, Nov 12" (with the year when it isn't this one).
export function dayLabel(at: number, now = new Date()) {
  const ago = daysAgo(at, now)
  if (ago === 0) return "Today"
  if (ago === 1) return "Yesterday"
  const d = new Date(at * 1000)
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) })
}

export const timeOf = (at: number) => clock(new Date(at * 1000))

// On hover: "Today at 9:14 AM", "Yesterday at 11:52 PM", else "14/11/26 at 11:52 PM".
export function fullTime(at: number, now = new Date()) {
  const ago = daysAgo(at, now)
  const d = new Date(at * 1000)
  const pad = (n: number) => String(n).padStart(2, "0")
  const day = ago === 0 ? "Today" : ago === 1 ? "Yesterday" : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)}`
  return `${day} at ${clock(d)}`
}

// Calendar days, shared by both session lists and the transcript's day labels.
export function age(at: number, now = new Date()) {
  const days = daysAgo(at, now)
  if (days < 1) return "today"
  if (days < 2) return "yesterday"
  if (days < 7) return "this week"
  if (days < 30) return "this month"
  return "older"
}
