export type MessageMatch = { id: string; title: string; snippet: string; archived: boolean; at: number }

/** Keep server order and show each chat once across all search groups. */
export function mergeMessageMatches(rows: MessageMatch[], shown: { id: string }[]): MessageMatch[] {
  const seen = new Set(shown.map(row => row.id))
  return rows.filter(row => {
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
}
