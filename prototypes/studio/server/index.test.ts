import { afterEach, describe, expect, it, vi } from 'vitest'
import { runStudio } from './index.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the Studio command', () => {
  it('exits non-zero after a failed start, so a launched DBOS cannot keep a process without a listener alive', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const exit = vi.fn()

    await runStudio(
      () => Promise.reject(new Error("DATABASE_URL must name Studio's database.")),
      exit,
    )

    expect(error).toHaveBeenCalledWith("DATABASE_URL must name Studio's database.")
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('keeps running after a successful start', async () => {
    const exit = vi.fn()

    await runStudio(async () => undefined, exit)

    expect(exit).not.toHaveBeenCalled()
  })
})
