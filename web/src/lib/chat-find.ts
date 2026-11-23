export type TextMatch = { start: number; end: number }

/** Literal, case-insensitive matches with offsets in the original text (including Unicode). */
export function findTextMatches(text: string, query: string): TextMatch[] {
  if (!query.trim()) return []
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")
  return [...text.matchAll(pattern)].map(match => ({ start: match.index, end: match.index + match[0].length }))
}

export function nextMatch(current: number, direction: number, total: number): number {
  return total ? ((current + direction) % total + total) % total : -1
}

/** Read text nodes and create ranges without changing React's DOM. */
export function chatFindRanges(root: HTMLElement, query: string): Range[] {
  const ranges: Range[] = []
  for (const block of root.querySelectorAll<HTMLElement>("[data-find-text]")) {
    const nodes: Text[] = []
    const walker = root.ownerDocument.createTreeWalker(block, 4, {
      acceptNode(node) {
        const parent = node.parentElement
        return parent?.closest('button, [data-find-ignore], [hidden], [aria-hidden="true"], script, style') ? 2 : 1
      },
    })
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    const text = nodes.map(node => node.data).join("")
    for (const match of findTextMatches(text, query)) {
      const range = root.ownerDocument.createRange()
      let offset = 0
      for (const node of nodes) {
        const end = offset + node.length
        if (match.start >= offset && match.start < end) range.setStart(node, match.start - offset)
        if (match.end > offset && match.end <= end) { range.setEnd(node, match.end - offset); break }
        offset = end
      }
      ranges.push(range)
    }
  }
  return ranges
}
