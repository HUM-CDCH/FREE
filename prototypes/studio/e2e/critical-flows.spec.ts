import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { projectContextFixture } from '../api/project_contexts.fixture.js'

const sourceDocument = fileURLToPath(
  new URL('../../../examples/Beretning_Ellekilde_8_13.pdf', import.meta.url),
)

const schemaResponse = {
  template: { graves: [{ name: 'verbatim-string' }] },
  raw: '...',
  pages: 6,
}

async function openSourceDocument(page: Page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
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
    return route.fulfill({ json: { status: 'completed' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Ellekilde, TAK 1355' }).click()
  await page.getByLabel('Open a PDF (dev)').setInputFiles(sourceDocument)
  await expect(page.getByText('6 pages - text highlights only')).toBeVisible({
    timeout: 15_000,
  })
}

async function selectionRect(page: Page) {
  return page.evaluate(() => {
    const rect = window.getSelection()?.getRangeAt(0)?.getBoundingClientRect()
    return rect ? { top: rect.top, bottom: rect.bottom } : null
  })
}

test('select-first highlight keeps PDF text selection and native clipboard working @deterministic', async ({
  page,
}) => {
  await openSourceDocument(page)

  const text = page
    .locator('.textLayer span')
    .filter({ hasText: 'Grav 8' })
    .first()
  const box = await text.boundingBox()
  if (!box) throw new Error('PDF text was not rendered')

  // A plain drag selects PDF text natively — no highlight editor is created yet.
  await page.mouse.move(box.x + 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, {
    steps: 8,
  })
  await page.mouse.up()
  await expect(page.locator('.highlightEditor')).toHaveCount(0)
  const highlightButton = page.getByRole('button', {
    name: 'Highlight',
    exact: true,
  })
  await expect(highlightButton).toBeVisible()
  const selectionText = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(selectionText).toContain('Grav 8')

  // The button sits below the selection for a downward drag, clear of Chrome's
  // native copy menu which appears at the selection anchor (drag start).
  const rectAfterForwardDrag = await selectionRect(page)
  const buttonAfterForwardDrag = await highlightButton.boundingBox()
  if (!rectAfterForwardDrag || !buttonAfterForwardDrag)
    throw new Error('Missing selection or button box')
  expect(buttonAfterForwardDrag.y).toBeGreaterThanOrEqual(
    rectAfterForwardDrag.bottom - 1,
  )

  // Copying the selected PDF text works natively.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C')
  const copiedPdfText = await page.evaluate(() =>
    navigator.clipboard.readText().catch(() => '<unreadable>'),
  )
  expect(copiedPdfText).toContain('Grav 8')

  // The floating Highlight button converts the selection into an annotation.
  await highlightButton.click()
  await expect(page.locator('.highlightEditor')).toHaveCount(1)
  await expect(page.getByLabel('Annotations, chat and schema').getByText(/Grav 8/)).toBeVisible()
  await expect(highlightButton).toHaveCount(0)

  await page.getByRole('tab', { name: 'Chat' }).click()
  const chatInput = page.getByPlaceholder('Ask about this source document...')
  await chatInput.fill('native clipboard')
  await chatInput.evaluate((element) => {
    const input = element as HTMLInputElement
    input.select()
  })
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C')
  const copiedInputText = await page.evaluate(() =>
    navigator.clipboard.readText().catch(() => '<unreadable>'),
  )
  expect(copiedInputText).toBe('native clipboard')

  await chatInput.fill('')
  await page.evaluate(() => navigator.clipboard.writeText('pasted into chat'))
  await chatInput.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
  await expect(chatInput).toHaveValue('pasted into chat')

  await page.getByRole('tab', { name: 'Schema' }).click()
  await page.getByRole('button', { name: 'Generate schema' }).click()
  await page.getByRole('button', { name: 'JSON' }).click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()

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

test('floating Highlight button flips above the selection for an upward drag @deterministic', async ({
  page,
}) => {
  await openSourceDocument(page)

  const text = page
    .locator('.textLayer span')
    .filter({ hasText: 'Grav 8' })
    .first()
  const box = await text.boundingBox()
  if (!box) throw new Error('PDF text was not rendered')

  // Drag upward: Chrome's native copy menu appears at the selection anchor
  // (drag start) below, so the Highlight button must sit above it instead.
  await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 2, box.y + 2, { steps: 8 })
  await page.mouse.up()

  const highlightButton = page.getByRole('button', {
    name: 'Highlight',
    exact: true,
  })
  await expect(highlightButton).toBeVisible()
  const rectAfterBackwardDrag = await selectionRect(page)
  const buttonAfterBackwardDrag = await highlightButton.boundingBox()
  if (!rectAfterBackwardDrag || !buttonAfterBackwardDrag)
    throw new Error('Missing selection or button box')
  expect(buttonAfterBackwardDrag.y + buttonAfterBackwardDrag.height).toBeLessThanOrEqual(
    rectAfterBackwardDrag.top + 1,
  )
})
