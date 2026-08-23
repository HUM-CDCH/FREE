import './env.js'
import { resolve } from 'node:path'
import { emitKeypressEvents } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { createResearcherAccountStore, db } from 'db'
import type { ResearcherAccountStore } from 'db'
import {
  hashPassword,
  PasswordPolicyError,
  validatePassword,
} from './password.js'

type AccountCommand = 'create' | 'reset-password' | 'disable'
type CliInput = NodeJS.ReadableStream & {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode?: (mode: boolean) => void
}
type CliWriter = Pick<NodeJS.WritableStream, 'write'>
type Keypress = { name?: string; ctrl?: boolean; meta?: boolean }

export type AccountCliOptions = {
  store: ResearcherAccountStore
  input?: CliInput
  output?: CliWriter
  errorOutput?: CliWriter
}

const USAGE = 'Usage: pnpm account <create|reset-password|disable> <email>'
const OPERATION_FAILED = 'Account operation failed.'

class PasswordInputError extends Error {}
class PasswordMismatchError extends Error {}

function writeLine(writer: CliWriter, message: string): void {
  writer.write(`${message}\n`)
}

function parseCommand(
  argv: readonly string[],
): { command: AccountCommand; email: string } | undefined {
  if (argv.length !== 2 || argv[1] === '') return undefined
  const command = argv[0]
  if (
    command !== 'create' &&
    command !== 'reset-password' &&
    command !== 'disable'
  ) {
    return undefined
  }
  return { command, email: argv[1]! }
}

function removeLastScalar(value: string): string {
  if (value.length === 0) return value
  const last = value.charCodeAt(value.length - 1)
  if (
    last >= 0xdc00 &&
    last <= 0xdfff &&
    value.length > 1 &&
    value.charCodeAt(value.length - 2) >= 0xd800 &&
    value.charCodeAt(value.length - 2) <= 0xdbff
  ) {
    return value.slice(0, -2)
  }
  return value.slice(0, -1)
}

async function readPipedPassword(input: CliInput): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of input as AsyncIterable<string | Uint8Array>) {
    chunks.push(Buffer.from(chunk))
  }

  let password: string
  try {
    password = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(Buffer.concat(chunks))
  } catch {
    throw new PasswordInputError()
  }

  if (password.endsWith('\r\n')) return password.slice(0, -2)
  if (password.endsWith('\n')) return password.slice(0, -1)
  return password
}

function readHiddenPassword(
  input: CliInput,
  errorOutput: CliWriter,
  prompt: string,
): Promise<string> {
  if (!input.setRawMode) throw new PasswordInputError()

  const setRawMode = input.setRawMode.bind(input)
  const wasRaw = input.isRaw === true
  emitKeypressEvents(input)
  writeLine(errorOutput, prompt)

  return new Promise((resolvePassword, rejectPassword) => {
    let password = ''
    let settled = false

    const finish = (result?: string, error?: PasswordInputError) => {
      if (settled) return
      settled = true
      input.removeListener('keypress', onKeypress)
      input.removeListener('error', onError)
      if (!wasRaw) setRawMode(false)
      input.pause()
      if (error) rejectPassword(error)
      else resolvePassword(result!)
    }
    const onError = () => finish(undefined, new PasswordInputError())
    const onKeypress = (value: string, key: Keypress) => {
      if (key.name === 'return' || key.name === 'enter') {
        finish(password)
      } else if (key.ctrl && key.name === 'c') {
        finish(undefined, new PasswordInputError())
      } else if (key.name === 'backspace') {
        password = removeLastScalar(password)
      } else if (!key.ctrl && !key.meta && value) {
        password += value
      }
    }

    input.on('keypress', onKeypress)
    input.once('error', onError)
    setRawMode(true)
    input.resume()
  })
}

