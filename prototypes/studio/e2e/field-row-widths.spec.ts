import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DEVELOPMENT_ENTRA_TENANT_ID } from '../server/entraIdentityProvider.js'
import { loginResearcher } from './auth.js'

// §6 field rows at the rail's minimum (264px) and default (344px) widths, measured in a real browser: every row's name,
// pills and three 28px actions sit inside the schema list, nothing scrolls sideways, Tab reaches the actions, a pointer on
// a pill reaches the pill, and at rest the hidden actions take no hits. Also the panel's other narrow-rail surfaces: the
// record description's rows, the history preview banner and the Undo toast.

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

// Seeded once per worker process, as the ids above are: Playwright runs this file's beforeAll again in the same worker
// for another test group (the touch-screen tests' own fixtures, a repeat).
let seeded: Promise<void> | null = null
test.beforeAll(async () => {
  if (withoutDatabase) return
  seeded ??= seed()
  await seeded
})

async function seed() {
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
  // Revision 1 is history to preview; revision 2, the highest, is the Current Schema Revision the rows show.
  await db.orm.public.SchemaRevision.create({
    id: randomUUID(), extractionSchemaId: id.schema, revisionNumber: 1, origin: 'RESEARCHER_EDIT', recordScope: 'document',
    schemaTree: { recordDescription: 'One excavation report.', schemaNodes: [schemaNodes[0]] },
  })
  await db.orm.public.SchemaRevision.create({
    id: randomUUID(), extractionSchemaId: id.schema, revisionNumber: 2, origin: 'RESEARCHER_EDIT', recordScope: 'document',
    schemaTree: {
      recordDescription: 'One excavation report and what it found, as the report itself describes the site and its finds.',
      schemaNodes,
    },
  })
}

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
  // Sideways only: the list scrolls vertically in the panel, and at 264px its wrapped rows run below the viewport.
  const railBox = (await rail(page).boundingBox())!
  expect(listBox.x, `${width}px: the schema list in the rail: left edge`).toBeGreaterThanOrEqual(railBox.x - 0.5)
  expect(listBox.x + listBox.width, `${width}px: the schema list in the rail: right edge`).toBeLessThanOrEqual(railBox.x + railBox.width + 0.5)
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
    // Measured again after the scroll, which moves the list.
    const listBox = (await list.boundingBox())!
    const what = `${width}px, ${name}`
    const nameBox = await row.getByText(name, { exact: true }).boundingBox()
    expectInside(nameBox, listBox, `${what}: name`)
    for (const pill of await row.locator('[data-row-pill]').all()) {
      const pillTitle = await pill.getAttribute('title')
      expectInside(await pill.boundingBox(), listBox, `${what}: pill ${pillTitle}`)
      // Never squeezed under its own width by the actions' zone.
      const cut = await pill.evaluate((element) => [element, ...element.querySelectorAll('*')]
        .some((part) => part.scrollWidth > part.clientWidth + 0.5))
      expect(cut, `${what}: pill ${pillTitle} shown in full`).toBe(false)
    }
    const actions = actionsOf(row, name)
    await expect.poll(() => opacity(actions[0]!.locator('..')), `${what}: actions shown on hover`).toBe('1')
    for (const action of actions) {
      const box = (await action.boundingBox())!
      expectInside(box, listBox, `${what}: ${await action.getAttribute('aria-label')}`)
      // Worded (decision 11): 28px tall, at least 28px wide.
      expect(box.height, `${what}: 28px action target`).toBe(28)
      expect(box.width, `${what}: action at least 28px wide`).toBeGreaterThanOrEqual(28)
    }
  }
  // A name is never truncated by its own metadata: its pills wrap under it instead.
  const longName = page.getByRole('listitem', { name: 'archaeological_context' }).getByText('archaeological_context', { exact: true })
  const truncated = await longName.evaluate((element) => element.scrollWidth > element.clientWidth)
  expect(truncated, `${width}px: archaeological_context shown in full`).toBe(false)
  if (width < 344) {
    // A row line under 240px puts its actions on their own line below the pills: hovered, a nested row's name and a long
    // name stay fully in view, none of the actions over them, and the disclosure is clear (decision 11 follow-up).
    for (const name of ['kind', 'archaeological_context', 'deposit']) {
      const row = page.getByRole('listitem', { name, exact: true })
      await row.scrollIntoViewIfNeeded()
      await row.hover()
      const actions = actionsOf(row, name)
      await expect.poll(() => opacity(actions[0]!.locator('..')), `${width}px, ${name}: actions shown on hover`).toBe('1')
      const nameBox = (await row.getByText(name, { exact: true }).boundingBox())!
      expectInside(nameBox, (await row.boundingBox())!, `${width}px, ${name}: the hovered name in its row`)
      const nameText = await row.getByText(name, { exact: true }).evaluate((element) => element.scrollWidth <= element.clientWidth)
      expect(nameText, `${width}px, ${name}: the hovered name in full`).toBe(true)
      const pills = await Promise.all((await row.locator('[data-row-pill]').all()).map((pill) => pill.boundingBox()))
      const controls = [nameBox, ...pills.filter((box): box is Box => box !== null)]
      const disclosure = row.getByRole('button', { name: /^(Collapse|Expand) / })
      if (await disclosure.count()) controls.push((await disclosure.boundingBox())!)
      for (const action of actions) {
        const box = (await action.boundingBox())!
        for (const control of controls)
          expect(overlaps(box, control), `${width}px, ${name}: ${await action.getAttribute('aria-label')} clear of the name, pills and disclosure`).toBe(false)
        expect(box.y, `${width}px, ${name}: actions below the pills`).toBeGreaterThanOrEqual(Math.max(...controls.map((control) => control.y + control.height)) - 0.5)
      }
    }
  }
  if (width >= 344) {
    // Rows are 30px at rest when their pills fit beside the name, clear of the actions' 140px: at 344px the top level
    // keeps 123px for them, so `title · string` does (`sex · string · 6 values`, 137px, wraps its values pill).
    const titleLine = page.getByRole('listitem', { name: 'title', exact: true }).locator('> div').first()
    expect((await titleLine.boundingBox())!.height, `${width}px: title row height`).toBe(30)
  } else {
    // A row line under 296px would leave its pills under 110px beside the name: at 264px every row's pills start on the
    // line below the name, at its left edge, and the name's line holds the name alone.
    for (const name of rows) {
      const row = page.getByRole('listitem', { name, exact: true })
      const nameBox = (await row.getByText(name, { exact: true }).boundingBox())!
      const first = (await row.locator('[data-row-pill]').first().boundingBox())!
      expect(first.y, `${width}px, ${name}: pills below the name`).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 0.5)
      expect(Math.abs(first.x - nameBox.x), `${width}px, ${name}: pills start under the name`).toBeLessThanOrEqual(0.5)
    }
  }
  // A note starts where its field's name starts.
  const title = page.getByRole('listitem', { name: 'title', exact: true })
  const nameStart = (await title.getByText('title', { exact: true }).boundingBox())!.x
  const noteStart = await title.getByRole('button', { name: 'The report title as printed on its cover page.' }).evaluate((element) =>
    element.getBoundingClientRect().left + parseFloat(getComputedStyle(element).paddingLeft))
  expect(Math.abs(noteStart - nameStart), `${width}px: the note starts under the name (${noteStart} vs ${nameStart})`).toBeLessThanOrEqual(0.5)
}

