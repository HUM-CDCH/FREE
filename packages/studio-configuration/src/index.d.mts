export declare const CANONICAL_UUID_PATTERN: string
export declare const CANONICAL_UUID: RegExp

export declare const SHARED_STUDIO_CONFIGURATION_FIELDS: readonly [
  'STUDIO_ORIGIN',
  'STUDIO_BASE_PATH',
  'FREE_SESSION_SECRET',
  'FREE_ENTRA_TENANT_ID',
  'FREE_ENTRA_CLIENT_ID',
  'FREE_ENTRA_CLIENT_CERT_THUMBPRINT',
  'FREE_ENTRA_CLIENT_CERT_PATH',
]

export type SharedStudioConfigurationField =
  (typeof SHARED_STUDIO_CONFIGURATION_FIELDS)[number]

export type StudioConfigurationIssueCode = 'required' | 'invalid'

export type StudioConfigurationIssue = {
  field: SharedStudioConfigurationField
  code: StudioConfigurationIssueCode
  message: string
}

export type SharedStudioConfigurationValues = {
  STUDIO_ORIGIN?: string
  STUDIO_BASE_PATH?: string
  FREE_SESSION_SECRET?: Uint8Array
  FREE_ENTRA_TENANT_ID?: string
  FREE_ENTRA_CLIENT_ID?: string
  FREE_ENTRA_CLIENT_CERT_THUMBPRINT?: string
  FREE_ENTRA_CLIENT_CERT_PATH?: string
}

export declare function canonicalStudioOrigin(value: string): string
export declare function canonicalStudioBasePath(value: string): string
export declare function normalizeCanonicalUuid(value: unknown): string | null
export declare function canonicalEntraCertificateThumbprint(
  value: string,
): string
export declare function decodeCanonicalSessionSecret(
  value: string,
): Uint8Array | null

export declare function validateSharedStudioConfiguration(
  environment: Record<string, string | undefined>,
): {
  values: SharedStudioConfigurationValues
  issues: StudioConfigurationIssue[]
}