async function readPassword(
  input: CliInput,
  errorOutput: CliWriter,
): Promise<string> {
  if (!input.isTTY) return readPipedPassword(input)
  const password = await readHiddenPassword(input, errorOutput, 'Password:')
  const confirmation = await readHiddenPassword(
    input,
    errorOutput,
    'Confirm password:',
  )
  if (password !== confirmation) throw new PasswordMismatchError()
  return password
}

async function createAccount(
  email: string,
  password: string,
  store: ResearcherAccountStore,
  output: CliWriter,
  errorOutput: CliWriter,
): Promise<number> {
  if (await store.findByEmail(email)) {
    writeLine(errorOutput, 'Researcher Account already exists.')
    return 1
  }

  const passwordHash = await hashPassword(password)
  await store.create(email, passwordHash)
  writeLine(output, 'Researcher Account created.')
  return 0
}

async function resetPassword(
  email: string,
  password: string,
  store: ResearcherAccountStore,
  output: CliWriter,
  errorOutput: CliWriter,
): Promise<number> {
  const account = await store.findByEmail(email)
  if (!account) {
    writeLine(errorOutput, 'Researcher Account not found.')
    return 1
  }

  const passwordHash = await hashPassword(password)
  const updated = await store.replacePassword(
    account.id,
    account.sessionVersion,
    passwordHash,
    true,
  )
  if (!updated) {
    writeLine(errorOutput, 'Researcher Account not found.')
    return 1
  }

  writeLine(output, 'Researcher Account password reset.')
  return 0
}

async function disableAccount(
  email: string,
  store: ResearcherAccountStore,
  output: CliWriter,
  errorOutput: CliWriter,
): Promise<number> {
  const account = await store.findByEmail(email)
  if (!account) {
    writeLine(errorOutput, 'Researcher Account not found.')
    return 1
  }

  const updated = await store.disable(account.id)
  if (!updated) {
    writeLine(errorOutput, 'Researcher Account not found.')
    return 1
  }

  writeLine(output, 'Researcher Account disabled.')
  return 0
}

export async function runAccountCli(
  argv: readonly string[],
  options: AccountCliOptions,
): Promise<number> {
  const parsed = parseCommand(argv)
  const output = options.output ?? process.stdout
  const errorOutput = options.errorOutput ?? process.stderr
  if (!parsed) {
    writeLine(errorOutput, USAGE)
    return 2
  }

  let password: string | undefined
  if (parsed.command !== 'disable') {
    try {
      password = await readPassword(options.input ?? process.stdin, errorOutput)
      validatePassword(password)
    } catch (error) {
      if (error instanceof PasswordPolicyError) {
        writeLine(errorOutput, error.message)
      } else if (error instanceof PasswordMismatchError) {
        writeLine(errorOutput, 'Passwords do not match.')
      } else {
        writeLine(errorOutput, 'Unable to read password.')
      }
      return 1
    }
  }

  try {
    switch (parsed.command) {
      case 'create':
        return await createAccount(
          parsed.email,
          password!,
          options.store,
          output,
          errorOutput,
        )
      case 'reset-password':
        return await resetPassword(
          parsed.email,
          password!,
          options.store,
          output,
          errorOutput,
        )
      case 'disable':
        return await disableAccount(
          parsed.email,
          options.store,
          output,
          errorOutput,
        )
    }
  } catch {
    writeLine(errorOutput, OPERATION_FAILED)
    return 1
  }
}

async function runFromProcess(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    writeLine(process.stderr, 'DATABASE_URL is required.')
    return 1
  }

  try {
    const store = createResearcherAccountStore()
    return await runAccountCli(process.argv.slice(2), {
      store,
    })
  } catch {
    writeLine(process.stderr, OPERATION_FAILED)
    return 1
  } finally {
    await db.close().catch(() => undefined)
  }
}

const invokedPath = process.argv[1]
if (
  invokedPath &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  void runFromProcess().then((exitCode) => {
    process.exitCode = exitCode
  })
}
