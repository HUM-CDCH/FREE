import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import {
  DEMO_DOCUMENT_ID,
  DEMO_PROJECT_ID,
  DEMO_REPRESENTATION_ID,
  projectContextFixture,
} from '../api/project_contexts.fixture.js'
import { createGetDocumentReopen } from '../api/document_reopen.js'

const sourcePdf = fileURLToPath(
  new URL('../../../examples/Beretning_Ellekilde_8_13.pdf', import.meta.url),
)

/** The persisted reads Studio would serve from PostgreSQL. */
async function stubPersistedReads(page: import('@playwright/test').Page) {
  const store = projectContextFixture()
  // The real handler composes the DTO, so the browser reads the shipped contract.
  const reopen = createGetDocumentReopen(store)
  await page.route('**/api/project-contexts**', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (pathname.endsWith('/reopen')) {
      const response = await reopen(new Request(route.request().url()))
      return route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: await response.text(),
      })
    }
    const id = pathname.split('/').at(-1)
    await route.fulfill({
      json:
        id === 'project-contexts'
          ? { projectContexts: await store.listProjectContexts(20) }
          : await store.getProjectContextWithDocuments(id!),
    })
  })
}

test('opens a seeded Project Context and returns with browser navigation', async ({
  page,
}) => {
  await stubPersistedReads(page)

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

test('reopens a routed Source Document from its durable snapshot on refresh', async ({
  page,
}) => {
  await stubPersistedReads(page)
  // The representation-pinned resources, without PostgreSQL or the Parsing Service.
  const requested: string[] = []
  await page.route('**/api/source-representations/**', (route) => {
    const path = new URL(route.request().url()).pathname
    requested.push(path)
    const immutable = { 'cache-control': 'private, max-age=31536000, immutable' }
    if (path.endsWith('/pdf'))
      return route.fulfill({
        path: sourcePdf,
        contentType: 'application/pdf',
        headers: immutable,
      })
    return route.fulfill({
      body: '# Beretning\n\nGrav 8',
      contentType: 'text/markdown; charset=utf-8',
      headers: immutable,
    })
  })

  await page.goto(`/projects/${DEMO_PROJECT_ID}/documents/${DEMO_DOCUMENT_ID}`)

  const workspace = page.getByRole('region', { name: 'Studio workspace' })
  await expect(
    workspace.getByText('Beretning_Ellekilde_8_13.pdf').first(),
  ).toBeVisible()
  await expect(page.getByText(/pages · text highlights only/)).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByText('Indexing document…')).toBeHidden()
  await expect(page.getByText('Indexing failed')).toBeHidden()
  await expect(
    page.getByRole('button', {
      name: 'Beretning_Ellekilde_8_13.pdf',
      exact: true,
    }),
  ).toHaveAttribute('aria-current', 'page')
  // Both artifacts came from the reopened representation, same-origin.
  expect(requested).toContain(
    `/api/source-representations/${DEMO_REPRESENTATION_ID}/pdf`,
  )
  expect(requested).toContain(
    `/api/source-representations/${DEMO_REPRESENTATION_ID}/markdown`,
  )
})
