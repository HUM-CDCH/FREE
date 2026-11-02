import { expect, type Page } from '@playwright/test'

/** The workspace rail: the chat, and the views that open from it. */
export const workspaceRail = (page: Page) => page.getByRole('complementary', { name: 'Chat, template and results' })

/** Opens a rail view as the researcher does: back to the chat, then its context line (History: its button). */
export async function openRailView(page: Page, view: 'Template' | 'Results' | 'History') {
  const rail = workspaceRail(page)
  const back = rail.getByRole('button', { name: 'Back to chat' })
  // A value link lands on Results, so wait for the rail to show the chat or a view before choosing the way.
  await expect(back.or(rail.getByRole('navigation', { name: 'Template and results' })).first()).toBeVisible({ timeout: 20_000 })
  if (await back.isVisible()) await back.click()
  await (view === 'History'
    ? rail.getByRole('button', { name: 'History', exact: true })
    : rail.getByRole('button', { name: new RegExp(`^Open ${view.toLowerCase()}:`) })).click()
}
