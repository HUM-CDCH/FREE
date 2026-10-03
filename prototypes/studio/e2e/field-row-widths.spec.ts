import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DEVELOPMENT_ENTRA_TENANT_ID } from '../server/entraIdentityProvider.js'
import { loginResearcher } from './auth.js'

// §6 field rows at the rail's minimum (264px) and default (344px) widths, measured in a real browser: every row's name,
// pills and three 28px actions sit inside the schema list, nothing scrolls sideways, and Tab reaches the actions.

const SIX = (values: string) => values.split(' ')
const schemaNodes = [
  { id: 'title', name: 'title', type: 'string', description: 'The report title as printed on its cover page.' },
  { id: 'context', name: 'archaeological_context', type: 'string', allowedValues: SIX('grave settlement hoard ritual production unknown') },
  { id: 'sex', name: 'sex', type: 'string', allowedValues: SIX('f m unknown child adult elder') },
  { id: 'findings', name: 'findings', type: 'array', children: [
    { id: 'kind', name: 'kind', type: 'string', allowedValues: SIX('pottery bone metal glass stone wood') },
    { id: 'deposit', name: 'deposit', type: 'object', children: [
      { id: 'layer', name: 'layer', type: 'string', allowedValues: SIX('topsoil fill floor cut natural unknown') },
    ] },
  ] },
] as const
/** Every field, root to depth 2; all groups start open. */
const rows = ['title', 'archaeological_context', 'sex', 'findings', 'kind', 'deposit', 'layer']

const pdfPath = fileURLToPath(new URL('../../../examples/1790-06-17-1.pdf', import.meta.url))
const parsedDocumentPath = fileURLToPath(new URL('../src/assets/parsed_document.v2.json', import.meta.url))

/** The same disposable-stack gate `canonical-evidence-lifecycle.spec.ts` uses. */
const withoutDatabase =
  !process.env.EXTRACTION_TEST_DATABASE_URL ||
  process.env.DATABASE_URL !== process.env.EXTRACTION_TEST_DATABASE_URL

const id = {
  account: randomUUID(), object: randomUUID(), project: randomUUID(), document: randomUUID(),
  representation: randomUUID(), schema: randomUUID(),
}

test.beforeAll(async () => {
  if (withoutDatabase) return
  const { db } = await import('../../../packages/db/src/prisma/db.js')
  await db.orm.public.ResearcherAccount.create({
    id: id.account, tenantId: DEVELOPMENT_ENTRA_TENANT_ID, objectId: id.object, displayName: 'Field Row Researcher',
  })
  await db.orm.public.ProjectContext.create({ id: id.project, researcherAccountId: id.account, name: 'Field row widths E2E' })
  await db.orm.public.SourceDocument.create({
    id: id.document, projectContextId: id.project, contentSha256: 'c'.repeat(64), mediaType: 'application/pdf',
    originalName: '1790-06-17-1.pdf',
  })
  await db.orm.public.SourceRepresentationRevision.create({
    id: id.representation, sourceDocumentId: id.document, revisionNumber: 1, artifactReference: 'field-row-widths-e2e',
    artifactSha256: 'd'.repeat(64), contractVersion: 'parsed_document.v2', preprocessId: 'field-row-widths-e2e',
    parserName: 'fixture', parserVersion: '1',
  })
  await db.orm.public.ExtractionSchema.create({ id: id.schema, projectContextId: id.project, name: 'Excavation report' })
  await db.orm.public.SchemaRevision.create({
    id: randomUUID(), extractionSchemaId: id.schema, revisionNumber: 1, origin: 'RESEARCHER_EDIT', recordScope: 'document',
    schemaTree: {
      recordDescription: 'One excavation report and what it found, as the report itself describes the site and its finds.',
      schemaNodes,
    },
  })
})

async function openSchema(page: Page) {
  const [pdf, parsedDocument] = await Promise.all([readFile(pdfPath), readFile(parsedDocumentPath, 'utf8')])
  const representation = `**/api/project-contexts/${id.project}/source-representations/${id.representation}`
  await page.route(`${representation}/pdf**`, (route) => route.fulfill({ body: pdf, contentType: 'application/pdf' }))
  await page.route(`${representation}/markdown**`, (route) => route.fulfill({ body: '# Field rows', contentType: 'text/markdown' }))
  await page.route(`${representation}/source**`, (route) => route.fulfill({ body: parsedDocument, contentType: 'application/json' }))
  await loginResearcher(page, id.object)
  await page.goto(`/projects/${id.project}/documents/${id.document}`)
  await page.getByRole('tab', { name: /^Schema/ }).click()
  await expect(page.getByRole('listitem', { name: 'layer' })).toBeVisible({ timeout: 20_000 })
}

