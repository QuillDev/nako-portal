// Files a transcript points at: MEDIA: tags in replies and image refs in user turns.
// dashboard/portal/media.py parses the same shapes for /api/file; keep the two in step.

const EXTS = (
  "png jpg jpeg gif webp bmp tiff svg mp4 mov avi mkv webm 3gp mp3 m2a wav ogg opus m4a flac " +
  "pdf docx doc odt rtf txt md epub xlsx xls ods csv tsv json xml yaml yml kmz kml geojson gpx " +
  "pptx ppt odp key zip tar gz tgz bz2 xz 7z rar apk ipa html htm"
)
  .split(" ")
  .sort((a, b) => b.length - a.length)
  .join("|")

const QUOTED = "`[^`\\n]+`|\"[^\"\\n]+\"|'[^'\\n]+'"
const MEDIA = new RegExp(
  `MEDIA:[^\\S\\n]*(?<path>${QUOTED}|(?:~/|/)[^\\n]*?\\.(?:${EXTS}))(?=[\\s\`"'*_,;:)\\]}\\[]|MEDIA:|\\.(?:\\s|$)|$)` +
    `|^MEDIA:(?<line>/[^\\n]+?)[^\\S\\n]*$`,
  "gim",
)
const USER_IMAGE = new RegExp(`\\[Image attached at: (?<hint>[^\\n\\]]+)\\]|^@image:(?<ref>${QUOTED}|\\S+)[^\\S\\n]*$`, "gm")
const CODE = /```[\s\S]*?(?:```|$)|(?<!MEDIA:)(?<!@image:)`[^`\n]*`/g
// The session store's stand-in for each attached image.
const PLACEHOLDER = /^\[(?:screenshot|image)\][^\S\n]*$/gm

const unquote = (v: string) => (v.length > 1 && v[0] === v.at(-1) && "`\"'".includes(v[0]) ? v.slice(1, -1) : v)
const masked = (text: string) => text.replace(CODE, m => " ".repeat(m.length))

type Found = { start: number; end: number; path: string }

function find(text: string, pattern: RegExp, group: (g: Record<string, string | undefined>) => string | undefined): Found[] {
  return [...masked(text).matchAll(pattern)].map(m => ({ start: m.index, end: m.index + m[0].length, path: unquote(group(m.groups || {}) || "") }))
}

function cut(text: string, found: Found[]) {
  let out = text
  for (const f of [...found].reverse()) {
    const after = out.slice(f.end)
    // "see MEDIA:/a.png, then" reads "see, then" rather than "see , then"
    const before = /^[,.;:)]/.test(after) ? out.slice(0, f.start).replace(/[^\S\n]+$/, "") : out.slice(0, f.start)
    out = before + after
  }
  return out.replace(/[^\S\n]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim()
}

export const isImage = (path: string) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path)

/** A reply without its MEDIA: tags, and the files they deliver. */
export function splitReply(text: string) {
  const found = find(text, MEDIA, g => g.path || g.line)
  return { body: cut(text, found), files: [...new Set(found.map(f => f.path))] }
}

/** A user turn without Hermes's image hints and placeholders, and the images they name. */
export function splitUserTurn(text: string) {
  const found = find(text, USER_IMAGE, g => g.hint || g.ref).filter(f => isImage(f.path))
  if (!found.length) return { body: text, images: [] as string[] }
  const body = cut(text, found).replace(PLACEHOLDER, "").replace(/\n{3,}/g, "\n\n").trim()
  return { body, images: [...new Set(found.map(f => f.path))] }
}
