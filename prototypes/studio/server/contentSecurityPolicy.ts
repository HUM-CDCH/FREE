import { createHash } from 'node:crypto'

/**
 * Researchers' API keys live in this origin's localStorage (docs/design/unified-durable-execution.md,
 * *Model configuration and keys → XSS*), so script and pdf.js's worker load only from Studio, inline script is
 * refused and no page may frame Studio. Workers may also start from a `blob:` URL, which only script already running
 * in Studio can mint: the Excel export's zip writer (fflate, under write-excel-file) deflates each workbook part of
 * 160 kB or more in a Blob-URL Worker and never hears back if the Worker is refused, so a large workbook's export
 * would never finish. Styles and fonts also allow Google Fonts, which index.html loads, and styles
 * allow inline attributes (React, pdf.js, and Vite's injected <style> in development). No form-action: sign-out is a
 * form POST answered with a redirect to the identity provider. The sign-in relay keeps its own policy (app.ts).
 */
const DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'worker-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'frame-ancestors': ["'none'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  'connect-src': ["'self'"],
} as const satisfies Readonly<Record<string, readonly string[]>>

function serialize(directives: Readonly<Record<string, readonly string[]>>): string {
  return Object.entries(directives).map(([name, sources]) => [name, ...sources].join(' ')).join('; ')
}

export const APP_SHELL_CONTENT_SECURITY_POLICY = serialize(DIRECTIVES)

const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi

/**
 * Development only: the same policy as a <meta> element placed before every script, plus the hash of each inline
 * script Vite itself injected (React Refresh's preamble) and Vite's HMR socket. A meta policy cannot carry
 * frame-ancestors. Any other inline script, including one injected later, is still refused.
 */
export function withDevelopmentContentSecurityPolicy(html: string): string {
  const hashes = [...html.matchAll(INLINE_SCRIPT)].map(
    ([, body]) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`,
  )
  const development = Object.fromEntries(
    Object.entries(DIRECTIVES)
      .filter(([name]) => name !== 'frame-ancestors')
      .map(([name, sources]) => [
        name,
        name === 'script-src' ? [...sources, ...hashes] : name === 'connect-src' ? [...sources, 'ws:', 'wss:'] : sources,
      ]),
  )
  const meta = `<meta http-equiv="Content-Security-Policy" content="${serialize(development)}" />`
  return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}\n    ${meta}`)
}