const rail = (page: Page) => page.getByRole('complementary', { name: 'Evidence, schema and results' })

async function resizeRail(page: Page, width: number) {
  // The rail's handle, not the project navigation's (that one is a separator).
  const handle = await page.locator('[title="Drag to resize"]:not([role="separator"])').boundingBox()
  const current = (await rail(page).boundingBox())!.width
  const x = handle!.x + handle!.width / 2, y = handle!.y + handle!.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  // The rail grows leftwards; the 264–560px clamp stops it at the minimum.
  await page.mouse.move(x + (current - width), y, { steps: 4 })
  await page.mouse.up()
  await expect.poll(async () => (await rail(page).boundingBox())!.width).toBe(width)
}

type Box = { x: number; y: number; width: number; height: number }
function expectInside(inner: Box | null, outer: Box, what: string) {
  expect(inner, what).not.toBeNull()
  expect(inner!.x, `${what}: left edge`).toBeGreaterThanOrEqual(outer.x - 0.5)
  expect(inner!.x + inner!.width, `${what}: right edge`).toBeLessThanOrEqual(outer.x + outer.width + 0.5)
  expect(inner!.y, `${what}: top edge`).toBeGreaterThanOrEqual(outer.y - 0.5)
  expect(inner!.y + inner!.height, `${what}: bottom edge`).toBeLessThanOrEqual(outer.y + outer.height + 0.5)
}
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

const actionsOf = (row: Locator, name: string) => [
  row.getByRole('button', { name: `Edit ${name}`, exact: true }),
  row.getByRole('button', { name: `Add note to ${name}`, exact: true }),
  row.getByRole('button', { name: `Delete ${name}`, exact: true }),
]
const opacity = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).opacity)

async function checkRows(page: Page, width: number) {
  const list = page.getByRole('list', { name: 'Schema fields' })
  const listBox = (await list.boundingBox())!
  expectInside(listBox, (await rail(page).boundingBox())!, `${width}px: the schema list in the rail`)
  // Neither the list nor the panel's scroll container scrolls sideways.
  const overflow = await list.evaluate((element) => ({
    list: [element.scrollWidth, element.clientWidth],
    scroller: [element.parentElement!.scrollWidth, element.parentElement!.clientWidth],
  }))
  expect(overflow.list[0], `${width}px: list scrollWidth <= clientWidth`).toBeLessThanOrEqual(overflow.list[1]!)
  expect(overflow.scroller[0], `${width}px: panel scrollWidth <= clientWidth`).toBeLessThanOrEqual(overflow.scroller[1]!)

  for (const name of rows) {
    const row = page.getByRole('listitem', { name, exact: true })
    await row.scrollIntoViewIfNeeded()
    await row.hover()
    const what = `${width}px, ${name}`
    const nameBox = await row.getByText(name, { exact: true }).boundingBox()
    expectInside(nameBox, listBox, `${what}: name`)
    for (const pill of await row.locator('[data-row-pill]').all())
      expectInside(await pill.boundingBox(), listBox, `${what}: pill ${await pill.getAttribute('title')}`)
    const actions = actionsOf(row, name)
    await expect.poll(() => opacity(actions[0]!.locator('..')), `${what}: actions shown on hover`).toBe('1')
    for (const action of actions) {
      const box = (await action.boundingBox())!
      expectInside(box, listBox, `${what}: ${await action.getAttribute('aria-label')}`)
      expect([box.width, box.height], `${what}: 28px action target`).toEqual([28, 28])
    }
  }
  // A name is never truncated by its own metadata: its pills wrap under it instead.
  const longName = page.getByRole('listitem', { name: 'archaeological_context' }).getByText('archaeological_context', { exact: true })
  const truncated = await longName.evaluate((element) => element.scrollWidth > element.clientWidth)
  expect(truncated, `${width}px: archaeological_context shown in full`).toBe(false)
  // Rows are 30px at rest when their pills fit beside the name.
  const sexLine = page.getByRole('listitem', { name: 'sex', exact: true }).locator('> div').first()
  expect((await sexLine.boundingBox())!.height, `${width}px: sex row height`).toBe(30)
}

