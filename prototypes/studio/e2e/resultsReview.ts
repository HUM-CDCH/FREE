import { expect, type Page } from '@playwright/test'

/** A decided or decidable value's row in the Results rail (results review redesign §3.2): a button named
 *  "{state} {path › name} {value} {chip}", the path's leading steps optional ("sites › 1 › site" is a `site`).
 *  Selecting it shows its Evidence on the page and opens its decision. */
export function reviewRow(page: Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return page.getByRole('tabpanel', { name: /Results/ })
    .getByRole('button', { name: new RegExp(`^(To check|Approved|Edited|Rejected) (?:\\S+ › )*${escaped} `) })
}

/** A record section's header in the Results rail (§3.1), by its label; it opens and closes the record. */
export function recordHeader(page: Page, label: string | RegExp) {
  return page.getByRole('tabpanel', { name: /Results/ }).getByRole('region', { name: typeof label === 'string' ? new RegExp(`^${label}, `) : label })
    .getByRole('button', { expanded: false }).first()
}

/** Opens record `index` (in source order) when its section is collapsed; a single record's values are flat. */
export async function openRecord(page: Page, index: number) {
  const header = page.getByRole('tabpanel', { name: /Results/ }).locator('section[aria-label]:not([aria-label="Document"])')
    .nth(index).locator('button[aria-expanded]').first()
  if (await header.count() === 0) return
  if (await header.getAttribute('aria-expanded') === 'false') await header.click()
}

/** "Approve rest…" and its confirmation: approves every value still to check and saves the review (§3.6). */
export async function approveRest(page: Page) {
  const button = page.getByRole('tabpanel', { name: /Results/ }).getByRole('button', { name: 'Approve rest…', exact: true })
  await expect(button).toBeEnabled()
  await button.focus()
  await page.keyboard.press('Enter')
  const confirm = page.getByRole('dialog', { name: 'Approve the rest and save the review', exact: true })
  const approve = confirm.getByRole('button', { name: /^Approve \d+ and save review$/ })
  await expect(approve).toBeEnabled()
  await approve.focus()
  await page.keyboard.press('Enter')
}
