import { expect, test } from '@playwright/test'
import { gotoAuthenticated } from './auth.js'

test('an authenticated Researcher reaches the empty workspace shell', async ({
  page,
}) => {
  await page.route('**/api/project-contexts**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: { projectContexts: [] },
    }),
  )

  await gotoAuthenticated(page, '/')

  await expect(
    page.getByRole('heading', { name: 'No project open' }),
  ).toBeVisible()
  await expect(page.getByText('Workspace unavailable')).toHaveCount(0)
})
