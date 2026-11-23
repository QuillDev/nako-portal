/** The file fields used by the composer and its upload boundary. */
export type AttachmentFile = {
  type: "file"
  url: string
  mediaType: string
  filename?: string
}

export type AttachmentError = {
  code: "max_files" | "max_file_size" | "accept" | "file_read"
  message: string
}

export type AttachmentLimits = {
  accept?: string
  maxFiles?: number
  maxFileSize?: number
  onError?: (error: AttachmentError) => void
}

/** Shared by every attachment entry point, including provider-backed paste and drop. */
export function validateAttachments(files: File[], count: number, limits: AttachmentLimits): File[] {
  const { accept, maxFiles, maxFileSize, onError } = limits
  const patterns = accept?.split(",").map(value => value.trim().toLowerCase()).filter(Boolean)
  const accepted = files.filter(file => !patterns?.length || patterns.some(pattern =>
    pattern.startsWith(".") ? file.name.toLowerCase().endsWith(pattern) :
    pattern.endsWith("/*") ? file.type.toLowerCase().startsWith(pattern.slice(0, -1)) :
    file.type.toLowerCase() === pattern))
  if (accepted.length < files.length) onError?.({ code: "accept", message: "Some files do not match the accepted types." })
  const sized = accepted.filter(file => maxFileSize === undefined || file.size <= maxFileSize)
  if (sized.length < accepted.length) onError?.({ code: "max_file_size", message: "Some files exceed the maximum size." })
  const capacity = maxFiles === undefined ? sized.length : Math.max(0, maxFiles - count)
  if (sized.length > capacity) onError?.({ code: "max_files", message: "Too many files. Some were not added." })
  return sized.slice(0, capacity)
}

/** Read the original File; a failed read rejects submission and leaves the draft intact. */
export function attachmentDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const fail = () => reject(new Error(`Couldn't read ${file.name || "attachment"}. Please attach it again.`))
    reader.onload = () => typeof reader.result === "string" && reader.result.startsWith("data:") ? resolve(reader.result) : fail()
    reader.onerror = fail
    reader.onabort = fail
    reader.readAsDataURL(file)
  })
}
