import { describe, expect, it } from 'vitest'
import { verifyPassword } from './password.js'
import {
  createPlaywrightAccountStore,
  PLAYWRIGHT_SECOND_RESEARCHER_EMAIL,
} from './playwright-auth.js'

describe('createPlaywrightAccountStore', () => {
  it('keeps two browser accounts independently addressable and mutable', async () => {
    const password = 'E2E authentication password 123!'
    const store = await createPlaywrightAccountStore(
      'browser-fixture@example.test',
      password,
    )

    const first = await store.findByEmail('browser-fixture@example.test')
    const second = await store.findByEmail(PLAYWRIGHT_SECOND_RESEARCHER_EMAIL)
    expect(first?.id).not.toBe(second?.id)
    expect(await verifyPassword(password, second!.passwordHash)).toBe(true)

    const disabledSecond = await store.disable(second!.id)
    expect(disabledSecond?.disabledAt).toBeInstanceOf(Date)
    expect((await store.findById(first!.id))?.disabledAt).toBeNull()
  })
})
