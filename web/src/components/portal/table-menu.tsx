// On a phone a reply table's copy/download/fullscreen buttons crowd its header, so they fold into
// one ⋯ menu there (index.css swaps which set shows). Streamdown draws the table and its buttons,
// so each table's toolbar gets a small host element and the menu is portalled into it. The menu
// itself opens in a body portal, so a short table in a clipped message can't cut it off.
import { CopyIcon, DownloadIcon, EllipsisIcon, Maximize2Icon } from "lucide-react"
import { useLayoutEffect, useRef, useState, type ComponentProps } from "react"
import type { defaultComponents } from "streamdown"
import { createPortal } from "react-dom"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { loadedMarkdown } from "@/lib/markdown"

const TOOLBAR = '[data-streamdown="table-wrapper"]:not(.h-full) > div:first-child'
const ICON = "size-4 text-muted-foreground"

/** Render Streamdown's unchanged table UI; only actual tables get toolbar work. */
export function MarkdownTable(props: ComponentProps<typeof defaultComponents.table>) {
  const table = useRef<HTMLTableElement>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const Table = loadedMarkdown()!.defaultComponents.table
  // React has committed the table's toolbar before layout effects run. No subtree observer
  // is needed, and ordinary Markdown bodies never mount this component at all.
  useLayoutEffect(() => {
    const bar = table.current?.closest('[data-streamdown="table-wrapper"]')?.querySelector<HTMLElement>(TOOLBAR)
    if (!bar) return
    let next = bar.querySelector<HTMLElement>(":scope > [data-table-menu]")
    if (!next) {
      next = document.createElement("span")
      next.dataset.tableMenu = ""
      bar.append(next)
    }
    setHost(previous => previous === next ? previous : next)
  })
  return <><Table {...props} ref={table} />{host && createPortal(<TableMenu host={host} />, host)}</>
}

function TableMenu({ host }: { host: HTMLElement }) {
  // Copy and fullscreen go through Streamdown's own (hidden) buttons, so they behave as on desktop.
  const press = (title: string) => host.parentElement?.querySelector<HTMLButtonElement>(`button[title="${title}"]`)?.click()
  const download = (kind: "csv" | "md") => {
    const table = host.closest('[data-streamdown="table-wrapper"]')?.querySelector("table")
    const markdown = loadedMarkdown()
    if (!table || !markdown) return
    const data = markdown.extractTableDataFromElement(table)
    // The BOM lets Excel read the CSV as UTF-8, as Streamdown's own download does.
    const text = kind === "csv" ? "\uFEFF" + markdown.tableDataToCSV(data) : markdown.tableDataToMarkdown(data)
    const url = URL.createObjectURL(new Blob([text], { type: kind === "csv" ? "text/csv" : "text/markdown" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `table.${kind}`
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="cursor-pointer p-1 text-muted-foreground outline-none" title="Table actions" type="button">
          <EllipsisIcon size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={e => e.preventDefault()}>
        <DropdownMenuItem onSelect={() => press("Copy table")}>
          <CopyIcon className={ICON} />
          Copy
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => download("csv")}>
          <DownloadIcon className={ICON} />
          Download CSV
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => download("md")}>
          <DownloadIcon className={ICON} />
          Download Markdown
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => press("View fullscreen")}>
          <Maximize2Icon className={ICON} />
          Full screen
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
