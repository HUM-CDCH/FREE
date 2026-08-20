import { PassThrough, Readable, Writable } from 'node:stream'
import type {
  ResearcherAccountRecord,
  ResearcherAccountStore,
} from 'db'
import { describe, expect, it, vi } from 'vitest'
import { runAccountCli } from './account-cli.js'
import { verifyPassword } from './password.js'

const email = 'researcher@example.test'
const temporaryPassword = 'temporary-password'
const replacementPassword = 'replacement-password'

function account(
  overrides: Partial<ResearcherAccountRecord> = {},
): ResearcherAccountRecord {
  return {
    id: 'account-id',
    email,
    passwordHash: 'stored-password-hash',
    mustChangePassword: true,
    disabledAt: null,
    sessionVersion: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

function accountStore(
  overrides: Partial<ResearcherAccountStore> = {},
): ResearcherAccountStore {
  return {
    create: vi.fn(async (createdEmail: string, passwordHash: string) =>
      account({ email: createdEmail.trim().toLowerCase(), passwordHash }),
    ),
    findByEmail: vi.fn(async () => null),
    findById: vi.fn(async () => null),
    replacePassword: vi.fn(
      async (_id, _expectedSessionVersion, passwordHash, mustChangePassword) =>
        account({ passwordHash, mustChangePassword, sessionVersion: 1 }),
    ),
    disable: vi.fn(async () =>
      account({ disabledAt: new Date('2026-01-02T00:00:00.000Z'), sessionVersion: 1 }),
    ),
    ...overrides,
  }
}

function capture() {
  let text = ''
  const writer = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { writer, text: () => text }
}

async function run(
  argv: readonly string[],
  store: ResearcherAccountStore,
  passwordInput = '',
) {
  const output = capture()
  const errorOutput = capture()
  const exitCode = await runAccountCli(argv, {
    store,
    input: Readable.from([passwordInput]),
    output: output.writer,
    errorOutput: errorOutput.writer,
  })
  return { exitCode, output: output.text(), error: errorOutput.text() }
}

describe('account CLI operations', () => {
  it('creates through the account store with a validated hidden representation', async () => {
    const store = accountStore()
    const result = await run(
      ['create', ' Researcher@Example.Test '],
      store,
      `${temporaryPassword}\n`,
    )

    expect(result).toEqual({
      exitCode: 0,
      output: 'Researcher Account created.\n',
      error: '',
    })
    expect(store.findByEmail).toHaveBeenCalledWith(' Researcher@Example.Test ')
    expect(store.create).toHaveBeenCalledOnce()
    const [createdEmail, passwordHash] = vi.mocked(store.create).mock.calls[0]!
    expect(createdEmail).toBe(' Researcher@Example.Test ')
    await expect(
      verifyPassword(temporaryPassword, passwordHash),
    ).resolves.toBe(true)
    expect(result.output).not.toContain(temporaryPassword)
    expect(result.error).not.toContain(temporaryPassword)
  })

  it('resets through the store with mandatory change and session revocation semantics', async () => {
    const existing = account({ mustChangePassword: false, sessionVersion: 4 })
    const store = accountStore({ findByEmail: vi.fn(async () => existing) })
    const result = await run(
      ['reset-password', email],
      store,
      `${replacementPassword}\r\n`,
    )

    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('Researcher Account password reset.\n')
    expect(store.replacePassword).toHaveBeenCalledOnce()
    const [id, expectedSessionVersion, passwordHash, mustChangePassword] =
      vi.mocked(store.replacePassword).mock.calls[0]!
    expect(id).toBe(existing.id)
    expect(expectedSessionVersion).toBe(existing.sessionVersion)
    expect(mustChangePassword).toBe(true)
    await expect(
      verifyPassword(replacementPassword, passwordHash),
    ).resolves.toBe(true)
  })

  it('disables through the store session-revoking operation without reading a password', async () => {
    const existing = account({ sessionVersion: 7 })
    const store = accountStore({ findByEmail: vi.fn(async () => existing) })
    const result = await run(['disable', email], store, 'not-a-password')

    expect(result).toEqual({
      exitCode: 0,
      output: 'Researcher Account disabled.\n',
      error: '',
    })
    expect(store.disable).toHaveBeenCalledWith(existing.id)
  })
})

describe('account CLI failures', () => {
  it('rejects an email duplicate regardless of the supplied casing', async () => {
    const store = accountStore({
      findByEmail: vi.fn(async () => account()),
    })
    const result = await run(
      ['create', 'RESEARCHER@EXAMPLE.TEST'],
      store,
      temporaryPassword,
    )

    expect(result).toEqual({
      exitCode: 1,
      output: '',
      error: 'Researcher Account already exists.\n',
    })
    expect(store.findByEmail).toHaveBeenCalledWith('RESEARCHER@EXAMPLE.TEST')
    expect(store.create).not.toHaveBeenCalled()
  })

  it.each(['reset-password', 'disable'] as const)(
    'reports a missing account for %s without a mutation',
    async (command) => {
      const store = accountStore()
      const result = await run(
        [command, email],
        store,
        command === 'reset-password' ? replacementPassword : '',
      )

      expect(result).toEqual({
        exitCode: 1,
        output: '',
        error: 'Researcher Account not found.\n',
      })
      expect(store.replacePassword).not.toHaveBeenCalled()
      expect(store.disable).not.toHaveBeenCalled()
    },
  )

  it.each(['create', 'reset-password'] as const)(
    'rejects an invalid password before account persistence for %s',
    async (command) => {
      const store = accountStore({
        findByEmail: vi.fn(async () => account()),
      })
      const result = await run([command, email], store, 'short')

      expect(result).toEqual({
        exitCode: 1,
        output: '',
        error:
          'Password must contain 6 through 128 Unicode scalar values.\n',
      })
      expect(store.findByEmail).not.toHaveBeenCalled()
      expect(store.create).not.toHaveBeenCalled()
      expect(store.replacePassword).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      command: 'create' as const,
      store: () =>
        accountStore({
          findByEmail: vi.fn(async () => {
            throw new Error('private database diagnostic')
          }),
        }),
      password: temporaryPassword,
    },
    {
      command: 'reset-password' as const,
      store: () =>
        accountStore({
          findByEmail: vi.fn(async () => account()),
          replacePassword: vi.fn(async () => {
            throw new Error('private database diagnostic')
          }),
        }),
      password: replacementPassword,
    },
    {
      command: 'disable' as const,
      store: () =>
        accountStore({
          findByEmail: vi.fn(async () => account()),
          disable: vi.fn(async () => {
            throw new Error('private database diagnostic')
          }),
        }),
      password: '',
    },
  ])(
    'uses a stable nonzero failure for $command persistence errors',
    async ({ command, store: makeStore, password }) => {
      const result = await run([command, email], makeStore(), password)

      expect(result).toEqual({
        exitCode: 1,
        output: '',
        error: 'Account operation failed.\n',
      })
      expect(result.error).not.toContain('private database diagnostic')
    },
  )

  it.each(['create', 'reset-password'] as const)(
    'has no password argument channel for %s',
    async (command) => {
      const passwordInArguments = 'must-never-be-accepted-from-argv'
      const store = accountStore()
      const result = await run(
        [command, email, passwordInArguments],
        store,
        temporaryPassword,
      )

      expect(result).toEqual({
        exitCode: 2,
        output: '',
        error:
          'Usage: pnpm account <create|reset-password|disable> <email>\n',
      })
      expect(result.error).not.toContain(passwordInArguments)
      expect(store.findByEmail).not.toHaveBeenCalled()
      expect(store.create).not.toHaveBeenCalled()
      expect(store.replacePassword).not.toHaveBeenCalled()
    },
  )
})

describe('interactive password input', () => {
  it('reads a TTY password with echo disabled', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean
      isRaw: boolean
      setRawMode(mode: boolean): void
    }
    const rawModes: boolean[] = []
    input.isTTY = true
    input.isRaw = false
    input.setRawMode = (mode) => {
      input.isRaw = mode
      rawModes.push(mode)
    }
    const output = capture()
    const errorOutput = capture()
    const store = accountStore()

    const running = runAccountCli(['create', email], {
      store,
      input,
      output: output.writer,
      errorOutput: errorOutput.writer,
    })
    input.write(`${temporaryPassword}\r`)
    await vi.waitFor(() => expect(rawModes).toEqual([true, false, true]))
    input.end(`${temporaryPassword}\r`)
    const exitCode = await running

    expect(exitCode).toBe(0)
    expect(rawModes).toEqual([true, false, true, false])
    expect(errorOutput.text()).toBe('Password:\nConfirm password:\n')
    expect(errorOutput.text()).not.toContain(temporaryPassword)
  })

  it('rejects a mismatched TTY confirmation without persistence', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean
      isRaw: boolean
      setRawMode(mode: boolean): void
    }
    input.isTTY = true
    input.isRaw = false
    input.setRawMode = (mode) => {
      input.isRaw = mode
    }
    const output = capture()
    const errorOutput = capture()
    const store = accountStore()

    const running = runAccountCli(['create', email], {
      store,
      input,
      output: output.writer,
      errorOutput: errorOutput.writer,
    })
    input.write(`${temporaryPassword}\r`)
    await vi.waitFor(() =>
      expect(errorOutput.text()).toBe('Password:\nConfirm password:\n'),
    )
    input.end(`${replacementPassword}\r`)

    await expect(running).resolves.toBe(1)
    expect(errorOutput.text()).toBe(
      'Password:\nConfirm password:\nPasswords do not match.\n',
    )
    expect(store.findByEmail).not.toHaveBeenCalled()
    expect(store.create).not.toHaveBeenCalled()
  })
})
