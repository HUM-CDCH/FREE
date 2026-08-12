import { expect, test } from '@playwright/test'
import {
  DEMO_PROJECT_ID,
  projectContextFixture,
} from '../api/project_contexts.fixture.js'

test('opens a seeded Project Context and returns with browser navigation', async ({
  page,
}) => {
  const store = projectContextFixture()
  await page.route('**/api/project-contexts**', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)
    await route.fulfill({
      json:
        id === 'project-contexts'
          ? { projectContexts: await store.listProjectContexts(20) }
          : await store.getProjectContextWithDocuments(id!),
    })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Ellekilde, TAK 1355' }).click()
  await expect(page).toHaveURL(`/projects/${DEMO_PROJECT_ID}`)
  await expect(page.getByText('Beretning_Ellekilde_8_13.pdf')).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL('/')
  await expect(
    page.getByRole('heading', { name: 'Project Contexts' }),
  ).toBeVisible()
})
