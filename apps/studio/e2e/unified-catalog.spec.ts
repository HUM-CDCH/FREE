import { randomUUID } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { UNIFIED_CATALOG_DEFAULTS_VERSION } from 'extraction/extraction-method'
import type { ModelConfig } from '../shared/modelConfig.contract.js'
import { E2E_ORIGIN, loginResearcher } from './auth.js'
import { activateWithKeyboard, expectOperableInViewport, REQUIRED_VIEWPORTS } from './accessibility.js'

/** Catalog configuration in a real browser against Studio and PostgreSQL. */
test.describe.configure({ mode: 'serial' })

async function signIn(page: Page): Promise<void> {
  await loginResearcher(page, randomUUID())
  await expect(page.getByRole('navigation', { name: 'Projects' })).toBeVisible()
}

async function openCatalogSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Configure models' }).click()
  const dialog = page.getByRole('dialog', { name: 'Model configuration' })
  await expect(dialog.getByRole('tab', { name: 'Models' })).toBeVisible({ timeout: 15_000 })
  await dialog.getByRole('tab', { name: 'Advanced' }).click()
  await dialog.getByRole('radio', { name: 'Catalog' }).check()
  return dialog
}

async function stored(page: Page): Promise<ModelConfig> {
  const response = await page.request.get('/api/model_config')
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { config: ModelConfig }).config
}

/** The unified group's settings are paged, one control per view, chosen by the "Catalog setting" selector. */
const pageSelector = (dialog: Locator) => dialog.getByRole('combobox', { name: 'Catalog setting', exact: true })
async function showPage(dialog: Locator, title: string): Promise<void> {
  await pageSelector(dialog).selectOption({ label: title })
  await expect(dialog.getByRole('region', { name: title.startsWith('Catalog: ') ? 'Catalog' : title, exact: true })).toBeVisible()
}

test('one Catalog group replaces Generic and Recipe; an invalid ceiling is found by keyboard; Apply saves it', async ({ page }) => {
  await signIn(page)
  const dialog = await openCatalogSettings(page)
  await expect(dialog.getByText(`Service defaults, version ${UNIFIED_CATALOG_DEFAULTS_VERSION}`)).toBeVisible()
  await expect(dialog.getByText('Generic Catalog')).toHaveCount(0)
  await expect(dialog.getByText('Recipe Catalog')).toHaveCount(0)
  await activateWithKeyboard(page, dialog.getByRole('button', { name: 'Customize' }))
  await showPage(dialog, 'Catalog: Input token ceiling')
  const ceiling = dialog.getByRole('textbox', { name: 'Input token ceiling' })
  await expect(ceiling).toHaveAttribute('placeholder', 'Auto')
  await ceiling.fill('100')
  await expect(ceiling).toHaveAttribute('aria-invalid', 'true')
  await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled()
  // From another page, the issue summary brings its control back into view and focuses it.
  await showPage(dialog, 'Effective settings')
  await expect(ceiling).toBeHidden()
  await activateWithKeyboard(page, dialog.getByRole('button', { name: '1 issue blocks Apply' }))
  await expect(ceiling).toBeFocused()
  await ceiling.fill('')
  await showPage(dialog, 'Catalog: Window overlap')
  await dialog.getByRole('textbox', { name: 'Window overlap' }).fill('0')
  await showPage(dialog, 'Effective settings')
  await expect(dialog.getByText(/Shared headings are checked separately/)).toBeVisible()
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/model_config' &&
    response.request().method() === 'PUT')
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
  expect((await saved).ok()).toBe(true)
  expect((await stored(page)).extractionSettings).toEqual({ catalog: { unified: { overlap: 0 } } })
})

test('retired Catalog preferences are refused without changing saved settings', async ({ page }) => {
  await signIn(page)
  const current = await stored(page)
  for (const catalog of [{ generic: { record_chars: 30_000 } }, { recipe: { input_tokens: 4096 } }, { unified: { verification: true } }]) {
    const put = await page.request.put('/api/model_config', {
      data: { config: { ...current, extractionSettings: { catalog } } }, headers: { origin: E2E_ORIGIN },
    })
    expect(put.status()).toBe(400)
    expect(await stored(page)).toEqual(current)
  }
})

test('the Catalog group reflows without horizontal scrolling at 360 px and the required viewports', async ({ page }) => {
  await signIn(page)
  for (const viewport of [{ width: 360, height: 800 }, ...REQUIRED_VIEWPORTS]) {
    await page.setViewportSize(viewport)
    if (viewport.width < 860) {
      await expect(page.getByRole('button', { name: 'Configure models' })).toHaveCount(0)
      await activateWithKeyboard(page, page.getByRole('button', { name: 'Expand projects' }))
    }
    const dialog = await openCatalogSettings(page)
    await dialog.getByRole('button', { name: 'Customize' }).click()
    await showPage(dialog, 'Catalog: Input token ceiling')
    await expectOperableInViewport(page, dialog.getByRole('textbox', { name: 'Input token ceiling' }))
    await showPage(dialog, 'Catalog: Heading context')
    await expectOperableInViewport(page, dialog.getByRole('switch', { name: 'Heading context' }))
    // Every view fits without an inner scroll area, as the other Advanced settings do.
    for (const title of await pageSelector(dialog).locator('option').allTextContents()) {
      await showPage(dialog, title)
      expect(await dialog.evaluate((element) => element.scrollHeight <= element.clientHeight + 1), `${title} at ${viewport.width}px`).toBe(true)
    }
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), `dialog at ${viewport.width}px`).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  }
})
