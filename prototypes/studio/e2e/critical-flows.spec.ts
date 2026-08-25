import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createGetDocumentReopen } from '../api/document_reopen.js'
import { createGetProjectContexts } from '../api/project_contexts.js'
import { projectContextFixture } from '../api/project_contexts.fixture.js'
import { gotoAuthenticated } from './auth.js'
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

const schemaResponse = {
  template: { _description: 'One grave record.', graves: [{ name: 'verbatim-string' }] },
  raw: '...',
  pages: 6,
}

test('bundled parsed document renders its page-scoped PDF @deterministic', async ({ page }) => {
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
  await gotoAuthenticated(page, '/')
  await activateWithKeyboard(
    page,
    page.getByRole('button', {
      name: /Source Documents in Ellekilde, TAK 1355$/,
    }),
  )
  await activateWithKeyboard(
    page,
    page.getByRole('navigation', { name: 'Project Contexts' }).getByRole('button', { name: 'Beretning_Ellekilde_8_13.pdf' }),
  )
  await expect(page.getByText('6 pages', { exact: true })).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.locator('iframe[title="Pinned Source Document"]')).toHaveCount(0)
  await expect(page.locator('.pdfViewer .page')).toHaveCount(6)
})

test('schema instruction editor retains clipboard ownership in a reopened Source Document @deterministic', async ({
  page,
}) => {
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
      return route.fulfill({
        body: '# Source Document\n\nGrav 8',
        contentType: 'text/markdown',
      })
    },
  )
  await page.route('**/api/generate_schema', (route) =>
    route.fulfill({ json: schemaResponse }),
  )
  await page.route('**/api/schema-revisions', (route) => {
    const { recordDescription, schemaNodes } = route.request().postDataJSON() as {
      recordDescription: string
      schemaNodes: unknown[]
    }
    return route.fulfill({
      status: 201,
      json: {
        revision: {
          schemaRevisionId: '00000000-0000-4000-8000-0000000000e2',
          extractionSchemaId: '00000000-0000-4000-8000-0000000000e1',
          revisionNumber: 1,
          origin: 'suggestion',
          createdAt: '2026-08-12T10:00:00.000Z',
          recordDescription,
          schemaNodes,
        },
      },
    })
  })
  await gotoAuthenticated(page, '/')
  await activateWithKeyboard(
    page,
    page.getByRole('button', {
      name: /Source Documents in Ellekilde, TAK 1355$/,
    }),
  )
  await activateWithKeyboard(
    page,
    page.getByRole('navigation', { name: 'Project Contexts' }).getByRole('button', { name: 'Beretning_Ellekilde_8_13.pdf' }),
  )
  await expect(page.getByText('6 pages', { exact: true })).toBeVisible({
    timeout: 15_000,
  })

  // Highlight-on-selection is disabled (HIGHLIGHT_ANNOTATIONS_ENABLED in
  // App.tsx) so native copy/paste works; selecting PDF text is a stale
  // selection that must not steal clipboard/keyboard ownership from the
  // app's own editors below.
  const text = page
    .locator('.textLayer span')
    .filter({ hasText: 'Grav 8' })
    .first()
  const box = await text.boundingBox()
  if (!box) throw new Error('PDF text was not rendered')
  await page.mouse.move(box.x + 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, {
    steps: 8,
  })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toContain('Grav 8')

  const chatInput = page.getByPlaceholder(
    /Add a generation instruction/,
  )
  const canceled = await chatInput.evaluate((target) =>
    ['copy', 'cut', 'paste'].map((type) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', 'clipboard text')
      const event = new ClipboardEvent(type, {
        bubbles: true,
        cancelable: true,
        clipboardData,
      })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }),
  )
  expect(canceled).toEqual([false, false, false])

  await chatInput.focus()
  await page.keyboard.type('Extract the grave name')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Extract the grave name', { exact: true })).toBeVisible()
  await activateWithKeyboard(
    page,
    page.getByRole('button', { name: 'Generate schema' }),
  )
  await expect(page.getByText('graves', { exact: true })).toBeVisible()

  await expect(page.locator('.highlightEditor')).toHaveCount(0)
})
