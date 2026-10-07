import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { strToU8 } from 'fflate'
import {
  createCanonicalPackageStore,
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

      assert.equal(
        await store.remove(stored, async () => {
          await store.save(bytes)
          return true
        }),
        false,
      )
      assert.equal(await store.available(stored), true)
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
      await assert.rejects(store.removeLeftover('../x'), /leftover/)
      await assert.rejects(store.removeLeftover('notes.tmp'), /leftover/)
      assert.deepEqual((await readdir(root)).sort(), [deleting, 'notes.tmp', temporary].sort())
      assert.deepEqual((await readdir(base)).sort(), ['packages', 'x'])

      await store.removeLeftover(temporary)
      await store.removeLeftover(deleting)
      assert.deepEqual(await readdir(root), ['notes.tmp'])
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