async function checkKeyboard(page: Page, width: number) {
  // At rest: no pointer over the rows and no focus in them (the rail's resize keeps focus where it was).
  await page.mouse.move(0, 0)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const row = page.getByRole('listitem', { name: 'archaeological_context' })
  const actions = actionsOf(row, 'archaeological_context')
  await expect.poll(() => opacity(actions[0]!.locator('..')), `${width}px: actions hidden at rest`).toBe('0')
  await row.focus()
  const valuesPill = row.getByTitle(/^Allowed values/)
  const reached: string[] = []
  for (let press = 0; press < 6 && !reached.includes('Edit archaeological_context'); press += 1) {
    await page.keyboard.press('Tab')
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null
      return element?.getAttribute('aria-label') ?? element?.getAttribute('title') ?? ''
    })
    reached.push(focused)
    // A pill with keyboard focus is never covered by the actions.
    if (focused.startsWith('Allowed values')) {
      const pillBox = (await valuesPill.boundingBox())!
      await expect.poll(async () => (await opacity(actions[0]!.locator('..'))) !== '0' &&
        (await Promise.all(actions.map((action) => action.boundingBox()))).some((box) => box !== null && overlaps(box, pillBox)),
      `${width}px: the focused values pill is not covered by the actions`).toBe(false)
    }
  }
  expect(reached, `${width}px: Tab order from the row`).toEqual([
    expect.stringMatching(/^Type: string/), expect.stringMatching(/^Allowed values/), 'Edit archaeological_context',
  ])
  await expect(actions[0]!).toBeFocused()
  await expect.poll(() => opacity(actions[0]!.locator('..')), `${width}px: actions shown on focus`).toBe('1')
  expectInside(await actions[0]!.boundingBox(), (await page.getByRole('list', { name: 'Schema fields' }).boundingBox())!,
    `${width}px: focused Edit`)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(actions[2]!).toBeFocused()
  expectInside(await actions[2]!.boundingBox(), (await page.getByRole('list', { name: 'Schema fields' }).boundingBox())!,
    `${width}px: focused Delete`)
}

test('field rows fit the rail at 344px and 264px @database', async ({ page }) => {
  test.setTimeout(90_000)
  test.skip(withoutDatabase, 'Requires the disposable PostgreSQL stack.')
  await openSchema(page)
  await expect.poll(async () => (await rail(page).boundingBox())!.width).toBe(344)
  await checkRows(page, 344)
  await checkKeyboard(page, 344)
  await resizeRail(page, 264)
  await checkRows(page, 264)
  await checkKeyboard(page, 264)
  // A collapsed group's "· n fields" pill fits too.
  await page.getByRole('button', { name: 'Collapse findings' }).click()
  const findings = page.getByRole('listitem', { name: 'findings' })
  await findings.hover()
  const listBox = (await page.getByRole('list', { name: 'Schema fields' }).boundingBox())!
  expectInside(await findings.getByTitle('Type: list of objects · 2 fields — click to edit').boundingBox(), listBox, '264px: collapsed findings pill')
  for (const action of actionsOf(findings, 'findings')) expectInside(await action.boundingBox(), listBox, '264px: collapsed findings action')
})

test('the code view scrolls long lines sideways at 264px, reading and editing @database', async ({ page }) => {
  test.setTimeout(90_000)
  test.skip(withoutDatabase, 'Requires the disposable PostgreSQL stack.')
  await openSchema(page)
  await resizeRail(page, 264)
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  const code = rail(page).locator('pre')
  const reading = await code.evaluate((element) => ({
    overflowX: getComputedStyle(element).overflowX, whiteSpace: getComputedStyle(element).whiteSpace,
    scrolls: element.scrollWidth > element.clientWidth,
  }))
  expect(reading).toEqual({ overflowX: 'auto', whiteSpace: 'pre', scrolls: true })
  await page.getByRole('button', { name: 'Schema actions' }).click()
  await page.getByRole('menuitem', { name: 'Edit as code' }).click()
  const editor = page.getByRole('textbox', { name: 'Schema code' })
  const editing = await editor.evaluate((element) => ({
    overflowX: getComputedStyle(element).overflowX, whiteSpace: getComputedStyle(element).whiteSpace,
    scrolls: element.scrollWidth > element.clientWidth,
  }))
  expect(editing).toEqual({ overflowX: 'auto', whiteSpace: 'pre', scrolls: true })
  const panel = await rail(page).evaluate((element) => [element.scrollWidth, element.clientWidth])
  expect(panel[0]).toBeLessThanOrEqual(panel[1]!)
})
