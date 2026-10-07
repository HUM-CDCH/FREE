import { expect, test } from '@playwright/test'
import { gotoAuthenticated } from './auth.js'
import { openBundledDocument, routeBundledDocument } from './bundledDocument.js'

// The e2e server is Vite, so this runs under the development <meta> policy; the production header derives from the
// same directive table and is pinned by server/contentSecurityPolicy.test.ts and server/static.test.ts.
test('the app shell policy runs the PDF viewer and its worker, and refuses inline script @deterministic', async ({ page }) => {
  await page.addInitScript(() => {
    const violations: string[] = []
    Object.assign(window, { __cspViolations: violations })
    document.addEventListener('securitypolicyviolation', (event) =>
      violations.push(`${event.effectiveDirective} ${event.blockedURI}`))
  })
  await routeBundledDocument(page)
  await gotoAuthenticated(page, '/')
  await openBundledDocument(page)
  await expect(page.locator('.pdfViewer .page')).toHaveCount(6)
  await expect(page.locator('.pdfViewer .page canvas').first()).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)).toEqual([])

  await page.addScriptTag({ content: 'window.__freeInlineScriptRan = true' }).catch(() => undefined)
  expect(await page.evaluate(() => (window as { __freeInlineScriptRan?: boolean }).__freeInlineScriptRan)).toBeUndefined()
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __cspViolations: string[] }).__cspViolations.some((entry) => entry.startsWith('script-src')))).toBe(true)
})
