import { expect, type Page } from '@playwright/test'

export const E2E_ORIGIN = 'http://localhost:41739'
export const E2E_PASSWORD = 'E2E authentication password 123!'

const mockedSessions = new WeakSet<Page>()

export async function gotoAuthenticated(
  page: Page,
  path: string,
): Promise<void> {
  if (!mockedSessions.has(page)) {
    mockedSessions.add(page)
    await page.route('**/api/auth/session', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          authenticated: true,
          account: {
            id: '70000000-0000-4000-8000-000000000001',
            email: 'browser-fixture@example.test',
            mustChangePassword: false,
          },
        }),
      }),
    )
  }
  await page.goto(`/login?${new URLSearchParams({ returnTo: path })}`)
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[?#]|$)`))
}

export async function loginResearcher(
  page: Page,
  email: string,
  password: string = E2E_PASSWORD,
): Promise<void> {
  const response = await page.request.post('/api/auth/login', {
    headers: { Origin: E2E_ORIGIN },
    data: { email, password },
  })
  expect(response.ok()).toBe(true)
}