/** Every row's type and values pills, clicked at their right edge with the row hovered, as a pointer would: the click
 *  reaches the pill and opens the edit form focused on the name or the allowed values; never an action (no note form, no
 *  delete). */
async function clickPillEdges(page: Page, width: number) {
  const pills = [
    { title: /^Type: /, focused: () => page.getByPlaceholder('field_name') },
    { title: /^Allowed values/, focused: () => page.getByLabel('Add allowed value') },
  ]
  for (const name of rows) {
    const row = page.getByRole('listitem', { name, exact: true })
    for (const { title, focused } of pills) {
      const pill = row.getByTitle(title)
      if (await pill.count() === 0) continue
      const what = `${width}px, ${name}: ${title.source} pill's right edge`
      await row.scrollIntoViewIfNeeded()
      await row.hover()
      await expect.poll(() => opacity(actionsOf(row, name)[0]!.locator('..')), `${what}: actions shown on hover`).toBe('1')
      const box = (await pill.boundingBox())!
      // Playwright refuses a click another element would intercept, naming that element.
      await pill.click({ position: { x: box.width - 2, y: box.height / 2 }, timeout: 3_000 })
      await expect(focused(), `${what}: the edit form's focus`).toBeFocused()
      await expect(page.getByPlaceholder(/^(Describe this field|Add another note)/), `${what}: no note form`).toHaveCount(0)
      await expect(page.getByText('Field removed'), `${what}: nothing deleted`).toHaveCount(0)
      await page.getByRole('button', { name: 'Cancel field edit' }).click()
      await expect(row, `${what}: the row is back`).toBeVisible()
    }
  }
}

