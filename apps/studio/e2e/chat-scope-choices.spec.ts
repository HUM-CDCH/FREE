import { expect, test } from '@playwright/test'
import { prepareInteractiveDocument } from './interactiveStack.js'
import { openRailView, workspaceRail } from './rail.js'

for (const finish of ['Save', 'Cancel'] as const) {
  test(`unchosen chat scope waits for an unfinished edit and is enabled after ${finish} @deterministic`, async ({ page }) => {
    test.skip(!process.env.EXTRACTION_TEST_DATABASE_URL || process.env.DATABASE_URL !== process.env.EXTRACTION_TEST_DATABASE_URL,
      'Requires the disposable PostgreSQL stack.')
    const fixture = await prepareInteractiveDocument(page, { hasKey: false, recordScope: null })
    try {
      await fixture.open()
      await openRailView(page, 'Template')
      await page.getByRole('button', { name: 'Edit description', exact: true }).click()
      await page.getByLabel('What one record is').fill('An unfinished record description.')
      await workspaceRail(page).getByRole('button', { name: 'Back to chat' }).click()
      const card = page.getByRole('region', { name: 'Choose Record Scope', exact: true })
      for (const name of [/^Article:/, /^Catalog:/]) {
        const choice = card.getByRole('button', { name })
        await expect(choice).toBeDisabled()
        await expect(choice).toHaveAccessibleDescription('Save or Cancel the open edit first.')
      }
      await expect(card.getByText('Save or Cancel the open edit first.')).toBeVisible()
      await card.getByRole('button', { name: /^View template/ }).press('2')
      await expect(page.getByTitle('Choose Record Scope · Article: one record per document')).toHaveCount(0)
      expect(await fixture.schemaRevisions()).toHaveLength(1)

      await openRailView(page, 'Template')
      await page.getByRole('button', { name: finish, exact: true }).click()
      await workspaceRail(page).getByRole('button', { name: 'Back to chat' }).click()
      await expect(card.getByRole('button', { name: /^Article:/ })).toBeEnabled()
      await expect(card.getByRole('button', { name: /^Catalog:/ })).toBeEnabled()
      await expect(card.getByText('Save or Cancel the open edit first.')).toHaveCount(0)
      await card.getByRole('button', { name: /^Article:/ }).click()
      await expect(workspaceRail(page).getByRole('button', { name: /^Open template: .* · Article$/ })).toBeVisible()
      await expect.poll(async () => (await fixture.schemaRevisions()).length).toBeGreaterThan(1)
    } finally {
      await fixture.close()
    }
  })
}
