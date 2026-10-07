import { expect, test } from '@playwright/test'
import {
  completeMockOidcLogin,
  E2E_ORIGIN,
  loginResearcher,
  SECOND_E2E_ENTRA_OBJECT_ID,
} from './auth.js'
import {
  activateWithKeyboard,
  expectOperableInViewport,
  REQUIRED_VIEWPORTS,
} from './accessibility.js'

async function openAccountMenu(page: import('@playwright/test').Page) {
  const signOut = page.getByRole('button', { name: 'Sign out' })
  if (await signOut.isVisible()) return signOut
  const account = page.getByRole('button', { name: 'Researcher Account' })
  if (!(await account.isVisible())) {
    const expand = page.getByRole('button', { name: 'Expand projects' })
    if (await expand.isVisible()) await expand.click()
  }
  await account.click()
  await expect(signOut).toBeVisible()
  return signOut
}

test('mock OIDC sign-in establishes a real Studio session @deterministic', async ({
  page,
}) => {
  await loginResearcher(page)

  const session = await page.request.get('/api/auth/session')
  await expect(session.json()).resolves.toMatchObject({ authenticated: true })
})

test('reduced motion, focus, and mobile form text honor accessibility preferences', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/auth/signed-out')
  const authCard = page.locator('.animate-fadeup')
  await expect(authCard).toBeVisible()
  // Retrying assertion: a one-shot `evaluate` can read a handle the page has
  // already detached, and computed style is then empty rather than `none`.
  await expect(authCard).toHaveCSS('animation-name', 'none')

  await page.route('**/api/project-contexts**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: { projectContexts: [] },
    }),
  )
  await loginResearcher(page)
  await page.goto('/projects')
  await page.setViewportSize({ width: 390, height: 844 })
  const create = page.getByRole('button', { name: 'Create your first project' })
  await create.focus()
  const focusStyle = await create.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    }
  })
  expect(focusStyle.outlineStyle).toBe('solid')
  expect(focusStyle.outlineWidth).toBe('2px')
  expect(focusStyle.boxShadow).not.toBe('none')
  await create.click()
  const name = page.getByRole('textbox', { name: 'Project name' })
  expect(
    await name.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(16)
})

test('deep-link Entra sign-in and keyboard logout clear local authority @deterministic', async ({
  page,
}) => {
  await page.route('**/api/project-contexts**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: { projectContexts: [] },
    }),
  )

  await page.goto('/projects?view=all#top')
  await completeMockOidcLogin(page)
  await expect(page).toHaveURL(/\/projects\?view=all#top$/)
  await expect(page.getByText('Development Researcher')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Create your first project' }),
  ).toBeVisible()

  await page.setViewportSize({ width: 1280, height: 800 })
  const finalSignOut = await openAccountMenu(page)
  await expectOperableInViewport(page, finalSignOut)
  const landing = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/auth/signed-out',
  )
  const signedOut = page.waitForURL(/\/auth\/signed-out$/)
  await activateWithKeyboard(
    page,
    finalSignOut,
  )
  const landingResponse = await landing
  expect(landingResponse.ok()).toBe(true)
  await signedOut

  await expect(
    page.getByRole('heading', { name: 'You have signed out' }),
  ).toBeVisible()
  await expect(page).toHaveURL(/\/auth\/signed-out$/)
  const session = await page.request.get('/api/auth/session')
  await expect(session.json()).resolves.toEqual({ authenticated: false })
  await expect(
    page.getByRole('navigation', { name: 'Projects' }),
  ).toHaveCount(0)
  const signIn = page.getByRole('button', { name: 'Sign in with Microsoft' })
  await expectOperableInViewport(page, signIn)
  await page.goBack()
  await expect(page).toHaveURL(/\/auth\/signed-out#?$/)
  await expect(
    page.getByRole('navigation', { name: 'Projects' }),
  ).toHaveCount(0)
})


