import { rm } from 'node:fs/promises'
import { teardownPlaywrightStack } from './playwrightStack.js'

/** Stops the run's stack, then removes the source inbox its config made for Studio (FREE_PLAYWRIGHT_SOURCE_INBOX). */
export default async function globalTeardown(): Promise<void> {
  try {
    await teardownPlaywrightStack()
  } finally {
    const inbox = process.env.FREE_PLAYWRIGHT_SOURCE_INBOX
    if (inbox) await rm(inbox, { recursive: true, force: true })
  }
}
