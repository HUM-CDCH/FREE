const SEGMENT = /^[A-Za-z0-9._~-]+$/

export function canonicalStudioBasePath(value: string): string {
  if (value === '/') return value
  if (
    !value.startsWith('/') ||
    value.endsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('%') ||
    value.includes('?') ||
    value.includes('#')
  )
    throw new Error('The Studio base path is not canonical.')

  const segments = value.slice(1).split('/')
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        !SEGMENT.test(segment),
    )
  )
    throw new Error('The Studio base path is not canonical.')
  return value
}

function internalStudioPath(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//'))
    throw new Error('An internal Studio path must start with one slash.')
  return value
}

export function studioPath(basePath: string, internalPath: string): string {
  const base = canonicalStudioBasePath(basePath)
  const path = internalStudioPath(internalPath)
  return base === '/' ? path : `${base}${path}`
}

export function studioBaseHref(basePath: string): string {
  const base = canonicalStudioBasePath(basePath)
  return base === '/' ? '/' : `${base}/`
}

const BASE_TAG = '<base href="/" />'

export function applyStudioBaseTag(html: string, basePath: string): string {
  if (!html.includes(BASE_TAG))
    throw new Error('The Studio client index is missing its base-path marker.')
  return html.replace(BASE_TAG, `<base href="${studioBaseHref(basePath)}" />`)
}

export function stripStudioBasePath(
  basePath: string,
  pathname: string,
): string | null {
  const base = canonicalStudioBasePath(basePath)
  const path = internalStudioPath(pathname)
  if (base === '/') return path
  if (path === base || path === `${base}/`) return '/'
  return path.startsWith(`${base}/`) ? path.slice(base.length) : null
}