/** At rest, with no pointer over the rows and no focus in them, the hidden actions take no hits: a tap where Delete
 *  sits (the right end of the first line) reaches the row, never Delete. */
async function checkRestingHits(page: Page, width: number) {
  for (const name of rows) {
    const row = page.getByRole('listitem', { name, exact: true })
    await row.scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const remove = actionsOf(row, name)[2]!
    await expect.poll(() => opacity(remove.locator('..')), `${width}px, ${name}: actions hidden at rest`).toBe('0')
    const box = (await remove.boundingBox())!
    const hit = await page.evaluate(([x, y]) => {
      const element = document.elementFromPoint(x!, y!)
      return element?.closest('[data-row-actions]') ? element.getAttribute('aria-label') ?? element.tagName : null
    }, [box.x + box.width / 2, box.y + box.height / 2])
    expect(hit, `${width}px, ${name}: at rest, a tap where Delete sits reaches no action`).toBeNull()
  }
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
      expect(await actions[0]!.locator('..').evaluate((element) => getComputedStyle(element).pointerEvents),
        `${width}px: the stepped-aside actions take no hits`).toBe('none')
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

test('field rows fit the rail at 344px and 264px @deterministic', async ({ page }) => {
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

test('a pointer on a pill\'s right edge reaches the pill, never the actions, at 344px and 264px @deterministic', async ({ page }) => {
  test.setTimeout(120_000)
  test.skip(withoutDatabase, 'Requires the disposable PostgreSQL stack.')
  await openSchema(page)
  await expect.poll(async () => (await rail(page).boundingBox())!.width).toBe(344)
  await clickPillEdges(page, 344)
  await resizeRail(page, 264)
  await clickPillEdges(page, 264)
})

test('at rest the hidden row actions take no hits, at 344px and 264px @deterministic', async ({ page }) => {
  test.setTimeout(90_000)
  test.skip(withoutDatabase, 'Requires the disposable PostgreSQL stack.')
  await openSchema(page)
  await expect.poll(async () => (await rail(page).boundingBox())!.width).toBe(344)
  await checkRestingHits(page, 344)
  await resizeRail(page, 264)
  await checkRestingHits(page, 264)
})

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true })
  test('a tap at rest where Delete sits focuses the row and deletes nothing, at 344px and 264px @deterministic', async ({ page }) => {
    test.setTimeout(90_000)
    test.skip(withoutDatabase, 'Requires the disposable PostgreSQL stack.')
    await openSchema(page)
    await expect.poll(async () => (await rail(page).boundingBox())!.width).toBe(344)
    for (const width of [344, 264]) {
      if (width !== 344) await resizeRail(page, width)
      const row = page.getByRole('listitem', { name: 'sex', exact: true })
      await row.scrollIntoViewIfNeeded()
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      const remove = actionsOf(row, 'sex')[2]!
      await expect.poll(() => opacity(remove.locator('..')), `${width}px: actions hidden at rest`).toBe('0')
      // Where Delete sits: in the overlay (344px), or on the actions' own line below the pills (264px).
      const box = (await remove.boundingBox())!
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
      // The tap lands on the row, which takes focus and so reveals its actions for a second tap; nothing is deleted.
      await expect(row, `${width}px: the tap focused the row`).toBeFocused()
      await expect(page.getByText('Field removed'), `${width}px: nothing deleted`).toHaveCount(0)
      await expect.poll(() => opacity(remove.locator('..')), `${width}px: the actions shown after the tap`).toBe('1')
    }
  })
})

