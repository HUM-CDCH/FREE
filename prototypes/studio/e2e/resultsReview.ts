import { expect, type Page } from '@playwright/test'

/** A decided or decidable value's row in the Results rail (results review redesign §3.2): a button named
 *  "{state} {name} {value} {chip}". Selecting it shows its Evidence on the page and opens its decision. */
export function reviewRow(page: Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return page.getByRole('tabpanel', { name: /Results/ })
    .getByRole('button', { name: new RegExp(`^(To check|Approved|Edited|Rejected) ${escaped} `) })
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
