import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { projectContextFixture } from '../api/project_contexts.fixture.js'

const sourceDocument = fileURLToPath(
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
  await page.route('**/api/project-contexts**', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)
    await route.fulfill({
      json:
        id === 'project-contexts'
          ? { projectContexts: await store.listProjectContexts(20) }
          : await store.getProjectContextWithDocuments(id!),
    })
  })
  await page.route('http://127.0.0.1:8000/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/tasks') return route.fulfill({ json: { task_id: 'evidence-source-document' } })
    if (path.endsWith('/markdown')) return route.fulfill({ body: '# Source Document\n\nGrav 8' })
    if (path.endsWith('/document')) return route.fulfill({ body: parsedDocument, contentType: 'application/json' })
    return route.fulfill({ json: { status: 'completed' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Ellekilde, TAK 1355' }).click()
  await page.getByLabel('Open a PDF (dev)').setInputFiles(sourceDocument)
  await expect(page.getByText('6 pages · text highlights only')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('iframe[title="Pinned Source Document"]')).toHaveCount(0)
  await expect(page.locator('.pdfViewer .page')).toHaveCount(6)
  await page.getByRole('tab', { name: /Evidence/ }).click()
  await expect(page.getByRole('heading', { name: 'Source Evidence' })).toBeVisible()
  await expect(page.getByText('Physical page 1')).toBeVisible()
  await page.getByRole('button', { name: /Evidence anchor bundled-anchor/ }).click()
})

test('application editors retain clipboard and keyboard ownership with a stale PDF selection @deterministic', async ({
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
  await page.route('**/api/generate_schema', (route) =>
    route.fulfill({ json: schemaResponse }),
  )
  await page.route('http://127.0.0.1:8000/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/tasks')
      return route.fulfill({ json: { task_id: 'dev-source-document' } })
    if (path.endsWith('/markdown'))
      return route.fulfill({ body: '# Source Document\n\nGrav 8' })
    if (path.endsWith('/document'))
      return route.fulfill({ body: parsedDocument, contentType: 'application/json' })
    return route.fulfill({ json: { status: 'completed' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Ellekilde, TAK 1355' }).click()
  await page.getByLabel('Open a PDF (dev)').setInputFiles(sourceDocument)
  await expect(page.getByText('6 pages · text highlights only')).toBeVisible({
    timeout: 15_000,
  })

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

  const annotation = page.locator('.highlightEditor.selectedEditor')
  await expect(annotation).toHaveCount(1)
  await expect(
    page.getByLabel('Annotations, chat and schema').getByText('"Grav 8"'),
  ).toBeVisible()

  const pdfCopy = await annotation.evaluate((target) => {
    const clipboardData = new DataTransfer()
    const event = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData,
    })
    target.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(pdfCopy).toBe(true)

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

  await expect(page.locator('.highlightEditor')).toHaveCount(1)
  await expect(page.getByRole('tab', { name: 'Annot. 1' })).toBeVisible()
})