test('switching Entra accounts does not retain the previous project rail @deterministic', async ({
  page,
}) => {
  const first = {
    projectContextId: '71000000-0000-4000-8000-000000000001',
    name: 'First account project',
  }
  const second = {
    projectContextId: '72000000-0000-4000-8000-000000000001',
    name: 'Second account project',
  }
  let visibleAccount = first
  await page.route('**/api/project-contexts**', (route) => {
    const project = {
      projectContextId: visibleAccount.projectContextId,
      name: visibleAccount.name,
      createdAt: '2026-08-24T00:00:00.000Z',
      sourceDocumentCount: 0,
      summary: {
        phase: 'ingest',
        extractionCount: 0,
        extractedSourceDocumentCount: 0,
        reviewedSourceDocumentCount: 0,
        staleSourceDocumentCount: 0,
        schemaDraftCount: 0,
        schemaStabilised: false,
        lastActivityAt: '2026-08-24T00:00:00.000Z',
        runningBatch: null,
      },
    }
    return route.fulfill({
      contentType: 'application/json',
      json: { projectContexts: [project] },
    })
  })

  await loginResearcher(page)
  await page.goto('/projects')
  const projects = page.getByRole('navigation', { name: 'Projects' })
  await expect(projects.getByText(first.name).first()).toBeVisible()
  const signOut = await openAccountMenu(page)
  const landing = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/auth/signed-out',
  )
  await Promise.all([
    page.waitForURL(/\/auth\/signed-out$/),
    signOut.click(),
  ])
  expect((await landing).ok()).toBe(true)
  await expect(
    page.getByRole('heading', { name: 'You have signed out' }),
  ).toBeVisible()

  visibleAccount = second
  await loginResearcher(page, SECOND_E2E_ENTRA_OBJECT_ID)
  await page.goto('/projects')
  await expect(projects.getByText(second.name).first()).toBeVisible()
  await expect(projects.getByText(first.name)).toHaveCount(0)
  await expect(page.getByText(/Test Researcher/)).toBeVisible()
})

test('the provider dialog remains keyboard-operable across required viewports @deterministic', async ({
  page,
}) => {
  await page.route('**/api/project-contexts**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: { projectContexts: [] },
    }),
  )
  await page.route('**/api/model_config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        config: {
          connections: [],
          routes: { schemaSuggestion: null, interaction: null },
          extractionModels: {},
          ingestionModels: {},
          extractionSettings: {},
        },
        providers: [],
        deployment: { connections: [], defaultRoute: null },
      },
    }),
  )
  await loginResearcher(page)
  await page.goto('/projects')

  for (const viewport of REQUIRED_VIEWPORTS) {
    await page.setViewportSize(viewport)
    const expand = page.getByRole('button', { name: 'Expand projects' })
    const configure = page.getByRole('button', { name: 'Configure models' })
    if (viewport.width < 860) {
      // The resize effect collapses the narrow overlay; wait for that state
      // before opening it, including when moving between two narrow widths.
      await expect(configure).toHaveCount(0)
      await expect(expand).toBeVisible()
      await activateWithKeyboard(page, expand)
    }
    await activateWithKeyboard(page, configure)
    const dialog = page.getByRole('dialog', { name: 'Model configuration' })
    const close = dialog.getByRole('button', { name: 'Close Model Configuration' })
    await expect(close).toBeFocused()
    await expectOperableInViewport(page, close)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(configure).toBeFocused()
  }
})

test('invalid-origin logout and a tampered session fail closed @deterministic', async ({
  browser,
  page,
}) => {
  await loginResearcher(page)
  const rejectedLogout = await page.request.post('/auth/logout', {
    headers: { Origin: 'https://attacker.example' },
  })
  expect(rejectedLogout.status()).toBe(403)
  expect(await rejectedLogout.json()).toMatchObject({
    error: { code: 'origin_rejected' },
  })
  await expect((await page.request.get('/api/auth/session')).json()).resolves.toMatchObject({
    authenticated: true,
  })

  const tampered = await browser.newContext()
  await tampered.addCookies([
    {
      name: 'free_session',
      value: 'tampered.payload.signature',
      url: E2E_ORIGIN,
    },
  ])
  const response = await tampered.request.get(`${E2E_ORIGIN}/api/auth/session`)
  expect(await response.json()).toEqual({ authenticated: false })
  expect(response.headers()['set-cookie']).toContain('free_session=;')
  await tampered.close()
})
