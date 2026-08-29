import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { decodeCanonicalSessionSecret } from 'studio-configuration'

const OWNER_READ_WRITE = 0o600

function readValidSecret(file) {
  try {
    const stored = readFileSync(file, 'utf8').trim()
    return decodeCanonicalSessionSecret(stored)?.byteLength >= 32
      ? stored
      : null
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function restrictToOwner(file) {
  // Windows accepts chmod but only maps its write bit to the read-only flag;
  // the user's ACL remains the authority there. On POSIX this removes group
  // and other access from both newly created and previously existing files.
  if (process.platform !== 'win32') chmodSync(file, OWNER_READ_WRITE)
}

// Development sessions outlive the dev server. Publish the first complete
// candidate atomically so concurrent launchers converge on one value.
export function ensureDevelopmentSessionSecret(file) {
  const stored = readValidSecret(file)
  if (stored !== null) {
    restrictToOwner(file)
    return stored
  }

  const generated = randomBytes(32).toString('base64')
  const contents = `${generated}\n`
  mkdirSync(dirname(file), { recursive: true })
  const candidate = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  writeFileSync(candidate, contents, { flag: 'wx', mode: OWNER_READ_WRITE })
  try {
    try {
      // Publish only a completely written candidate. A competing launcher can
      // either create this hard link first or observe its complete contents.
      linkSync(candidate, file)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const winner = readValidSecret(file)
      if (winner !== null) {
        restrictToOwner(file)
        return winner
      }
      // An existing invalid file has no signing value worth preserving.
      writeFileSync(file, contents, { mode: OWNER_READ_WRITE })
    }
  } finally {
    unlinkSync(candidate)
  }
  restrictToOwner(file)
  return generated
}
