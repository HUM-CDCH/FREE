import { expect, type Locator, type Page } from '@playwright/test'

export const REQUIRED_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 859, height: 800 },
  { width: 390, height: 844 },
] as const

/**
 * Chromium does not expose its browser-zoom UI to Playwright. Halving the CSS
 * viewport exercises the same layout space as a 1280x800 viewport at 200%.
 */
export async function emulateBrowserZoom200(page: Page): Promise<void> {
  await page.setViewportSize({ width: 640, height: 400 })
}

export async function activateWithKeyboard(
  page: Page,
  control: Locator,
  key: 'Enter' | 'Space' = 'Enter',
): Promise<void> {
  await control.focus()
  await expect(control).toBeFocused()
  await page.keyboard.press(key)
}

export async function expectOperableInViewport(
  page: Page,
  control: Locator,
): Promise<void> {
  await expect(control).toBeVisible()
  await control.scrollIntoViewIfNeeded()
  const [box, viewport] = await Promise.all([
    control.boundingBox(),
    page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    })),
  ])
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
}
