import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Worker } from 'node:worker_threads'
import { strToU8 } from 'fflate'
import {
  createCanonicalPackageStore,
  createWorkerLane,
  packCanonicalPackage,
} from './artifact-store.js'

const sha256 = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex')

function canonicalPackage() {
  const pdf = strToU8('%PDF-1.7\nfixture')
  return packCanonicalPackage({
    pdf,
    document: {
      schema_version: 'parsed_document.v2',
      document: { content_sha256: sha256(pdf) },
      preprocessing: { preprocess_id: 'fixture-preprocess' },
      arbitration: { primary_document_parser: 'docling_pdf' },
      parser_runs: [{ parser: 'docling_pdf', version: '2.0.0' }],
    },
    markdown: '# Durable Source Document\n',
  })
}

function otherPackage() {
  const pdf = strToU8('%PDF-1.7\nanother fixture')
  return packCanonicalPackage({
    pdf,
    document: {
      schema_version: 'parsed_document.v2',
      document: { content_sha256: sha256(pdf) },
      preprocessing: { preprocess_id: 'fixture-preprocess' },
    },
    markdown: '# Another Source Document\n',
  })
}

const DAY_MS = 24 * 3600_000

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'free-package-sweep-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function backdate(path: string, ageMs: number) {
  const then = new Date(Date.now() - ageMs)
  await utimes(path, then, then)
}

