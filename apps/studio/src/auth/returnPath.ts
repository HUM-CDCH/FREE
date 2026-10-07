import {
  DEFAULT_RETURN_PATH,
  validateLocalReturnPath,
} from '../../shared/returnPath.js'
import { browserStudioPathname } from '../studioUrl.js'
const AUTH_PATHS: Partial<Record<string, true>> = {
  '/auth/login': true,
  '/auth/callback': true,
  '/auth/signed-out': true,
}


/** Resolve the server's protected-navigation return target or preserve a local deep link. */
export function currentReturnPath(): string {
  const pathname = browserStudioPathname()
  const candidate = AUTH_PATHS[pathname]
    ? new URLSearchParams(location.search).get('returnTo')
    : `${pathname}${location.search}${location.hash}`
  return validateLocalReturnPath(candidate) ?? DEFAULT_RETURN_PATH
}
