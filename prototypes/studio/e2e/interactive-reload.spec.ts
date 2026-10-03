import { expect, test, type Page } from '@playwright/test'
import { loginResearcher } from './auth.js'
import { prepareInteractiveDocument, type InteractiveDocument } from './interactiveStack.js'

// One DBOS-backed Studio, one scripted model per test: the specs share the worker's database and run one at a time.
test.describe.configure({ mode: 'serial' })

const extractionDatabaseReady = () =>
  Boolean(process.env.EXTRACTION_TEST_DATABASE_URL) && process.env.DATABASE_URL === process.env.EXTRACTION_TEST_DATABASE_URL

const TEMPLATE = '{"_description":"One catalogue entry.","heading":"string","year_of_record":"integer"}'
// Every field is named, so the edit workflow's bounded repair (a second model call) has nothing to ask for.
const RENAME_TITLE = '{"fields":{"title":{"name":"heading","type":"string","removed":false},"year":{"name":"year","type":"integer","removed":false}},"additions":[]}'
const STILL_WORKING = (instruction: string) => `Still working on an earlier request: “${instruction}”`

let stack: InteractiveDocument | undefined

test.beforeEach(() => {
  test.skip(!extractionDatabaseReady(), 'DATABASE_URL must equal the disposable EXTRACTION_TEST_DATABASE_URL')
})

test.afterEach(async () => {
  stack?.model.release()
  await stack?.close()
  stack = undefined
})

/** Regenerates the open schema with one instruction, through the schema actions menu's Regenerate dialog. */
async function regenerate(page: Page, instruction: string) {
  await page.getByRole('button', { name: 'Schema actions' }).click()
  await page.getByRole('menuitem', { name: 'Regenerate from the document…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Regenerate from the document' })
  const input = dialog.getByPlaceholder(/Add a generation instruction/)
  await input.fill(instruction)
  await input.press('Enter')
  await dialog.getByRole('button', { name: /Regenerate schema/ }).click()
}

/** Asks the edit chat for one change. */
async function requestEdit(page: Page, instruction: string) {
  const input = page.getByPlaceholder('Describe a change to the schema…')
  await input.fill(instruction)
  await input.press('Enter')
}

/** Edits the record description, which the workspace saves as a new revision after its debounce. */
async function describeRecord(page: Page, text: string) {
  const description = page.getByLabel('What one record is')
  await description.fill(text)
  await description.blur()
}

const revisionCount = () => stack!.schemaRevisions().then((revisions) => revisions.length)

test('a reload mid-suggestSchema finds the running generation and saves it onto its base @deterministic', async ({ page }) => {
  test.setTimeout(120_000)
  stack = await prepareInteractiveDocument(page, { hasKey: false })
  await stack.open()
  expect(await revisionCount()).toBe(1)
  stack.model.reply({ text: TEMPLATE, hold: true })

  await regenerate(page, 'Catalog entries')
  await stack.model.waitForCall(1, 30_000)
  await page.reload()

  await expect(page.getByText(STILL_WORKING('Catalog entries'))).toBeVisible({ timeout: 20_000 })
  stack.model.release()

  await expect(page.getByText('heading', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await expect.poll(revisionCount, { timeout: 20_000 }).toBe(2)
  expect(stack.model.calls()).toHaveLength(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a reloaded page drops a finished generation when newer work exists @deterministic', async ({ browser, page }) => {
  test.setTimeout(120_000)
  stack = await prepareInteractiveDocument(page, { hasKey: false })
  await stack.open()
  stack.model.reply({ text: TEMPLATE, hold: true })
  await regenerate(page, 'Catalog entries')
  await stack.model.waitForCall(1, 30_000)
  await page.reload()
  await expect(page.getByText(STILL_WORKING('Catalog entries'))).toBeVisible({ timeout: 20_000 })

  // Newer work from another tab of the same account: a second revision lands while the generation runs.
  const otherContext = await browser.newContext()
  const other = await otherContext.newPage()
  await loginResearcher(other, stack.objectId)
  await stack.open(other)
  await describeRecord(other, 'One edited record.')
  await expect.poll(revisionCount, { timeout: 20_000 }).toBe(2)
  await otherContext.close()

  stack.model.release()

  await expect(page.getByText(STILL_WORKING('Catalog entries'))).toHaveCount(0, { timeout: 20_000 })
  // The generation's base moved: it is dropped, the page adopts the newer revision and shows no error.
  await expect(page.getByLabel('What one record is')).toHaveValue('One edited record.', { timeout: 20_000 })
  await page.waitForTimeout(3_000)
  expect(await revisionCount()).toBe(2)
  await expect(page.getByText('heading', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a surviving tab keeps saving through its acknowledged head, including edits during generation @deterministic', async ({ page }) => {
  test.setTimeout(120_000)
  stack = await prepareInteractiveDocument(page, { hasKey: false })
  await stack.open()
  stack.model.reply({ text: TEMPLATE, hold: true })
  await regenerate(page, 'Catalog entries')
  await stack.model.waitForCall(1, 30_000)

  await describeRecord(page, 'One edited record.')
  await expect.poll(revisionCount, { timeout: 20_000 }).toBe(2)

  stack.model.release()

  await expect(page.getByText('heading', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await expect.poll(revisionCount, { timeout: 20_000 }).toBe(3)
  await expect(page.getByText('The Current Schema Revision changed elsewhere.')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a reload mid-proposeSchemaEdit reopens the review bar; Discard persists across another reload @deterministic', async ({ page }) => {
  test.setTimeout(120_000)
  stack = await prepareInteractiveDocument(page, { hasKey: false })
  await stack.open()
  stack.model.reply({ text: RENAME_TITLE, hold: true })

  await requestEdit(page, 'Rename title to heading')
  await stack.model.waitForCall(1, 30_000)
  await page.reload()

  await expect(page.getByText(STILL_WORKING('Rename title to heading'))).toBeVisible({ timeout: 20_000 })
  stack.model.release()

  await expect(page.getByRole('button', { name: 'Apply changes' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('heading', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByRole('button', { name: 'Apply changes' })).toHaveCount(0)

  await page.reload()
  await stack.open()
  await page.waitForTimeout(3_000)
  await expect(page.getByRole('button', { name: 'Apply changes' })).toHaveCount(0)
  await expect(page.getByText(STILL_WORKING('Rename title to heading'))).toHaveCount(0)
  expect(stack.model.calls()).toHaveLength(1)
})
