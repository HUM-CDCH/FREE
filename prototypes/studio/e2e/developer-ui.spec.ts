import { expect, test } from '@playwright/test'
import { activateWithKeyboard } from './accessibility.js'
import { gotoAuthenticated } from './auth.js'

const operations = [
  'chat',
  'extraction',
  'schema-edit',
  'schema-suggestion',
] as const

test.skip(
  process.env.FREE_PLAYWRIGHT_DEVELOPER_UI !== '1',
  'The LLM inspector is exercised only by the isolated developer-UI profile.',
)

test('developer inspector is ordered, redacted, copyable, clearable, and modal @deterministic', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage()
  let clears = 0
  let traces = operations.map((operation, index) => ({
    id: `trace-${index}`,
    operation,
    provider: 'fixture-provider',
    model: 'fixture-model',
    profile: 'general',
    startedAt: `2026-08-24T12:00:0${3 - index}.000Z`,
    completedAt: `2026-08-24T12:00:0${3 - index}.010Z`,
    status: index === 1 ? 'failed' : 'complete',
    request: `${operation} request with [REDACTED_PATH] and [REDACTED]`,
    response:
      index === 1
        ? 'Provider failure with [REDACTED_HASH]'
        : `${operation} response`,
  }))
  await page.route('**/api/project-contexts**', (route) =>
    route.fulfill({ contentType: 'application/json', json: { projectContexts: [] } }),
  )
  await page.route('**/api/llm_inspector', (route) => {
    if (route.request().method() === 'DELETE') {
      clears += 1
      traces = []
      return route.fulfill({ status: 204, body: '' })
    }
    return route.fulfill({ contentType: 'application/json', json: { traces } })
  })
  await gotoAuthenticated(page, '/')

  const launcher = page.getByRole('button', { name: 'Inspect LLM messages' })
  await activateWithKeyboard(page, launcher)
  const dialog = page.getByRole('dialog', { name: 'LLM message inspector' })
  const close = dialog.getByRole('button', { name: 'Close LLM inspector' })
  await expect(close).toBeFocused()
  await expect(dialog.getByText('Live', { exact: true })).toBeVisible()
  const calls = dialog
    .getByRole('navigation', { name: 'LLM calls' })
    .getByRole('button')
  await expect(calls).toHaveCount(operations.length)
  for (const [index, operation] of operations.entries())
    await expect(calls.nth(index)).toHaveAccessibleName(
      new RegExp(`^${operation}\\b`),
    )
  const text = await dialog.textContent()
  for (const forbidden of [
    'credential-secret',
    'C:\\private',
    '/tmp/private',
    'a'.repeat(64),
  ])
    expect(text).not.toContain(forbidden)
  await page.screenshot({
    path: testInfo.outputPath('developer-inspector.png'),
    fullPage: true,
  })

  const requestPayload = traces[0]!.request
  await activateWithKeyboard(
    page,
    dialog.getByRole('button', { name: 'Copy' }).first(),
  )
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    requestPayload,
  )

  await activateWithKeyboard(page, dialog.getByRole('button', { name: 'Clear' }))
  await expect(dialog.getByText(/No provider calls yet/)).toBeVisible()
  expect(clears).toBe(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(launcher).toBeFocused()

  await activateWithKeyboard(page, launcher)
  const reopened = page.getByRole('dialog', { name: 'LLM message inspector' })
  await reopened.click({ position: { x: 2, y: 2 } })
  await expect(reopened).toBeHidden()
  await expect(launcher).toBeFocused()
  await context.close()
})
