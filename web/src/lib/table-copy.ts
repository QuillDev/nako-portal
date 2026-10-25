// Streamdown's table copy button opens a Markdown/CSV/TSV menu. We only want TSV (it pastes
// straight into a spreadsheet), so catch the click before Streamdown sees it and copy at once.
// The HTML copy goes along too, so rich editors keep the rows and columns.
import { extractTableDataFromElement, tableDataToTSV } from "streamdown"

const FLASH_MS = 1500

document.addEventListener(
  "click",
  async e => {
    const button = (e.target as Element | null)?.closest<HTMLButtonElement>('button[title="Copy table"]')
    const table = button?.closest('[data-streamdown="table-wrapper"]')?.querySelector("table")
    if (!button || !table) return
    e.preventDefault()
    e.stopPropagation()
    const tsv = tableDataToTSV(extractTableDataFromElement(table))
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
