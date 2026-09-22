import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
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
})
