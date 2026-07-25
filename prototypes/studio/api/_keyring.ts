export const KEYRING_SERVICE = 'FREE Studio'

/** The UUID, not the display name or API base, so rename and URL edits are stable. */
export function credentialAccount(connectionId: string): string {
  return `model-connection/${connectionId}`
}

/**
 * Only presence crosses this boundary. Configuration code needs to know whether
 * a credential exists, never what it is, so the value has no caller above here.
 */
export type CredentialStore = {
  state(connectionId: string): Promise<'present' | 'absent'>
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
      return (await (await open(connectionId)).getPassword()) === undefined ? 'absent' : 'present'
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
