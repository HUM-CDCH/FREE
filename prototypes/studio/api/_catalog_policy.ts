import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { parseCatalogPolicy, type CatalogPolicy } from 'extraction/catalog'
import { modelConfigPath, nodeFileSystem, type ConfigStorageOptions } from './_model_config.js'
import { ApiError } from './_http.js'

function policyPath(options: ConfigStorageOptions): string {
  return join(dirname(modelConfigPath(options.configRoot)), 'catalog-policy.json')
}

export async function readCatalogPolicy(options: ConfigStorageOptions = {}): Promise<CatalogPolicy> {
  let contents: string
  try {
    contents = new TextDecoder('utf-8', { fatal: true }).decode(await (options.fileSystem ?? nodeFileSystem).readFile(policyPath(options)))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      const raw = process.env.FREE_CATALOG_POLICY?.trim()
      return parseCatalogPolicy(raw ? JSON.parse(raw) : undefined)
    }
    throw new ApiError(500, 'storage_failure', 'Catalog policy could not be read.', { cause: error })
  }
  try {
    return parseCatalogPolicy(JSON.parse(contents))
  } catch (error) {
    throw new ApiError(409, 'invalid_request', 'The saved Catalog policy is invalid.', { cause: error })
  }
}

export async function writeCatalogPolicy(value: unknown, options: ConfigStorageOptions = {}): Promise<CatalogPolicy> {
  let policy: CatalogPolicy
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('A Catalog policy must be an object.')
    policy = parseCatalogPolicy(value)
  } catch (error) {
    throw new ApiError(400, 'invalid_request', error instanceof Error ? error.message : 'Invalid Catalog policy.')
  }
  const fs = options.fileSystem ?? nodeFileSystem
  const path = policyPath(options)
  const temporary = `${path}.${randomUUID()}.tmp`
  let handle
  try {
    await fs.mkdir(dirname(path), { recursive: true })
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(policy, null, 2)}\n`, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, path)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.unlink(temporary).catch(() => undefined)
    throw new ApiError(500, 'storage_failure', 'Catalog policy could not be saved.', { cause: error })
  }
  return policy
}
