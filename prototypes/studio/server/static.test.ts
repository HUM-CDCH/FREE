import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APP_SHELL_CONTENT_SECURITY_POLICY } from './contentSecurityPolicy.js'
import { createStaticClientHandler } from './static.js'

let container = ''
let root = ''

beforeEach(async () => {
  container = await mkdtemp(join(tmpdir(), 'free-studio-static-'))
  root = join(container, 'client')
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(
    join(root, 'index.html'),
    '<base href="/" /><main>Studio application</main>',
  )
  await writeFile(join(root, 'favicon.png'), 'png')
  await writeFile(join(root, 'assets', 'index-AbCd1234.js'), 'hashed-client')
  await writeFile(join(root, 'assets', 'runtime.js'), 'unversioned-client')
  await writeFile(join(root, 'assets', 'app-abc12345.js'), 'app-client')
  await writeFile(join(container, 'secret.txt'), 'must-not-be-served')
})

afterEach(async () => {
  await rm(container, { recursive: true, force: true })
})

describe('production static client handler', () => {
  it('serves SPA navigation through no-cache index HTML', async () => {
    const handle = createStaticClientHandler(root, '/free')
    for (const pathname of [
      '/auth/signed-out',
      '/projects/project-id',
      '/projects',
    ]) {
      const response = await handle(
        new Request(`https://studio.example${pathname}`),
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(
        'text/html; charset=utf-8',
      )
      expect(response.headers.get('cache-control')).toBe('no-cache')
      expect(await response.text()).toBe(
        '<base href="/free/" /><main>Studio application</main>',
      )
    }
  })

  it('makes hashed assets immutable and revalidates unversioned files', async () => {
    const handle = createStaticClientHandler(root, '/')
    const hashed = await handle(
      new Request('https://studio.example/assets/index-AbCd1234.js'),
    )
    expect(hashed.status).toBe(200)
    expect(hashed.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(hashed.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    )
    expect(hashed.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await hashed.text()).toBe('hashed-client')

    const unversioned = await handle(
      new Request('https://studio.example/assets/runtime.js'),
    )
    expect(unversioned.headers.get('cache-control')).toBe('no-cache')
    expect(await unversioned.text()).toBe('unversioned-client')

    const icon = await handle(
      new Request('https://studio.example/favicon.png', { method: 'HEAD' }),
    )
    expect(icon.status).toBe(200)
    expect(icon.headers.get('cache-control')).toBe('no-cache')
    expect(icon.headers.get('content-length')).toBe(String('png'.length))
    expect(await icon.text()).toBe('')
  })

  it('the index response carries the app shell policy and assets do not', async () => {
    const handle = createStaticClientHandler(root, '/')
    for (const pathname of ['/', '/projects/project-id']) {
      const index = await handle(new Request(`https://studio.example${pathname}`))
      expect(index.status).toBe(200)
      expect(index.headers.get('content-security-policy')).toBe(
        APP_SHELL_CONTENT_SECURITY_POLICY,
      )
    }
    const asset = await handle(
      new Request('https://studio.example/assets/app-abc12345.js'),
    )
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-security-policy')).toBeNull()
  })

  it('rejects traversal, malformed paths, missing files, and unsafe methods', async () => {
    const handle = createStaticClientHandler(root, '/')
    for (const request of [
      new Request('https://studio.example/assets/%2e%2e%2fsecret.txt'),
      new Request('https://studio.example/assets/%5c..%5csecret.txt'),
      new Request('https://studio.example/assets/missing.js'),
      new Request('https://studio.example/assets/runtime.js', { method: 'POST' }),
    ]) {
      const response = await handle(request)
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain('must-not-be-served')
    }
  })
})