describe('canonical package store', () => {
  it('reopens owned artifacts without the Parsing Service task cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'free-owned-artifacts-'))
    try {
      const firstCheckout = createCanonicalPackageStore(root)
      const stored = await firstCheckout.save(canonicalPackage())
      assert.equal(stored.published, true)

      // A fresh store instance stands in for another checkout/process. It knows
      // only the durable descriptor, never the Parsing Service task identity.
      const secondCheckout = createCanonicalPackageStore(root)
      assert.equal((await secondCheckout.save(canonicalPackage())).published, false)
      const source = await secondCheckout.read(stored, 'source')
      const document = JSON.parse(new TextDecoder().decode(source.bytes))

      assert.equal(document.schema_version, 'parsed_document.v2')
      assert.equal((await secondCheckout.read(stored, 'pdf')).bytes[0], 0x25)
      assert.equal(
        new TextDecoder().decode(
          (await secondCheckout.read(stored, 'markdown')).bytes,
        ),
        '# Durable Source Document\n',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes an unreferenced package idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'free-package-removal-'))
    try {
      const store = createCanonicalPackageStore(root)
      const stored = await store.save(canonicalPackage())
      assert.equal(await store.remove(stored, async () => false), true)
      assert.equal(await store.available(stored), false)
      assert.equal(await store.remove(stored, async () => false), false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a package republished while its removal is quarantined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'free-package-republish-'))
    try {
      const bytes = canonicalPackage()
      const store = createCanonicalPackageStore(root)
      const stored = await store.save(bytes)
      const canonical = join(root, `${stored.artifactReference}.zip`)
      await backdate(canonical, 2 * DAY_MS)
      let reads = 0
      let republished: { ino: number; mtimeMs: number } | undefined

      // Unreferenced at the first read; a writer publishes it again during the quarantine and references it.
      assert.equal(
        await store.remove(stored, async () => {
          if (++reads === 1) return false
          assert.equal((await store.save(bytes)).published, true)
          republished = await lstat(canonical)
          return true
        }, { modifiedBeforeMs: Date.now() - DAY_MS }),
        false,
      )
      // The writer's file stays, with the fresh age a later sweep's cutoff reads; the quarantine is gone.
      const kept = await lstat(canonical)
      assert.deepEqual({ ino: kept.ino, mtimeMs: kept.mtimeMs }, { ino: republished!.ino, mtimeMs: republished!.mtimeMs })
      assert.deepEqual(await readdir(root), [`${stored.artifactReference}.zip`])
      assert.equal(await store.available(stored), true)

      // An invalid file appearing under the canonical name during a quarantine is not replaced either, and the
      // quarantine, the valid copy, stays.
      reads = 0
      await assert.rejects(store.remove(stored, async () => {
        if (++reads === 1) return false
        await writeFile(canonical, 'not a package')
        return true
      }), /integrity/)
      assert.equal(await readFile(canonical, 'utf8'), 'not a package')
      const [quarantine] = (await readdir(root)).filter((name) => name.endsWith('.deleting'))
      assert.deepEqual(await readFile(join(root, quarantine)), Buffer.from(bytes))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists stored packages with their modification times and ignores other names', async () => {
    await withRoot(async (root) => {
      const store = createCanonicalPackageStore(root)
      const first = await store.save(canonicalPackage())
      const second = await store.save(otherPackage())
      await writeFile(join(root, 'README'), 'not a package')
      await mkdir(join(root, `${'a'.repeat(64)}.zip`))

      const listed = [...(await store.list())].sort((a, b) =>
        a.descriptor.artifactReference.localeCompare(b.descriptor.artifactReference),
      )
      const expected = await Promise.all(
        [first, second]
          .map(({ artifactReference, artifactSha256 }) => ({ artifactReference, artifactSha256 }))
          .sort((a, b) => a.artifactReference.localeCompare(b.artifactReference))
          .map(async (descriptor) => ({
            descriptor,
            modifiedMs: (await lstat(join(root, `${descriptor.artifactReference}.zip`))).mtimeMs,
          })),
      )
      assert.deepEqual(listed, expected)
      assert.deepEqual(await createCanonicalPackageStore(join(root, 'missing')).list(), [])
    })
  })

  it('lists .tmp and .deleting leftovers and removes only names of that shape', async () => {
    await withRoot(async (base) => {
      const root = join(base, 'packages')
      await mkdir(root)
      await writeFile(join(base, 'x'), 'outside the store')
      const store = createCanonicalPackageStore(root)
      const reference = 'b'.repeat(64)
      const temporary = `${reference}.${randomUUID()}.tmp`
      const deleting = `${reference}.${randomUUID()}.deleting`
      for (const name of [temporary, deleting, 'notes.tmp']) await writeFile(join(root, name), 'leftover')

      const leftovers = [...(await store.leftovers())].sort((a, b) => a.name.localeCompare(b.name))
      assert.deepEqual(
        leftovers,
        await Promise.all(
          [deleting, temporary].sort().map(async (name) => ({ name, modifiedMs: (await lstat(join(root, name))).mtimeMs })),
        ),
      )
      const unreferenced = async () => false
      await assert.rejects(store.removeLeftover('../x', unreferenced), /leftover/)
      await assert.rejects(store.removeLeftover('notes.tmp', unreferenced), /leftover/)
      assert.deepEqual((await readdir(root)).sort(), [deleting, 'notes.tmp', temporary].sort())
      assert.deepEqual((await readdir(base)).sort(), ['packages', 'x'])

      assert.equal(await store.removeLeftover(temporary, unreferenced), true)
      // Not a valid package: never promoted, and kept as the only evidence of what the removal held.
      assert.equal(await store.removeLeftover(deleting, unreferenced), false)
      assert.deepEqual((await readdir(root)).sort(), [deleting, 'notes.tmp'].sort())
      assert.deepEqual(await createCanonicalPackageStore(join(base, 'missing')).leftovers(), [])
    })
  })

  it('a package reused while it is being swept is restored', async () => {
    await withRoot(async (root) => {
      const store = createCanonicalPackageStore(root)
      const stored = await store.save(canonicalPackage())
      await backdate(join(root, `${stored.artifactReference}.zip`), 2 * DAY_MS)

      // The sweep judged it old; a writer reuses it before the sweep quarantines it.
      assert.equal((await store.save(canonicalPackage())).published, false)
      assert.equal(await store.remove(stored, async () => false, { modifiedBeforeMs: Date.now() - DAY_MS }), false)
      assert.equal(await store.available(stored), true)
      assert.deepEqual(await readdir(root), [`${stored.artifactReference}.zip`])
    })
  })

  it('saving a package the sweep has quarantined publishes it again', async () => {
    await withRoot(async (root) => {
      const store = createCanonicalPackageStore(root)
      const stored = await store.save(canonicalPackage())
      await rename(
        join(root, `${stored.artifactReference}.zip`),
        join(root, `${stored.artifactReference}.${randomUUID()}.deleting`),
      )

      assert.equal((await store.save(canonicalPackage())).published, true)
      assert.equal(await store.available(stored), true)
    })
  })

  it('remove still deletes an old unreferenced package', async () => {
    await withRoot(async (root) => {
      const store = createCanonicalPackageStore(root)
      const stored = await store.save(canonicalPackage())
      await backdate(join(root, `${stored.artifactReference}.zip`), 2 * DAY_MS)

      assert.equal(await store.remove(stored, async () => false, { modifiedBeforeMs: Date.now() - DAY_MS }), true)
      assert.equal(await store.available(stored), false)
      assert.deepEqual(await readdir(root), [])
    })
  })
})

const STORE_MODULE = new URL('./artifact-store.ts', import.meta.url).href

