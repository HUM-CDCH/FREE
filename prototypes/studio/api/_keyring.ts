export const KEYRING_SERVICE = 'FREE Studio'

/** The UUID, not the display name or API base, so rename and URL edits are stable. */
export function credentialAccount(connectionId: string): string {
  return `model-connection/${connectionId}`
}

/**
 * Secret values cross this boundary only for immediate provider use. They never
 * enter configuration state, responses, logs, or process-memory fallback state.
 */
export type CredentialStore = {
  state(connectionId: string): Promise<'present' | 'absent'>
  get?(connectionId: string): Promise<string | undefined>
  set(connectionId: string, credential: string): Promise<void>
  delete(connectionId: string): Promise<void>
}

type KeyringEntry = {
  getPassword(): Promise<string | undefined>
  setPassword(password: string): Promise<void>
  deleteCredential(): Promise<boolean>
}
export type KeyringEntryFactory = (service: string, account: string) => Promise<KeyringEntry>

/**
 * Imported per operation, never at module load: `@napi-rs/keyring` is native and
 * may be missing on a headless host. A missing binding must surface as
 * `503 keyring_unavailable` from a live handler, not as an unimportable route.
 */
const nativeEntry: KeyringEntryFactory = async (service, account) => {
  const { AsyncEntry } = await import('@napi-rs/keyring')
  return new AsyncEntry(service, account)
}

/** The only boundary that knows the native package and the naming scheme. */
export function createCredentialStore(entry: KeyringEntryFactory = nativeEntry): CredentialStore {
  const open = (connectionId: string) => entry(KEYRING_SERVICE, credentialAccount(connectionId))
  return {
    async state(connectionId) {
      // ponytail: loose null — @napi-rs/keyring resolves `null` for a missing
      // entry despite its `string | undefined` typing.
      return (await (await open(connectionId)).getPassword()) == null ? 'absent' : 'present'
    },
    async get(connectionId) {
      return (await open(connectionId)).getPassword()
    },
    async set(connectionId, credential) {
      await (await open(connectionId)).setPassword(credential)
    },
    async delete(connectionId) {
      await (await open(connectionId)).deleteCredential()
    },
  }
}

export const systemCredentialStore = createCredentialStore()
