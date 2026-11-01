import type { Page } from '@playwright/test'

/** The workspace rail: the chat, and the views that open from it. */
export const workspaceRail = (page: Page) => page.getByRole('complementary', { name: 'Chat, template and results' })

/** Opens a rail view as the researcher does: back to the chat, then its context line (History: its button). */
export async function openRailView(page: Page, view: 'Template' | 'Results' | 'History') {
  const rail = workspaceRail(page)
  const back = rail.getByRole('button', { name: 'Back to chat' })
  if (await back.isVisible()) await back.click()
  await (view === 'History'
    ? rail.getByRole('button', { name: 'History', exact: true })
    : rail.getByRole('button', { name: new RegExp(`^Open ${view.toLowerCase()}:`) })).click()
}
