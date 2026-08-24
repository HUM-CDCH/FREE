export const MAX_SOURCE_DOCUMENT_FILENAME_SCALARS = 180

export const SOURCE_DOCUMENT_FILENAME_TOO_LONG =
  'The Source Document filename must contain at most 180 Unicode characters.'

export function sourceDocumentFilenameFailure(name: string): string | null {
  return Array.from(name).length > MAX_SOURCE_DOCUMENT_FILENAME_SCALARS
    ? SOURCE_DOCUMENT_FILENAME_TOO_LONG
    : null
}
