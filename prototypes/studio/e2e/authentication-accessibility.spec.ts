import { expect, test } from '@playwright/test'
import { E2E_ORIGIN, E2E_PASSWORD } from './auth.js'
import {
  activateWithKeyboard,
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
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2'
  })
  await expectOperableInViewport(page, signIn)
  await page.evaluate(() => {
    document.documentElement.style.zoom = ''
  })

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

test('the provider dialog remains keyboard-operable at every required viewport and 200% zoom @deterministic', async ({
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
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2'
  })
  const configure = page.getByRole('button', { name: 'Configure providers' })
  await activateWithKeyboard(page, configure)
  const dialog = page.getByRole('dialog', { name: 'Provider configuration' })
  const close = dialog.getByRole('button', { name: 'Close Model Connections' })
  await expectOperableInViewport(page, close)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(configure).toBeFocused()
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
