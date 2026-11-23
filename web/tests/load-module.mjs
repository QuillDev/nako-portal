import { readFile } from "node:fs/promises"
import { transformWithOxc } from "vite"

export async function loadModule(path, rewrite = source => source) {
  const source = rewrite(await readFile(new URL(path, import.meta.url), "utf8"))
  const compiled = await transformWithOxc(source, path)
  return import(`data:text/javascript;base64,${Buffer.from(compiled.code.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve("react/jsx-runtime")))).toString("base64")}`)
}

export const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