/**
 * Runs `body` in a separate Node process (with this test's loader), with `store`, `root` and `descriptor` bound: from
 * a script file, or, with `evaluated`, as `node --input-type=module -e` input.
 */
function storeProcess(root: string, descriptor: object, body: string, { evaluated = false } = {}) {
  const source = `
    const { createCanonicalPackageStore } = await import(${JSON.stringify(STORE_MODULE)})
    const root = ${JSON.stringify(root)}
    const descriptor = ${JSON.stringify(descriptor)}
    const store = createCanonicalPackageStore(root)
    ${body}
  `
  const script = join(tmpdir(), `free-store-process-${randomUUID()}.mts`)
  if (!evaluated) writeFileSync(script, source)
  const child = spawn(process.execPath,
    [...process.execArgv, ...(evaluated ? ['--input-type=module', '-e', source] : [script])],
    { stdio: ['ignore', 'pipe', 'inherit'] })
  child.once('exit', () => rmSync(script, { force: true }))
  let output = ''
  const line = (expected: string) => new Promise<void>((resolve, reject) => {
    const seen = () => { if (output.includes(expected)) resolve() }
    child.stdout.on('data', (chunk) => { output += chunk; seen() })
    child.once('exit', (code, signal) => reject(new Error(`exited ${code ?? signal} before "${expected}": ${output}`)))
    seen()
  })
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })))
  return { child, line, exited }
}

/** A removal killed between its quarantine and its decision: the package is left only under `<sha>.<uuid>.deleting`. */
async function crashedRemoval(root: string, descriptor: { artifactReference: string }) {
  const removal = storeProcess(root, descriptor, `
    const { existsSync } = await import('node:fs')
    setInterval(() => {}, 1000)
    // Unreferenced; once the package is quarantined, its reference read never answers, and the process is killed.
    await store.remove(descriptor, () => {
      if (existsSync(root + '/' + descriptor.artifactReference + '.zip')) return Promise.resolve(false)
      console.log('quarantined')
      return new Promise(() => {})
    })
    process.exit(3)
  `)
  await removal.line('quarantined')
  removal.child.kill('SIGKILL')
  assert.deepEqual(await removal.exited, { code: null, signal: 'SIGKILL' })
  const names = await readdir(root)
  assert.equal(names.length, 1)
  assert.match(names[0], new RegExp(`^${descriptor.artifactReference}\\.[0-9a-f-]{36}\\.deleting$`))
  return names[0]
}