test('the record description grows with its text, and the code view scrolls long lines sideways at 264px @deterministic', async ({ page }) => {
  test.setTimeout(90_000)
  test.skip(withoutDatabase, 'Requires the disposable PostgreSQL stack.')
  await openSchema(page)
  await resizeRail(page, 264)
  // §5: two rows at rest, growing with its wrapped text (not only its line breaks) to six, without hiding any of it.
  const description = page.getByLabel('What one record is')
  const fit = () => description.evaluate((element: HTMLTextAreaElement) =>
    ({ rows: element.rows, hidden: element.scrollHeight > element.clientHeight + 1 }))
  await description.fill('One grave.')
  expect(await fit()).toEqual({ rows: 2, hidden: false })
  await description.fill('One excavation report and what it found, as the report itself describes the site, its layers and its finds, with the dates the excavators gave them.')
  const grown = await fit()
  expect(grown.rows).toBeGreaterThan(2)
  expect(grown.rows).toBeLessThanOrEqual(6)
  expect(grown.hidden).toBe(false)
  await description.fill('One grave. '.repeat(60))
  expect((await fit()).rows).toBe(6)
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  const code = rail(page).locator('pre')
  const reading = await code.evaluate((element) => ({
    overflowX: getComputedStyle(element).overflowX, whiteSpace: getComputedStyle(element).whiteSpace,
    scrolls: element.scrollWidth > element.clientWidth,
  }))
  expect(reading).toEqual({ overflowX: 'auto', whiteSpace: 'pre', scrolls: true })
  // The code view's commands are the shared Button, at least 24px tall (§10).
  expect((await rail(page).getByRole('button', { name: 'Edit', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(24)
  await page.getByRole('button', { name: 'Schema actions' }).click()
  await page.getByRole('menuitem', { name: 'Edit as code' }).click()
  const editor = page.getByRole('textbox', { name: 'Schema code' })
  const editing = await editor.evaluate((element) => ({
    overflowX: getComputedStyle(element).overflowX, whiteSpace: getComputedStyle(element).whiteSpace,
    scrolls: element.scrollWidth > element.clientWidth,
  }))
  expect(editing).toEqual({ overflowX: 'auto', whiteSpace: 'pre', scrolls: true })
  for (const name of ['Save', 'Cancel'])
    expect((await rail(page).getByRole('button', { name, exact: true }).boundingBox())!.height, name).toBeGreaterThanOrEqual(24)
  const panel = await rail(page).evaluate((element) => [element.scrollWidth, element.clientWidth])
  expect(panel[0]).toBeLessThanOrEqual(panel[1]!)
})

test('the record description re-measures its rows when the rail is resized or the Schema tab is shown again @deterministic', async ({ page }) => {
  test.setTimeout(90_000)
  test.skip(withoutDatabase, 'Requires the disposable PostgreSQL stack.')
  await openSchema(page)
  await expect.poll(async () => (await rail(page).boundingBox())!.width).toBe(344)
  const description = page.getByLabel('What one record is')
  const fit = () => description.evaluate((element: HTMLTextAreaElement) =>
    ({ rows: element.rows, hidden: element.scrollHeight > element.clientHeight + 1 }))
  // Filled wide; no keystroke after this.
  await description.fill('One excavation report and what it found, as the report itself describes the site, its layers and its finds.')
  const wide = (await fit()).rows
  expect(wide).toBeGreaterThanOrEqual(2)
  await resizeRail(page, 264)
  await expect.poll(async () => (await fit()).rows, 'narrowed: more rows').toBeGreaterThan(wide)
  const narrow = await fit()
  expect(narrow.rows).toBeLessThanOrEqual(6)
  expect(narrow.hidden, 'narrowed: no text hidden').toBe(false)
  await resizeRail(page, 344)
  await expect.poll(async () => (await fit()).rows, 'widened: back to its rows').toBe(wide)
  // Narrowed while the Schema tab is hidden: measured once it shows again.
  await page.getByRole('tab', { name: /^Results/ }).click()
  await resizeRail(page, 264)
  await page.getByRole('tab', { name: /^Schema/ }).click()
  await expect.poll(async () => (await fit()).rows, 'shown again: narrow rows').toBe(narrow.rows)
  expect((await fit()).hidden).toBe(false)
})

test('a history preview at 264px reads across the panel, its commands beneath and inside it @deterministic', async ({ page }) => {
  test.setTimeout(90_000)
  test.skip(withoutDatabase, 'Requires the disposable PostgreSQL stack.')
  await openSchema(page)
  await resizeRail(page, 264)
  await page.getByRole('button', { name: 'Schema actions' }).click()
  await page.getByRole('menuitem', { name: 'History' }).click()
  await page.getByRole('dialog', { name: 'Schema history' }).getByRole('button', { name: /^Revision 1/ }).click()
  const banner = rail(page).getByRole('status').filter({ hasText: 'Viewing historical Schema Revision 1' })
  await expect(banner).toBeVisible()
  const railBox = (await rail(page).boundingBox())!
  const bannerBox = (await banner.boundingBox())!
  expectInside(bannerBox, railBox, '264px: the banner in the rail')
  const text = banner.getByText(/^Viewing historical Schema Revision 1/)
  const textBox = (await text.boundingBox())!
  expectInside(textBox, bannerBox, '264px: the banner text')
  // Its whole width, not a word a line beside the commands.
  const inner = await banner.evaluate((element) => {
    const style = getComputedStyle(element)
    return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
  })
  expect(textBox.width, '264px: the banner text spans the banner').toBeGreaterThanOrEqual(inner - 1)
  for (const name of ['Close preview', 'Create Current Schema Revision']) {
    const box = (await banner.getByRole('button', { name }).boundingBox())!
    expectInside(box, bannerBox, `264px: ${name}`)
    expect(box.y, `264px: ${name} beneath the text`).toBeGreaterThanOrEqual(textBox.y + textBox.height)
  }
  const overflow = await rail(page).evaluate((element) => [element.scrollWidth, element.clientWidth])
  expect(overflow[0]).toBeLessThanOrEqual(overflow[1]!)
})

test('the Undo toast sits clear of the composer and the footer at 344px and 264px @deterministic', async ({ page }) => {
  test.setTimeout(90_000)
  test.skip(withoutDatabase, 'Requires the disposable PostgreSQL stack.')
  await openSchema(page)
  await expect.poll(async () => (await rail(page).boundingBox())!.width).toBe(344)
  for (const width of [344, 264]) {
    if (width !== 344) await resizeRail(page, width)
    const row = page.getByRole('listitem', { name: 'sex', exact: true })
    await row.hover()
    await row.getByRole('button', { name: 'Delete sex', exact: true }).click()
    const toast = page.getByText('Field removed').locator('..')
    await expect(toast).toBeVisible()
    const toastBox = (await toast.boundingBox())!
    const composer = (await page.getByPlaceholder('Describe a change to the schema…').locator('..').boundingBox())!
    const footer = (await rail(page).locator('footer').boundingBox())!
    expect(overlaps(toastBox, composer), `${width}px: the toast clear of the composer`).toBe(false)
    expect(overlaps(toastBox, footer), `${width}px: the toast clear of the footer`).toBe(false)
    expectInside(toastBox, (await rail(page).boundingBox())!, `${width}px: the toast in the rail`)
    // The seed is shared with the other tests: put the field back.
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByRole('listitem', { name: 'sex', exact: true })).toBeVisible()
  }
})
