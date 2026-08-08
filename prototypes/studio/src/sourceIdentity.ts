export type PdfSourceIdentity = { url: string; filename: string; bundled: boolean }

export function isBundledSource(source: PdfSourceIdentity | null): boolean {
  return source?.bundled === true
}
