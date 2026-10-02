import { randomUUID } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { ModelConfig } from '../shared/modelConfig.contract.js'
import { E2E_ORIGIN, loginResearcher } from './auth.js'
import { activateWithKeyboard, expectOperableInViewport, REQUIRED_VIEWPORTS } from './accessibility.js'

/**
 * The unified Catalog's configuration in a real browser against Studio and PostgreSQL. It runs only where the
 * deployment's rollout gate is on (`FREE_CATALOG_METHOD=unified` in Studio's environment); the default suite runs with
 * it off, where the legacy Generic and Recipe controls stay as they were.
 */
test.skip(process.env.FREE_CATALOG_METHOD !== 'unified', 'the unified Catalog rollout gate is off')
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

/** The unified group's settings are paged: one view at a time, chosen by the "Catalog setting" selector. */
async function showPage(dialog: Locator, title: 'Catalog' | 'Effective settings'): Promise<void> {
  await dialog.getByRole('combobox', { name: 'Catalog setting', exact: true }).selectOption({ label: title })
  await expect(dialog.getByRole('region', { name: title, exact: true })).toBeVisible()
}

test('one Catalog group replaces Generic and Recipe; an invalid ceiling is found by keyboard; Apply saves it', async ({ page }) => {
  await signIn(page)
  const dialog = await openCatalogSettings(page)
  await expect(dialog.getByText('Service defaults, version 1')).toBeVisible()
  await expect(dialog.getByText('Generic Catalog')).toHaveCount(0)
  await expect(dialog.getByText('Recipe Catalog')).toHaveCount(0)
  await activateWithKeyboard(page, dialog.getByRole('button', { name: 'Customize' }))
  await showPage(dialog, 'Catalog')
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
  await dialog.getByRole('textbox', { name: 'Window overlap' }).fill('0')
  await dialog.getByRole('switch', { name: 'Verification' }).click()
  await expect(dialog.getByText(/Off keeps typed values as proposals/)).toBeVisible()
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/model_config' &&
    response.request().method() === 'PUT')
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
  expect((await saved).ok()).toBe(true)
  expect((await stored(page)).extractionSettings).toEqual({ catalog: { unified: { overlap: 0, verification: false } } })
})

test('retired Catalog preferences are explained, kept until Apply, and replaced only by it', async ({ page }) => {
  await signIn(page)
  const current = await stored(page)
  const legacy = { ...current, extractionSettings: { catalog: { generic: { record_chars: 30_000 } } } }
  const put = await page.request.put('/api/model_config', { data: { config: legacy }, headers: { origin: E2E_ORIGIN } })
  expect(put.ok()).toBe(true)
  const dialog = await openCatalogSettings(page)
  const note = dialog.getByRole('note')
  await expect(note).toContainText('Record text limit: 30,000 characters')
  await expect(note).toContainText('They are not converted')
  await dialog.getByRole('button', { name: 'Customize' }).click()
  await expect(note).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(dialog.getByRole('note')).toContainText('Record text limit: 30,000 characters')
  expect((await stored(page)).extractionSettings).toEqual(legacy.extractionSettings)
  await dialog.getByRole('button', { name: 'Use service defaults' }).click()
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(dialog.getByText('Everything saved')).toBeVisible()
  expect((await stored(page)).extractionSettings).toEqual({})
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
    await showPage(dialog, 'Catalog')
    await expectOperableInViewport(page, dialog.getByRole('textbox', { name: 'Input token ceiling' }))
    await expectOperableInViewport(page, dialog.getByRole('switch', { name: 'Verification' }))
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), `dialog at ${viewport.width}px`).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  }
})
