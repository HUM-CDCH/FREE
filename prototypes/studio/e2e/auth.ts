import {
  expect,
  type Page,
  type Request,
  type Response,
} from '@playwright/test'
import { DEVELOPMENT_ENTRA_OBJECT_ID } from '../server/entraIdentityProvider.js'

const e2ePort = Number(process.env.FREE_PLAYWRIGHT_PORT ?? 41749)
export const E2E_ORIGIN = `http://localhost:${e2ePort}`
export const E2E_BASE_PATH = process.env.FREE_PLAYWRIGHT_BASE_PATH ?? '/'

export function e2eStudioPath(internalPath: string): string {
  if (!internalPath.startsWith('/') || internalPath.startsWith('//'))
    throw new Error('An E2E Studio path must start with one slash.')
  return E2E_BASE_PATH === '/'
    ? internalPath
    : `${E2E_BASE_PATH}${internalPath}`
}

const authenticatedPages = new WeakSet<Page>()

function responseSummary(response: Response): string {
  const { pathname } = new URL(response.url())
  const location = response.headers().location
  return `${response.status()} ${pathname}${location ? ` -> ${location}` : ''}`
}

export async function gotoAuthenticated(
  page: Page,
  path: string,
): Promise<void> {
  if (!authenticatedPages.has(page)) {
    authenticatedPages.add(page)
    await loginResearcher(page)
    // Broad API fixtures must not replace the real session lookup: the lazy
    // Research workspace module is protected by that same server session.
    await page.route(`**${e2eStudioPath('/api/auth/session')}`, (route) =>
      route.continue(),
    )
  }

  const workspaceResponses: string[] = []
  const failedRequests: string[] = []
  const recordResponse = (response: Response) => {
    const pathname = new URL(response.url()).pathname
    if (
      pathname === '/src/ProjectNavigation.tsx' ||
      response.status() >= 400
    )
      workspaceResponses.push(responseSummary(response))
  }
  const recordFailure = (request: Request) => {
    const failure = request.failure()
    failedRequests.push(
      `${request.method()} ${new URL(request.url()).pathname}: ${failure?.errorText ?? 'request failed'}`,
    )
  }
  page.on('response', recordResponse)
  page.on('requestfailed', recordFailure)
  const routedPath = e2eStudioPath(path)
  await page.goto(routedPath)
  try {
    await expect(page).toHaveURL(
      new RegExp(
        `${routedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[?#]|$)`,
      ),
    )
    await expect(
      page.getByRole('navigation', { name: 'Project Contexts' }),
    ).toBeVisible()
  } catch (cause) {
    const diagnostics = [...workspaceResponses, ...failedRequests].join('\n')
    throw new Error(
      `Authenticated workspace bootstrap failed.${diagnostics ? `\n${diagnostics}` : ''}`,
      { cause },
    )
  } finally {
    page.off('response', recordResponse)
    page.off('requestfailed', recordFailure)
  }
}

export async function loginResearcher(
  page: Page,
  objectId: string = DEVELOPMENT_ENTRA_OBJECT_ID,
): Promise<void> {
  const response = await page.request.get(
    `${e2eStudioPath('/auth/login')}?${new URLSearchParams({ testIdentity: objectId })}`,
  )
  expect(response.ok()).toBe(true)
}
