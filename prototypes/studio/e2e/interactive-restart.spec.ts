import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import { STUDIO_BOOT_HEADER } from '../shared/studioBoot.js'
import { plantedKey } from '../test/support/plantedKey.js'
import { E2E_ORIGIN, e2eStudioPath } from './auth.js'
import { prepareInteractiveDocument, type InteractiveDocument } from './interactiveStack.js'
import { killStudio } from './studioRestart.js'

// One restartable Studio (playwright.recovery.config.ts): the specs kill it under an open page, one at a time.
test.describe.configure({ mode: 'serial' })

const TEMPLATE = '{"_description":"One catalogue entry.","heading":"string","year_of_record":"integer"}'
const RENAME_TITLE = '{"fields":{"title":{"name":"heading","type":"string","removed":false},"year":{"name":"year","type":"integer","removed":false}},"additions":[]}'
const STILL_WORKING = (instruction: string) => `Still working on an earlier request: “${instruction}”`
const pathOf = (url: string) => new URL(url).pathname

let stack: InteractiveDocument | undefined

test.afterEach(async () => {
  stack?.model.release()
  await stack?.close()
  stack = undefined
})

async function regenerate(page: Page, instruction: string) {
  await page.getByRole('button', { name: 'Schema actions' }).click()
  await page.getByRole('menuitem', { name: 'Regenerate from the document…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Regenerate from the document' })
  const input = dialog.getByPlaceholder(/Add a generation instruction/)
  await input.fill(instruction)
  await input.press('Enter')
  await dialog.getByRole('button', { name: /Regenerate schema/ }).click()
}

async function requestEdit(page: Page, instruction: string) {
  const input = page.getByPlaceholder('Describe a change to the schema…')
  await input.fill(instruction)
  await input.press('Enter')
}

/** Every API request the page makes, as `METHOD /api/path`, in order. */
function recordApiRequests(page: Page): string[] {
  const requests: string[] = []
  page.on('request', (request) => {
    const path = pathOf(request.url())
    if (path.startsWith('/api/')) requests.push(`${request.method()} ${path}`)
  })
  return requests
}

const revisionCount = () => stack!.schemaRevisions().then((revisions) => revisions.length)

