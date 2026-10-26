// Streamdown's table copy button opens a Markdown/CSV/TSV menu. We only want TSV (it pastes
// straight into a spreadsheet), so catch the click before Streamdown sees it and copy at once.
// The HTML copy goes along too, so rich editors keep the rows and columns.
import { loadedMarkdown } from "./markdown"

const FLASH_MS = 1500

document.addEventListener(
  "click",
  async e => {
    const button = (e.target as Element | null)?.closest<HTMLButtonElement>('button[title="Copy table"]')
    const table = button?.closest('[data-streamdown="table-wrapper"]')?.querySelector("table")
    // A table on screen means the renderer that drew it is loaded.
    const markdown = loadedMarkdown()
    if (!button || !table || !markdown) return
    e.preventDefault()
    e.stopPropagation()
    const tsv = markdown.tableDataToTSV(markdown.extractTableDataFromElement(table))
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([tsv], { type: "text/plain" }),
        "text/html": new Blob([table.outerHTML], { type: "text/html" }),
      }),
    ])
    button.dataset.copied = ""
    setTimeout(() => delete button.dataset.copied, FLASH_MS)
  },
  true,
)
