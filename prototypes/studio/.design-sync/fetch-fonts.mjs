// Fetch brand woff2 from Google Fonts + rewrite to local @font-face.
// Keeps only latin + latin-ext subsets. Output → .design-sync/fonts/.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2]
const CSS_URL =
  'https://fonts.googleapis.com/css2?family=Albert+Sans:wght@400;500;600;700;800&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap'
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

mkdirSync(OUT, { recursive: true })

const css = await (await fetch(CSS_URL, { headers: { 'User-Agent': UA } })).text()

// Google emits: /* subset */\n@font-face { font-family:'X'; font-style:s; font-weight:w; src: url(U) format('woff2'); ... }
const blocks = css.split(/(?=\/\*\s*[a-z-]+\s*\*\/)/i).filter((b) => b.includes('@font-face'))
const keepSubsets = new Set(['latin', 'latin-ext'])
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

let outCss = '/* FREE brand fonts — Albert Sans, Source Serif 4, IBM Plex Mono (OFL). Fetched from Google Fonts, latin + latin-ext. */\n\n'
let n = 0
for (const block of blocks) {
  const subset = /\/\*\s*([a-z-]+)\s*\*\//i.exec(block)?.[1] ?? ''
  if (!keepSubsets.has(subset)) continue
  const family = /font-family:\s*'([^']+)'/.exec(block)?.[1]
  const weight = /font-weight:\s*([\d ]+)/.exec(block)?.[1]?.trim().replace(/\s+/g, '-')
  const style = /font-style:\s*(\w+)/.exec(block)?.[1] ?? 'normal'
  const url = /url\((https:[^)]+\.woff2)\)/.exec(block)?.[1]
  if (!family || !url) continue
  const file = `${slug(family)}-${weight}${style === 'italic' ? '-italic' : ''}-${subset}.woff2`
  const buf = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer())
  writeFileSync(join(OUT, file), buf)
  outCss += block.replace(/url\(https:[^)]+\.woff2\)/, `url('./${file}')`).trim() + '\n\n'
  n++
  console.log(`  ${file} (${(buf.length / 1024).toFixed(1)} KB)`)
}
writeFileSync(join(OUT, 'brand-fonts.css'), outCss)
console.log(`\n${n} woff2 files + brand-fonts.css → ${OUT}`)