test('a Studio restart with the page open resends the keys, and the recovered generation continues', async ({ page }) => {
  const key = plantedKey()
  stack = await prepareInteractiveDocument(page, { hasKey: true, key })
  const requests = recordApiRequests(page)
  await stack.open()
  // Two held replies: the call the dead Studio made, and the recovered step's call on the new one.
  stack.model.reply({ text: TEMPLATE, hold: true }, { text: TEMPLATE, hold: true })

  await regenerate(page, 'Catalog entries')
  const first = await stack.model.waitForCall(1, 30_000)
  expect(first.authorization === `Bearer ${key}`, 'the first call carried the key').toBe(true)

  const before = requests.length
  const killedAt = Date.now()
  const restart = await killStudio()
  console.log(`studio restart: vite ${restart.oldPid} -> ${restart.newPid}, answering after ${Date.now() - killedAt} ms`)

  // The page's repeated POST reaches the new Studio, keys first (spec, *Browser*).
  await expect.poll(() => requests.slice(before).filter((request) => request === 'POST /api/generate_schema').length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
  const after = requests.slice(before)
  expect(after.indexOf('PUT /api/model-keys')).toBeGreaterThanOrEqual(0)
  expect(after.indexOf('PUT /api/model-keys')).toBeLessThan(after.indexOf('POST /api/generate_schema'))

  // DBOS recovers the generation in the new process; its call carries the resent key.
  const recovered = await stack.model.waitForCall(2, 90_000)
  expect(recovered.authorization === `Bearer ${key}`, 'the recovered call carried the resent key').toBe(true)
  stack.model.release()

  await expect(page.getByText('heading', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(revisionCount, { timeout: 30_000 }).toBe(2)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a Studio restart between two polls: the reloaded page sees the new boot ID, resends the keys, and the recovered proposal continues', async ({ page }) => {
  const key = plantedKey()
  stack = await prepareInteractiveDocument(page, { hasKey: true, key })
  await stack.open()
  stack.model.reply({ text: RENAME_TITLE, hold: true }, { text: RENAME_TITLE, hold: true })

  await requestEdit(page, 'Rename title to heading')
  const first = await stack.model.waitForCall(1, 30_000)
  expect(first.authorization === `Bearer ${key}`, 'the first call carried the key').toBe(true)

  // The reloaded page polls the running proposal; every poll answers with the Studio process's boot ID.
  const firstListing = page.waitForResponse((response) => pathOf(response.url()) === '/api/model-operations')
  await page.reload()
  const firstBoot = (await firstListing).headers()[STUDIO_BOOT_HEADER.toLowerCase()]
  expect(firstBoot).toBeTruthy()
  await expect(page.getByText(STILL_WORKING('Rename title to heading'))).toBeVisible({ timeout: 20_000 })
  // The workspace finishes loading its document before Studio goes: a load cut mid-way is the page's bounded
  // "could not be opened" failure, which is not what this spec is about.
  await expect(page.getByText('/ 6', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('title', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(3_000) // the PDF worker and the rest of the document's loads (the polls never go idle)
  const requests = recordApiRequests(page)

  const restart = await killStudio()
  console.log(`studio restart: vite ${restart.oldPid} -> ${restart.newPid}`)

  // The next poll's response carries a new boot ID; the page hands its keys over again before anything else.
  const rebooted = await page.waitForResponse(
    (response) => pathOf(response.url()) === '/api/model-operations' && response.headers()[STUDIO_BOOT_HEADER.toLowerCase()] !== firstBoot,
    { timeout: 60_000 },
  )
  expect(rebooted.headers()[STUDIO_BOOT_HEADER.toLowerCase()]).not.toBe(firstBoot)
  await expect.poll(() => requests.includes('PUT /api/model-keys'), { timeout: 20_000 }).toBe(true)

  const recovered = await stack.model.waitForCall(2, 90_000)
  expect(recovered.authorization === `Bearer ${key}`, 'the recovered call carried the resent key').toBe(true)
  stack.model.release()

  await expect(page.getByRole('button', { name: 'Apply changes' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('heading', { exact: true }).first()).toBeVisible()
})

const execFileAsync = promisify(execFile)

/** Every file under `root`, read whole; a directory that does not exist yet holds nothing. */
async function filesUnder(root: string): Promise<{ path: string; bytes: Buffer }[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true })
  } catch {
    return []
  }
  const files = entries.filter((entry) => entry.isFile())
  return Promise.all(files.map(async (entry) => {
    const path = resolve(entry.parentPath, entry.name)
    return { path, bytes: await readFile(path) }
  }))
}

test('a planted key reaches no pg_dump, data volume or Studio log after a generation, an edit proposal, a batch suggestion and a probe', async ({ page }) => {
  const key = plantedKey()
  const echo = { 'x-echo': key }
  // A refused call whose body and headers echo the key back (how a provider leaks one); 401 is not retried by the SDK.
  const refusal = { status: 401, body: '{"error":"{{authorization}}"}', headers: echo }
  stack = await prepareInteractiveDocument(page, { hasKey: false })
  await stack.open()

  // The key is typed into the Model Configuration page for the scripted connection: the page probes with it (the
  // provider refuses the first probe, echoing the key back) and hands it to Studio; the configuration itself records
  // only that a key exists. Reopened, the page probes again with the stored key and the provider connects.
  const openConfiguration = async () => {
    await page.getByRole('button', { name: 'Configure models' }).click()
    const dialog = page.getByRole('dialog', { name: 'Model configuration' })
    await expect(dialog.getByRole('tab', { name: 'Models' })).toBeVisible({ timeout: 15_000 })
    await dialog.getByRole('tab', { name: /^Connections/ }).click()
    await dialog.getByRole('list', { name: 'Connections' }).getByRole('button', { name: 'Scripted model', exact: true }).click()
    return dialog
  }
  const dialog = await openConfiguration()
  const details = dialog.getByRole('region', { name: 'Connection details' })
  // The connection is keyless so far: the page's first probe carries no credential. The typed key's probe is refused.
  await expect.poll(() => stack!.model.probes().length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
  expect(stack.model.probes()[0]!.authorization).toBeNull()
  stack.model.replyModels(refusal)
  await details.getByLabel(/^API key/).fill(key)
  await expect(details.getByText('The provider rejected authentication.')).toBeVisible({ timeout: 15_000 })
  const handoff = page.waitForRequest((request) => pathOf(request.url()) === '/api/model-keys' && request.method() === 'PUT')
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await handoff
  await expect(dialog.getByText('Everything saved')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close Model Configuration' }).click()
  const reopened = await openConfiguration()
  await expect(reopened.getByRole('region', { name: 'Connection details' }).getByText(/^Connected\./)).toBeVisible({ timeout: 15_000 })
  await reopened.getByRole('button', { name: 'Close Model Configuration' }).click()
  const keyedProbes = stack.model.probes().slice(1)
  expect(keyedProbes.length).toBeGreaterThanOrEqual(2)
  for (const probe of keyedProbes) expect(probe.authorization === `Bearer ${key}`, 'every probe after the key was typed carried it').toBe(true)

  // An edit proposal on the seeded schema (whose field IDs the scripted envelope names): refused once, then proposed
  // and discarded.
  stack.model.reply(refusal, { text: RENAME_TITLE, headers: echo })
  await requestEdit(page, 'Rename title to heading')
  await expect(page.getByText(/^(Request failed|Error):/).first()).toBeVisible({ timeout: 30_000 })
  await requestEdit(page, 'Rename title to heading')
  await expect(page.getByRole('button', { name: 'Apply changes' })).toBeVisible({ timeout: 30_000 })
  expect(stack.model.calls()).toHaveLength(2)
  // The proposal stays open: Discard would delete its history before the sweep inspects it.

  // A generation: refused once (a new operation follows), then answered.
  stack.model.reply(refusal, { text: TEMPLATE, headers: echo })
  await regenerate(page, 'Catalog entries')
  await expect(page.getByRole('alert').filter({ hasText: 'Regeneration failed' })).toBeVisible({ timeout: 30_000 })
  await regenerate(page, 'Catalog entries')
  await expect(page.getByText('heading', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await expect.poll(revisionCount, { timeout: 20_000 }).toBe(2)
  expect(stack.model.calls()).toHaveLength(4)

  // A Batch Schema Suggestion over one document: refused once, then answered. A lone source needs no merge call.
  stack.model.reply(refusal, { text: TEMPLATE, headers: echo })
  const mutation = { headers: { origin: E2E_ORIGIN } } // Studio's CSRF check: mutations name the page's origin
  const created = await page.request.post(e2eStudioPath('/api/batch-schema-suggestions'), {
    ...mutation,
    data: { projectContextId: stack.projectContextId, sourceDocumentIds: [stack.sourceDocumentId] },
  })
  expect(created.status()).toBe(202)
  type SuggestionDto = { batchSchemaSuggestion: { batchSchemaSuggestionId: string; attempt: number; executionStatus: string; failure: { code: string } | null; proposal: unknown } }
  const { batchSchemaSuggestionId } = ((await created.json()) as SuggestionDto).batchSchemaSuggestion
  const suggestionUrl = e2eStudioPath(`/api/batch-schema-suggestions/${batchSchemaSuggestionId}?projectContextId=${stack.projectContextId}`)
  const suggestion = async () => ((await (await page.request.get(suggestionUrl)).json()) as SuggestionDto).batchSchemaSuggestion
  await expect.poll(async () => (await suggestion()).executionStatus, { timeout: 60_000 }).toBe('FAILED')
  const retried = await page.request.post(e2eStudioPath(`/api/batch-schema-suggestions/${batchSchemaSuggestionId}/retry?projectContextId=${stack.projectContextId}`), {
    ...mutation,
    data: { expectedAttempt: 1 },
  })
  expect(retried.ok()).toBe(true)
  await expect.poll(async () => (await suggestion()).executionStatus, { timeout: 60_000 }).toBe('COMPLETED')
  expect((await suggestion()).proposal).not.toBeNull()

  // Every model call carried the key, which is the only place it belongs on the server side of this test.
  expect(stack.model.calls()).toHaveLength(6)
  for (const call of stack.model.calls()) expect(call.authorization === `Bearer ${key}`, 'every model call carried the key').toBe(true)

  // The operations whose history the sweep must see: both edits (the refused one is a typed failure in a SUCCESS
  // workflow) and both generations, as the page lists them for this scope.
  const listing = await page.request.get(e2eStudioPath(`/api/model-operations?projectContextId=${stack.projectContextId}&extractionSchemaId=${stack.extractionSchemaId}`))
  expect(listing.ok()).toBe(true)
  const listed = ((await listing.json()) as { operations: { workflowId: string; kind: string }[] }).operations.map((operation) => operation.workflowId)
  expect(listed.filter((id) => id.startsWith('edit:'))).toHaveLength(2)
  expect(listed.filter((id) => id.startsWith('suggestion:'))).toHaveLength(2)

  // The sweep: the whole database, Studio's data directory and source inbox, and Studio's log. Nothing is printed.
  const dump = await execFileAsync('docker', [
    'compose', '-p', process.env.FREE_PLAYWRIGHT_COMPOSE_PROJECT!, '-f', resolve(import.meta.dirname, 'playwright.compose.yaml'),
    'exec', '-T', 'postgres', 'pg_dump', '-U', 'free_e2e', process.env.FREE_PLAYWRIGHT_DATABASE_NAME!,
  ], { maxBuffer: 512 * 1024 * 1024 })
  expect(dump.stdout.length).toBeGreaterThan(10_000)
  expect(dump.stdout.includes(key)).toBe(false)
  // The dump does see what the operations wrote: every listed operation's history is in it.
  for (const id of listed) expect(dump.stdout.includes(id), `the dump holds ${id}`).toBe(true)

  const files = await filesUnder(process.env.FREE_PLAYWRIGHT_RECOVERY_STATE!)
  expect(files.length).toBeGreaterThan(0)
  expect(files.filter((file) => file.bytes.includes(key)).map((file) => file.path)).toEqual([])

  const log = await readFile(process.env.FREE_PLAYWRIGHT_STUDIO_LOG!, 'utf8')
  expect(log.length).toBeGreaterThan(0)
  expect(log.includes(key)).toBe(false)

  // The regeneration replaced the draft the proposal was for, so its review bar is already gone; nothing was discarded
  // before the sweep, and the edit histories were in the dump.
  await expect(page.getByRole('button', { name: 'Apply changes' })).toHaveCount(0)
})
