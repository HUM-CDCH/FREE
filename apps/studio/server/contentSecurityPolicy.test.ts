import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  APP_SHELL_CONTENT_SECURITY_POLICY,
  withDevelopmentContentSecurityPolicy,
} from './contentSecurityPolicy.js'

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name, sources]),
  )
}

describe('app shell Content-Security-Policy', () => {
  it("the app shell loads script and pdf.js's worker only from Studio and refuses inline script and framing", () => {
    const policy = directives(APP_SHELL_CONTENT_SECURITY_POLICY)
    expect(policy.get('script-src')).toEqual(["'self'"])
    // `blob:`: the Excel export's zip writer deflates a large workbook part in a Blob-URL Worker (contentSecurityPolicy.ts).
    expect(policy.get('worker-src')).toEqual(["'self'", 'blob:'])
    expect(policy.get('frame-ancestors')).toEqual(["'none'"])
    expect(policy.get('object-src')).toEqual(["'none'"])
    for (const source of policy.get('script-src') ?? []) {
      expect(source).not.toBe("'unsafe-inline'")
      expect(source).not.toBe("'unsafe-eval'")
      expect(source).not.toMatch(/^'sha(256|384|512)-/)
    }
    expect(policy.has('form-action')).toBe(false)
  })

  it("development adds only Vite's own inline scripts, by hash, and its HMR socket", () => {
    const preamble = 'import "/@react-refresh"'
    const html = withDevelopmentContentSecurityPolicy(
      `<html><head><script type="module">${preamble}</script></head><body><script type="module" src="./src/main.tsx"></script></body></html>`,
    )
    const head = html.slice(html.indexOf('<head>') + '<head>'.length).trimStart()
    const meta =
      /^<meta http-equiv="Content-Security-Policy" content="([^"]*)" \/>/.exec(head)
    expect(meta).not.toBeNull()
    const policy = directives(meta?.[1] ?? '')
    const hash = createHash('sha256').update(preamble).digest('base64')
    expect(policy.get('script-src')).toEqual(["'self'", `'sha256-${hash}'`])
    expect(policy.get('connect-src')).toEqual(
      expect.arrayContaining(['ws:', 'wss:']),
    )
    expect(policy.has('frame-ancestors')).toBe(false)
  })
})
