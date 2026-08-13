import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createGetDocumentReopen } from '../api/document_reopen.js'
import { createGetProjectContexts } from '../api/project_contexts.js'
import { projectContextFixture } from '../api/project_contexts.fixture.js'

const sourcePdf = fileURLToPath(
  new URL('../../../examples/Beretning_Ellekilde_8_13.pdf', import.meta.url),
)
const parsedDocument = await readFile(
  fileURLToPath(new URL('../src/assets/parsed_document.v2.json', import.meta.url)),
  'utf8',
)

const schemaResponse = {
  template: { _description: 'One grave record.', graves: [{ name: 'verbatim-string' }] },
  raw: '...',
  pages: 6,
}

test('bundled parsed document exposes page-scoped source Evidence @deterministic', async ({ page }) => {
  const store = projectContextFixture()
  const projectContexts = createGetProjectContexts(store)
  const reopen = createGetDocumentReopen(store)
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
  await page.route('**/api/source-representations/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/pdf'))
      return route.fulfill({ path: sourcePdf, contentType: 'application/pdf' })
    if (path.endsWith('/source'))
      return route.fulfill({ body: parsedDocument, contentType: 'application/json' })
    return route.fulfill({ body: '# Source Document\n\nGrav 8' })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Ellekilde, TAK 1355', exact: true }).click()
  await page.getByRole('button', { name: 'Beretning_Ellekilde_8_13.pdf' }).click()
  await expect(page.getByText('6 pages · text highlights only')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('iframe[title="Pinned Source Document"]')).toHaveCount(0)
  await expect(page.locator('.pdfViewer .page')).toHaveCount(6)
  await page.getByRole('tab', { name: /Evidence/ }).click()
  await expect(page.getByRole('heading', { name: 'Source Evidence' })).toBeVisible()
  await expect(page.getByText('Physical page 1')).toBeVisible()
  await page.getByRole('button', { name: /Evidence anchor bundled-anchor/ }).click()
})

test('application editors retain clipboard and keyboard ownership in a reopened Source Document @deterministic', async ({
  page,
}) => {
  const store = projectContextFixture()
  const projectContexts = createGetProjectContexts(store)
  const reopen = createGetDocumentReopen(store)
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
  await page.route('**/api/source-representations/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/pdf'))
      return route.fulfill({ path: sourcePdf, contentType: 'application/pdf' })
    if (path.endsWith('/source'))
      return route.fulfill({ body: parsedDocument, contentType: 'application/json' })
    return route.fulfill({ body: '# Source Document\n\nGrav 8', contentType: 'text/markdown' })
  })
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
  await page.goto('/')
  await page.getByRole('button', { name: 'Ellekilde, TAK 1355', exact: true }).click()
  await page.getByRole('button', { name: 'Beretning_Ellekilde_8_13.pdf' }).click()
  await expect(page.getByText('6 pages · text highlights only')).toBeVisible({
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

  await page.getByRole('tab', { name: 'Chat' }).click()
  const chatInput = page.getByPlaceholder('Ask about this source document...')
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

  await page.getByRole('tab', { name: 'Schema' }).click()
  await page.getByRole('button', { name: 'Generate schema' }).click()
  await page.getByRole('button', { name: 'JSON' }).click()
  await page.getByRole('button', { name: 'Edit' }).click()

  const textarea = page.locator('textarea')
  const originalJson = await textarea.inputValue()
  const isMac = await page.evaluate(() => navigator.platform.startsWith('Mac'))
  await textarea.press(isMac ? 'Meta+A' : 'Control+A')
  await expect
    .poll(() =>
      textarea.evaluate((element) => {
        if (!(element instanceof HTMLTextAreaElement))
          throw new Error('Expected a textarea')
        return {
          start: element.selectionStart,
          end: element.selectionEnd,
          length: element.value.length,
        }
      }),
    )
    .toEqual({
      start: 0,
      end: originalJson.length,
      length: originalJson.length,
    })

  await textarea.press('Backspace')
  await expect(textarea).toHaveValue('')
  await textarea.press(isMac ? 'Meta+Z' : 'Control+Z')
  await expect(textarea).toHaveValue(originalJson)
  await textarea.press(isMac ? 'Meta+Shift+Z' : 'Control+Y')
  await expect(textarea).toHaveValue('')

  await expect(page.locator('.highlightEditor')).toHaveCount(0)
})
