import { expect, test } from '@playwright/test'

const schemaResponse = {
  template: { graves: [{ name: 'verbatim-string' }] },
  raw: '...',
  pages: 6,
}

test('application editors retain clipboard and keyboard ownership with a stale PDF selection @deterministic', async ({
  page,
}) => {
  await page.route('**/api/generate_schema', (route) =>
    route.fulfill({ json: schemaResponse }),
  )
  await page.goto('/studio')
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
  await chatInput.fill('native clipboard')
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
