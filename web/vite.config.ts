import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite"

// Preload the font used on every route. Markdown warms after sign-in.
function preloadFirstPaint(): Plugin {
  return {
    name: "preload-first-paint",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle }) {
        const tags: HtmlTagDescriptor[] = []
        for (const file of Object.values(bundle ?? {})) {
          if (file.type === "asset" && /\/inter-latin-opsz-normal-[^/]+\.woff2$/.test(`/${file.fileName}`))
            tags.push({ tag: "link", attrs: { rel: "preload", as: "font", type: "font/woff2", crossorigin: true, href: `/${file.fileName}` }, injectTo: "head" })
        }
        return tags
      },
    },
  }
}

// Keep one record per line in the shipped emoji dictionary so build and install
// diagnostics can distinguish unrelated words in different records.
function formatEmojiData(): Plugin {
  return {
    name: "format-emoji-data",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const asset of Object.values(bundle)) {
        if (asset.type !== "asset" || !asset.originalFileNames.some(name => name.endsWith("emoji-picker-element-data/en/emojibase/data.json"))) continue
        const records: unknown[] = JSON.parse(typeof asset.source === "string" ? asset.source : new TextDecoder().decode(asset.source))
        asset.source = `[\n${records.map(record => JSON.stringify(record)).join(",\n")}\n]\n`
      }
    },
  }
}

// The build lands in dashboard/web, which the portal serves as-is.
export default defineConfig({
  plugins: [react(), tailwindcss(), preloadFirstPaint(), formatEmojiData()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL("../dashboard/web", import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
})
