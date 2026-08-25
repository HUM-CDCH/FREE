import { expect, test } from '@playwright/test'
import { PLAYWRIGHT_SECOND_RESEARCHER_EMAIL } from '../server/playwright-auth.js'
import { E2E_ORIGIN, E2E_PASSWORD } from './auth.js'
import {
  activateWithKeyboard,
  emulateBrowserZoom200,
  expectOperableInViewport,
  REQUIRED_VIEWPORTS,
} from './accessibility.js'

test('login and logout complete by keyboard with stable focus, history protection, and responsive layout @deterministic', async ({
  page,
}) => {
  await page.route('**/api/project-contexts**', (route) =>
    route.fulfill({ contentType: 'application/json', json: { projectContexts: [] } }),
  )
  await page.goto('/login')

  const email = page.getByLabel('Email address')
  const password = page.getByLabel('Password')
  const signIn = page.getByRole('button', { name: 'Sign in' })
  await expect(email).toBeFocused()
  await expect(email).toHaveAttribute('autocomplete', 'username')
  await expect(password).toHaveAttribute('autocomplete', 'current-password')
  await expect(password).toHaveAttribute('type', 'password')
  await expect(page.getByRole('main')).toHaveCount(1)
  await expect(
    page.getByRole('button', { name: 'Inspect LLM messages' }),
  ).toHaveCount(0)

  for (const viewport of REQUIRED_VIEWPORTS) {
    await page.setViewportSize(viewport)
    await expectOperableInViewport(page, email)
    await expectOperableInViewport(page, password)
    await expectOperableInViewport(page, signIn)
  }
  await emulateBrowserZoom200(page)
  await expectOperableInViewport(page, signIn)
  await page.setViewportSize({ width: 1280, height: 800 })

  await email.focus()
  await page.keyboard.type('browser-fixture@example.test')
  await page.keyboard.press('Tab')
  await expect(password).toBeFocused()
  await page.keyboard.type(E2E_PASSWORD)
  await page.keyboard.press('Tab')
  await expect(signIn).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page.getByRole('heading', { name: 'No project open' })).toBeVisible()
  const signOut = page.getByRole('button', { name: 'Sign out' })
  await activateWithKeyboard(page, signOut)
  await expect(
    page.getByRole('heading', { name: 'Sign in to FREE Studio' }),
  ).toBeVisible()
  await expect(page.getByRole('status')).toContainText('You have signed out.')

  await page.goBack()
  await expect(page.getByRole('navigation', { name: 'Project Contexts' })).toHaveCount(0)
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'Sign in to FREE Studio' }),
  ).toBeVisible()
})

test('switching accounts clears the previous project rail, document tabs, and route @deterministic', async ({
  page,
}) => {
  const first = {
    projectContextId: '71000000-0000-4000-8000-000000000001',
    name: 'First account project',
    sourceDocumentId: '71000000-0000-4000-8000-000000000002',
    documentName: 'first-account-only.pdf',
    sourceRepresentationId: '71000000-0000-4000-8000-000000000003',
  }
  const second = {
    projectContextId: '72000000-0000-4000-8000-000000000001',
    name: 'Second account project',
    sourceDocumentId: '72000000-0000-4000-8000-000000000002',
    documentName: 'second-account-only.pdf',
    sourceRepresentationId: '72000000-0000-4000-8000-000000000003',
  }
  let visibleAccount = first
  const createdAt = '2026-08-24T00:00:00.000Z'

  await page.route('**/api/project-contexts**', (route) => {
    const { pathname } = new URL(route.request().url())
    const project = {
      projectContextId: visibleAccount.projectContextId,
      name: visibleAccount.name,
      createdAt,
    }
    const document = {
      sourceDocumentId: visibleAccount.sourceDocumentId,
      name: visibleAccount.documentName,
      createdAt,
    }
    if (pathname.endsWith('/reopen')) {
      const representationBase = `/api/project-contexts/${visibleAccount.projectContextId}/source-representations/${visibleAccount.sourceRepresentationId}`
      return route.fulfill({
        contentType: 'application/json',
        json: {
          projectContext: project,
          sourceDocument: document,
          sourceRepresentation: {
            sourceRepresentationId: visibleAccount.sourceRepresentationId,
            revisionNumber: 1,
            resources: {
              sourcePdfUrl: `${representationBase}/pdf`,
              markdownUrl: `${representationBase}/markdown`,
              parsedDocumentUrl: `${representationBase}/source`,
            },
          },
          annotationSet: null,
          extractionSchema: null,
          latestAttempt: null,
          latestReviewed: null,
        },
      })
    }
    if (pathname.includes('/source-representations/')) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        json: {
          error: {
            code: 'source_artifact_unavailable',
            message: 'Fixture artifacts are intentionally unavailable.',
          },
        },
      })
    }
    if (pathname === `/api/project-contexts/${visibleAccount.projectContextId}`) {
      return route.fulfill({
        contentType: 'application/json',
        json: {
          projectContext: project,
          sourceDocuments: [{ ...document, pageCount: 1 }],
        },
      })
    }
    return route.fulfill({
      contentType: 'application/json',
      json: { projectContexts: [project] },
    })
  })

  const firstLogin = await page.request.post('/api/auth/login', {
    headers: { Origin: E2E_ORIGIN },
    data: {
      email: 'browser-fixture@example.test',
      password: E2E_PASSWORD,
    },
  })
  expect(firstLogin.ok()).toBe(true)
  await page.goto('/')
  await expect(page.getByText('browser-fixture@example.test')).toBeVisible()
  await page
    .getByRole('button', { name: /Source Documents in First account project$/ })
    .click()
  await page
    .getByRole('navigation', { name: 'Project Contexts' })
    .getByRole('button', { name: first.documentName, exact: true })
    .click()
  await expect(
    page.getByRole('tab', { name: new RegExp(first.documentName) }),
  ).toBeVisible()
  await expect(page).toHaveURL(
    new RegExp(
      `/projects/${first.projectContextId}/documents/${first.sourceDocumentId}$`,
    ),
  )

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(
    page.getByRole('heading', { name: 'Sign in to FREE Studio' }),
  ).toBeVisible()
  visibleAccount = second
  await page.getByLabel('Email address').fill(PLAYWRIGHT_SECOND_RESEARCHER_EMAIL)
  await page.getByLabel('Password').fill(E2E_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByText(PLAYWRIGHT_SECOND_RESEARCHER_EMAIL)).toBeVisible()
  await expect(page.getByText(second.name)).toBeVisible()
  await expect(page.getByText(first.name)).toHaveCount(0)
  await expect(page.getByRole('tab', { name: new RegExp(first.documentName) })).toHaveCount(0)
  await expect(page).toHaveURL('/projects')
})