describe('canonical package quarantine recovery', () => {
  it('a referenced package keeps its canonical name while its removal checks references', async () => {
    await withRoot(async (root) => {
      const store = createCanonicalPackageStore(root)
      const stored = await store.save(canonicalPackage())
      const seen: string[] = []
      assert.equal(await store.remove(stored, async () => {
        seen.push(new TextDecoder().decode((await store.read(stored, 'markdown')).bytes))
        return true
      }), false)
      assert.deepEqual(seen, ['# Durable Source Document\n'])
      assert.deepEqual(await readdir(root), [`${stored.artifactReference}.zip`])
    })
  })

  it('a process that reads after a removal was killed in its quarantine recovers the same package', async () => {
    await withRoot(async (root) => {
      const bytes = canonicalPackage()
      const stored = await createCanonicalPackageStore(root).save(bytes)
      const quarantine = await crashedRemoval(root, stored)

      const reader = storeProcess(root, stored, `
        const read = await store.read(descriptor, 'markdown')
        console.log(JSON.stringify({ markdown: new TextDecoder().decode(read.bytes), available: await store.available(descriptor) }))
      `)
      await reader.line('available')
      assert.deepEqual(await reader.exited, { code: 0, signal: null })

      const canonical = join(root, `${stored.artifactReference}.zip`)
      assert.deepEqual(await readFile(canonical), Buffer.from(bytes))
      // Linked, not moved: the quarantine is still there for the removal (or sweep) that owns it.
      assert.equal((await lstat(join(root, quarantine))).ino, (await lstat(canonical)).ino)
    })
  })

  it('an aged quarantine of a still-referenced package is reinstalled and swept through a fresh reference read', async () => {
    await withRoot(async (root) => {
      const bytes = canonicalPackage()
      const stored = await createCanonicalPackageStore(root).save(bytes)
      const quarantine = await crashedRemoval(root, stored)
      await backdate(join(root, quarantine), 2 * DAY_MS)
      const store = createCanonicalPackageStore(root)

      const asked: string[] = []
      assert.equal(await store.removeLeftover(quarantine, async (reference) => {
        asked.push(reference)
        return true
      }, { modifiedBeforeMs: Date.now() - DAY_MS }), true)
      assert.deepEqual(asked, [stored.artifactReference])
      assert.deepEqual(await readdir(root), [`${stored.artifactReference}.zip`])
      assert.deepEqual(await readFile(join(root, `${stored.artifactReference}.zip`)), Buffer.from(bytes))
    })
  })

  it('an aged quarantine whose package lost its last reference is removed', async () => {
    await withRoot(async (root) => {
      const stored = await createCanonicalPackageStore(root).save(canonicalPackage())
      const quarantine = await crashedRemoval(root, stored)
      await backdate(join(root, quarantine), 2 * DAY_MS)

      const store = createCanonicalPackageStore(root)
      assert.equal(await store.removeLeftover(quarantine, async () => false, { modifiedBeforeMs: Date.now() - DAY_MS }), true)
      assert.deepEqual(await readdir(root), [])
      assert.equal(await store.available(stored), false)
    })
  })

  it('keeps the quarantine when the reference read fails', async () => {
    await withRoot(async (root) => {
      const bytes = canonicalPackage()
      const stored = await createCanonicalPackageStore(root).save(bytes)
      const quarantine = await crashedRemoval(root, stored)
      await backdate(join(root, quarantine), 2 * DAY_MS)

      const store = createCanonicalPackageStore(root)
      await assert.rejects(store.removeLeftover(quarantine, async () => {
        throw new Error('database unavailable')
      }, { modifiedBeforeMs: Date.now() - DAY_MS }), /database unavailable/)
      assert.deepEqual(await readFile(join(root, quarantine)), Buffer.from(bytes))
      assert.equal(await store.available(stored), true)
    })
  })

  it('never promotes a truncated, altered or symbolic-link quarantine', async () => {
    await withRoot(async (base) => {
      const root = join(base, 'packages')
      await mkdir(root)
      const bytes = canonicalPackage()
      const stored = await createCanonicalPackageStore(join(base, 'elsewhere')).save(bytes)
      const truncated = `${stored.artifactReference}.${randomUUID()}.deleting`
      const altered = `${stored.artifactReference}.${randomUUID()}.deleting`
      const linked = `${stored.artifactReference}.${randomUUID()}.deleting`
      await writeFile(join(root, truncated), bytes.subarray(0, bytes.byteLength - 10))
      const changed = Buffer.from(bytes)
      changed[changed.indexOf('fixture')] ^= 1
      await writeFile(join(root, altered), changed)
      await symlink(join(base, 'elsewhere', `${stored.artifactReference}.zip`), join(root, linked))
      const store = createCanonicalPackageStore(root)

      await assert.rejects(store.read(stored, 'pdf'), { code: 'ENOENT' })
      assert.equal(await store.available(stored), false)
      for (const name of [truncated, altered, linked])
        assert.equal(await store.removeLeftover(name, async () => false), false)
      assert.deepEqual((await readdir(root)).sort(), [altered, linked, truncated].sort())
    })
  })

  it('never replaces a canonical file another writer published, and keeps a valid quarantine beside an invalid one', async () => {
    await withRoot(async (root) => {
      const bytes = canonicalPackage()
      const store = createCanonicalPackageStore(root)
      const stored = await store.save(bytes)
      const canonical = join(root, `${stored.artifactReference}.zip`)
      const quarantine = `${stored.artifactReference}.${randomUUID()}.deleting`
      await copyFile(canonical, join(root, quarantine))

      // A valid winner stays the same file; the quarantine then goes through the ordinary (referenced) removal.
      const winner = (await lstat(canonical)).ino
      assert.equal(await store.removeLeftover(quarantine, async () => true), true)
      assert.equal((await lstat(canonical)).ino, winner)

      // An invalid file under the canonical name is left alone, and so is the verified quarantine.
      await copyFile(canonical, join(root, quarantine))
      await writeFile(canonical, 'not a package')
      assert.equal(await store.removeLeftover(quarantine, async () => false), false)
      assert.equal(await readFile(canonical, 'utf8'), 'not a package')
      assert.deepEqual(await readFile(join(root, quarantine)), Buffer.from(bytes))
    })
  })

  it('processes recovering one quarantine while another publishes the package all read the same file', async () => {
    await withRoot(async (root) => {
      const bytes = canonicalPackage()
      const stored = await createCanonicalPackageStore(root).save(bytes)
      await crashedRemoval(root, stored)
      await writeFile(join(root, 'package.bin'), bytes)

      const contenders = [
        ...Array.from({ length: 4 }, () => storeProcess(root, stored, `
          const read = await store.read(descriptor, 'pdf')
          console.log('read ' + read.bytes.byteLength)
        `)),
        storeProcess(root, stored, `
          const { readFile } = await import('node:fs/promises')
          const saved = await store.save(new Uint8Array(await readFile(root + '/package.bin')))
          console.log('read ' + saved.artifactReference)
        `),
      ]
      await Promise.all(contenders.map((process) => process.line('read ')))
      for (const { exited } of contenders) assert.deepEqual(await exited, { code: 0, signal: null })
      assert.deepEqual(await readFile(join(root, `${stored.artifactReference}.zip`)), Buffer.from(bytes))
      assert.equal(await createCanonicalPackageStore(root).available(stored), true)
    })
  })
})

