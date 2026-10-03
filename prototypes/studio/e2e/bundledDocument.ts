import { expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createGetDocumentReopen } from '../api/document_reopen.js'
import { createGetProjectContexts } from '../api/project_contexts.js'
import { projectContextFixture } from '../api/project_contexts.fixture.js'
import { activateWithKeyboard } from './accessibility.js'

const sourcePdf = fileURLToPath(
  new URL('../../../examples/Beretning_Ellekilde_8_13.pdf', import.meta.url),
)
const parsedDocument = await readFile(
  fileURLToPath(new URL('../src/assets/parsed_document.v2.json', import.meta.url)),
  'utf8',
)

const emptyExtractions = {
  async readDocumentExtractions() {
    return null
  },
}

/** Serves the bundled Ellekilde project and its page-scoped PDF from fixtures. */
export async function routeBundledDocument(page: Page): Promise<void> {
  const store = projectContextFixture()
  const projectContexts = createGetProjectContexts(store)
  const reopen = createGetDocumentReopen(store, emptyExtractions)
  await page.route('**/api/project-contexts**', async (route) => {
    const request = new Request(route.request().url())
    const response = await (request.url.endsWith('/reopen')
      ? reopen(request)
      : projectContexts(request))
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    })
  })
  await page.route(
    '**/api/project-contexts/*/source-representations/**',
    (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/pdf'))
        return route.fulfill({ path: sourcePdf, contentType: 'application/pdf' })
      if (path.endsWith('/source'))
        return route.fulfill({
          body: parsedDocument,
          contentType: 'application/json',
        })
      return route.fulfill({ body: '# Source Document\n\nGrav 8' })
    },
  )
}

/** Opens the bundled Source Document from the signed-in workspace and waits for its page count. */
export async function openBundledDocument(page: Page): Promise<void> {
  await activateWithKeyboard(
    page,
    page.getByRole('button', {
      name: /Source Documents in Ellekilde, TAK 1355$/,
    }),
  )
  await activateWithKeyboard(
    page,
    page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Beretning_Ellekilde_8_13.pdf' }),
  )
  await expect(page.getByText('/ 6', { exact: true })).toBeVisible({
    timeout: 15_000,
  })
}
