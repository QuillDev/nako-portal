/** Keep only live notifications, including when an older replacement closes late. */
export function trackNotification(shown, session, note) {
  shown.get(session)?.close()
  shown.set(session, note)
  const remove = () => {
    if (shown.get(session) === note) shown.delete(session)
  }
  note.once("close", remove)
  note.once("click", remove)
  note.once("failed", remove)
}