describe('package reader thread', () => {
  it('rejects only the request a crashed thread was running, then serves the next on a new thread', async () => {
    let spawned = 0
    const call = createWorkerLane<string, string>(() => {
      spawned += 1
      return new Worker(`
        const { parentPort } = require('node:worker_threads')
        parentPort.on('message', (input) => {
          if (input === 'crash') process.exit(7)
          if (input === 'throw') throw new Error('thrown in the worker')
          parentPort.postMessage(input === 'fail' ? { error: { message: 'refused', code: 'EREFUSED' } } : { value: input + '!' })
        })
      `, { eval: true })
    }, { maxWaiting: 8 })
    const results = await Promise.allSettled(['a', 'crash', 'b', 'throw', 'fail', 'c'].map((input) => call(input)))
    assert.deepEqual(results.map((result) => result.status === 'fulfilled' ? result.value : (result.reason as Error).message), [
      'a!', 'The worker thread exited (code 7).', 'b!', 'thrown in the worker', 'refused', 'c!',
    ])
    assert.equal((results[4] as PromiseRejectedResult).reason.code, 'EREFUSED')
    assert.equal(spawned, 3)
  })

  it('sends one request at a time and refuses requests past its waiting bound', async () => {
    const call = createWorkerLane<number, number>(() => new Worker(`
      const { parentPort } = require('node:worker_threads')
      let running = 0
      parentPort.on('message', (input) => {
        running += 1
        const most = running
        setTimeout(() => { running -= 1; parentPort.postMessage({ value: most }) }, 20)
      })
    `, { eval: true }), { maxWaiting: 2, maxWaitingBytes: 10 })
    const results = await Promise.allSettled([1, 2, 3, 4].map((input) => call(input)))
    assert.deepEqual(results.slice(0, 3), [1, 2, 3].map(() => ({ status: 'fulfilled', value: 1 })))
    assert.match((results[3] as PromiseRejectedResult).reason.message, /Too many requests/)

    // Bytes waiting count too: a request that would take the waiting input past the budget is refused, but one
    // arriving at an empty queue waits whatever its size.
    const sized = (size: number) => { const bytes = new Uint8Array(size); return call(size, [bytes.buffer]) }
    const running = sized(64)
    const first = sized(64)
    await assert.rejects(sized(1), /Too many requests/)
    assert.deepEqual(await Promise.all([running, first]), [1, 1])
  })

  it('rejects when its entry cannot load, and serves once it can', async () => {
    let attempts = 0
    const call = createWorkerLane<string, string>(() => new Worker(
      ++attempts === 1
        ? new URL('./missing-canonical-package-worker.ts', import.meta.url)
        : new URL('data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.on("message", (v) => parentPort.postMessage({ value: v }))'),
    ), { maxWaiting: 8 })
    await assert.rejects(call('first'), { code: 'ERR_MODULE_NOT_FOUND' })
    assert.equal(await call('second'), 'second')
  })

  for (const evaluated of [false, true])
    it(`reads through the real worker entry and lets an idle process exit (${evaluated ? 'node --input-type=module -e' : 'script file'})`, async () => {
      await withRoot(async (root) => {
        const stored = await createCanonicalPackageStore(root).save(canonicalPackage())
        const reader = storeProcess(root, stored, `
          await store.read({ artifactReference: 'c'.repeat(64), artifactSha256: 'c'.repeat(64) }, 'pdf').catch((error) => console.log(error.code))
          console.log(new TextDecoder().decode((await store.read(descriptor, 'markdown')).bytes))
          // An evaluated CommonJS program, as Studio's source decoder is, under the same process options.
          console.log('read through the reader thread')
        `, { evaluated })
        await reader.line('read through the reader thread')
        // No explicit exit: the idle threads must not hold the process open.
        assert.deepEqual(await Promise.race([reader.exited, new Promise((resolve) => setTimeout(resolve, 10_000, 'still running').unref())]),
          { code: 0, signal: null })
      })
    })
})