test('the provider dialog remains keyboard-operable at every required viewport and a 200% zoom-equivalent viewport @deterministic', async ({
  page,
}) => {
  await page.route('**/api/project-contexts**', (route) =>
    route.fulfill({ contentType: 'application/json', json: { projectContexts: [] } }),
  )
  await page.route('**/api/model_config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: { config: { connections: [], routes: { extraction: null, interaction: null } }, credentialStates: {}, providers: [] },
    }),
  )
  await page.request.post('/api/auth/login', {
    headers: { Origin: E2E_ORIGIN },
    data: {
      email: 'browser-fixture@example.test',
      password: E2E_PASSWORD,
    },
  })
  await page.goto('/')

  for (const viewport of REQUIRED_VIEWPORTS) {
    await page.setViewportSize(viewport)
    const expand = page.getByRole('button', { name: 'Expand Project Contexts' })
    if (viewport.width < 860) {
      await expect(expand).toBeVisible()
      await activateWithKeyboard(page, expand)
    }
    const configure = page.getByRole('button', { name: 'Configure providers' })
    await activateWithKeyboard(page, configure)
    const dialog = page.getByRole('dialog', { name: 'Provider configuration' })
    const close = dialog.getByRole('button', { name: 'Close Model Connections' })
    await expect(close).toBeFocused()
    await expectOperableInViewport(page, close)
    await expectOperableInViewport(
      page,
      dialog.getByRole('button', { name: 'Apply' }),
    )
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(configure).toBeFocused()
  }
  await emulateBrowserZoom200(page)
  const expandAtZoom = page.getByRole('button', {
    name: 'Expand Project Contexts',
  })
  await expect(expandAtZoom).toBeVisible()
  await activateWithKeyboard(page, expandAtZoom)
  const configure = page.getByRole('button', { name: 'Configure providers' })
  await expect(configure).toBeVisible()
  await activateWithKeyboard(page, configure)
  const dialog = page.getByRole('dialog', { name: 'Provider configuration' })
  const close = dialog.getByRole('button', { name: 'Close Model Connections' })
  await expectOperableInViewport(page, close)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(configure).toBeFocused()
  await page.setViewportSize({ width: 1280, height: 800 })
})

test('invalid-origin writes and a tampered session fail closed without protected UI @deterministic', async ({
  browser,
  page,
}) => {
  const login = await page.request.post('/api/auth/login', {
    headers: { Origin: E2E_ORIGIN },
    data: {
      email: 'browser-fixture@example.test',
      password: E2E_PASSWORD,
    },
  })
  expect(login.status()).toBe(200)
  const rejectedLogout = await page.request.post('/api/auth/logout', {
    headers: { Origin: 'https://attacker.example' },
  })
  expect(rejectedLogout.status()).toBe(403)
  expect(await rejectedLogout.json()).toEqual({
    error: {
      code: 'origin_rejected',
      message: 'Request origin is not allowed.',
    },
  })
  const preserved = await page.request.get('/api/auth/session')
  expect(await preserved.json()).toMatchObject({ authenticated: true })

  const tampered = await browser.newContext()
  await tampered.addCookies([
    {
      name: 'free_session',
      value: 'tampered.payload.signature',
      url: E2E_ORIGIN,
      httpOnly: true,
      sameSite: 'Strict',
      secure: true,
    },
  ])
  const tamperedPage = await tampered.newPage()
  const protectedRequests: string[] = []
  tamperedPage.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/project-contexts'))
      protectedRequests.push(request.url())
  })
  await tamperedPage.goto(
    '/projects/11111111-1111-4111-8111-111111111111',
  )
  await expect(
    tamperedPage.getByRole('heading', { name: 'Sign in to FREE Studio' }),
  ).toBeVisible()
  await expect(
    tamperedPage.getByRole('navigation', { name: 'Project Contexts' }),
  ).toHaveCount(0)
  expect(protectedRequests).toEqual([])
  expect(
    (await tampered.cookies()).find(({ name }) => name === 'free_session'),
  ).toBeUndefined()
  await tampered.close()
})
