import {
  canonicalStudioBasePath,
  studioPath,
  stripStudioBasePath,
} from '../shared/studioBasePath.js'

function browserStudioBasePath(): string {
  if (typeof document === 'undefined') return '/'

  const base = document.querySelector('base')
  if (!base) return '/'

  const pathname = new URL(base.href).pathname
  return canonicalStudioBasePath(
    pathname === '/' ? '/' : pathname.replace(/\/$/, ''),
  )
}

export function browserStudioPath(internalPath: string): string {
  return studioPath(browserStudioBasePath(), internalPath)
}

export function browserStudioPathname(pathname = location.pathname): string {
  const internal = stripStudioBasePath(browserStudioBasePath(), pathname)
  if (internal === null)
    throw new Error('The browser location is outside the Studio base path.')
  return internal
}
