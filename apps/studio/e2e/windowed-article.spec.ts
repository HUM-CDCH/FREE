import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { loginResearcher } from './auth.js'

/** This opt-in gate changes only new-work defaults; the normal suite also verifies the gate-off reference. */
test.skip(process.env.FREE_ARTICLE_CONTEXT !== 'bounded', 'the bounded Article deployment default is off')

test('the bounded Article deployment default is visible and preserves an explicit full-source preference', async ({ page }, info) => {
  await loginResearcher(page, randomUUID())
  const read = async () => {
    const response = await page.request.get('/api/model_config')
    expect(response.ok()).toBe(true)
    return response.json()
  }
  const initial = await read()
  expect(initial.deployment.boundedArticle).toBe(true)
  expect(initial.config.extractionSettings.article).toBeUndefined()
  await page.getByRole('button', { name: 'Configure models' }).click()
  const dialog = page.getByRole('dialog', { name: 'Model configuration' })
  await dialog.getByRole('tab', { name: 'Advanced' }).click()
  await dialog.getByRole('radio', { name: 'Article', exact: true }).check()
  const setting = dialog.getByRole('combobox', { name: 'Article setting', exact: true })
  await setting.selectOption({ label: 'Effective settings' })
  await expect(dialog.getByText('Bounded source units (12,288 tokens) · Plain text · Source-label verification', { exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('article-deployment-default.png'), fullPage: true })
  await dialog.getByRole('button', { name: 'Customize', exact: true }).click()
  await setting.selectOption({ label: 'Source context: Scope' })
  const scope = dialog.getByRole('group', { name: 'Scope', exact: true })
  await expect(scope.getByRole('radio', { name: 'Bounded source units', exact: true })).toBeChecked()
  await scope.getByRole('radio', { name: 'Full source', exact: true }).check()
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(dialog.getByText('Everything saved', { exact: true })).toBeVisible()
  expect((await read()).config.extractionSettings.article.context).toBe('full')
  await page.reload()
  await page.getByRole('button', { name: 'Configure models' }).click()
  const reopened = page.getByRole('dialog', { name: 'Model configuration' })
  await reopened.getByRole('tab', { name: 'Advanced' }).click()
  await reopened.getByRole('radio', { name: 'Article', exact: true }).check()
  await reopened.getByRole('combobox', { name: 'Article setting', exact: true }).selectOption({ label: 'Source context: Scope' })
  await expect(reopened.getByRole('group', { name: 'Scope', exact: true }).getByRole('radio', { name: 'Full source', exact: true })).toBeChecked()
  // Resetting an account override never stores the deployment default as an account preference.
  await reopened.getByRole('button', { name: 'Use service defaults', exact: true }).click()
  await reopened.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(reopened.getByText('Everything saved', { exact: true })).toBeVisible()
  expect((await read()).config.extractionSettings.article).toBeUndefined()
})
