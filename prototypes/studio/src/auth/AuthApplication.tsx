import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import {
  AuthenticationLoading,
  ProjectLoadFailure,
  ProjectLoading,
  SessionExpiryWarning,
  SessionFailure,
  SignedOutLanding,
} from './AuthForms.tsx'
import { ResearcherSessionContext } from './sessionContext.ts'
import { getAuthSession } from './authApi.ts'
import type { AuthenticatedSession, AuthSession } from './authApi.ts'
import {
  subscribeToAuthenticationRequired,
  subscribeToModelKeyResend,
} from './authenticatedFetch.ts'
import { currentReturnPath } from './returnPath.ts'
import {
  captureSessionRecovery,
  clearSessionRecovery,
  isSessionSignedOut,
  setSessionRecoveryAccount,
} from './sessionRecovery.ts'
import { browserStudioPath, browserStudioPathname } from '../studioUrl.js'
import {
  sendModelKeys,
  setModelKeyAccount,
} from '../modelKeys/modelKeyHandoff.ts'

type ProjectNavigationModule = {
  ProjectNavigationProvider: ComponentType<{ children: ReactNode }>
  ProjectRoutes: ComponentType
}

export type ProjectNavigationLoader = () => Promise<ProjectNavigationModule>

type AuthState =
  | { phase: 'resolving' }
  | { phase: 'failed' }
  | { phase: 'anonymous' }
  | { phase: 'redirecting' }
  | { phase: 'authenticated'; session: AuthenticatedSession }

const EXPIRY_WARNING_MILLISECONDS = 5 * 60 * 1000

function loadProjectNavigation(): Promise<ProjectNavigationModule> {
  return import('../ProjectNavigation.tsx')
}

function AuthenticatedProject({
  session,
  loadNavigation,
  onReauthenticate,
}: {
  session: AuthenticatedSession
  loadNavigation: ProjectNavigationLoader
  onReauthenticate: () => void
}) {
  const [navigation, setNavigation] =
    useState<ProjectNavigationModule | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [expiryWarning, setExpiryWarning] = useState(
    () => Date.parse(session.expiresAt) - Date.now() <= EXPIRY_WARNING_MILLISECONDS,
  )

  // Studio holds this browser's keys only in memory: hand them over on load and again whenever it no longer has them.
  useEffect(() => {
    const accountId = session.account.id
    setModelKeyAccount(accountId)
    void sendModelKeys(accountId)
    const stop = subscribeToModelKeyResend(() => void sendModelKeys(accountId))
    return () => {
      stop()
      setModelKeyAccount(null)
    }
  }, [session.account.id])

  useEffect(() => {
    let active = true
    void loadNavigation().then(
      (loaded) => {
        if (active) setNavigation(loaded)
      },
      () => {
        if (active) setLoadFailed(true)
      },
    )
    return () => {
      active = false
    }
  }, [loadAttempt, loadNavigation])

  useEffect(() => {
    const expiresAt = Date.parse(session.expiresAt)
    const warningTimeout = window.setTimeout(
      () => setExpiryWarning(true),
      Math.max(0, expiresAt - Date.now() - EXPIRY_WARNING_MILLISECONDS),
    )
    const expiryTimeout = window.setTimeout(
      onReauthenticate,
      Math.max(0, expiresAt - Date.now()),
    )
    return () => {
      window.clearTimeout(warningTimeout)
      window.clearTimeout(expiryTimeout)
    }
  }, [onReauthenticate, session.expiresAt])

  const retryNavigation = () => {
    setNavigation(null)
    setLoadFailed(false)
    setLoadAttempt((value) => value + 1)
  }
  let project = <ProjectLoading />
  if (loadFailed) project = <ProjectLoadFailure onRetry={retryNavigation} />
  else if (navigation) {
    const { ProjectNavigationProvider, ProjectRoutes } = navigation
    project = (
      <ProjectNavigationProvider>
        <ProjectRoutes />
      </ProjectNavigationProvider>
    )
  }

  return (
    <ResearcherSessionContext value={{ session }}>
      {expiryWarning && <SessionExpiryWarning onContinue={onReauthenticate} />}
      {project}
    </ResearcherSessionContext>
  )
}

function browserNavigate(location: string): void {
  window.location.assign(location)
}
function browserReplace(location: string): void {
  window.location.replace(location)
}

export default function AuthApplication({
  loadNavigation = loadProjectNavigation,
  navigate = browserNavigate,
  replace = browserReplace,
}: {
  loadNavigation?: ProjectNavigationLoader
  navigate?: (location: string) => void
  replace?: (location: string) => void
}) {
  const [state, setState] = useState<AuthState>({ phase: 'resolving' })
  const [resolutionAttempt, setResolutionAttempt] = useState(0)
  const redirecting = useRef(false)
  const restoredFromCache = useRef(false)

  const reauthenticate = useCallback(() => {
    if (redirecting.current) return
    redirecting.current = true
    captureSessionRecovery()
    setState({ phase: 'redirecting' })
    const query = new URLSearchParams({
      returnTo: currentReturnPath(),
      fragmentCaptured: '1',
    })
    navigate(`${browserStudioPath('/auth/login')}?${query}`)
  }, [navigate])

  const acceptSession = useCallback(
    (session: AuthSession) => {
      if (!session.authenticated) {
        if (restoredFromCache.current) {
          restoredFromCache.current = false
          clearSessionRecovery()
          replace(browserStudioPath('/auth/signed-out'))
          return
        }
        setState({ phase: 'anonymous' })
        return
      }
      restoredFromCache.current = false
      redirecting.current = false
      setSessionRecoveryAccount(session.account.id)
      setState({ phase: 'authenticated', session })
    },
    [replace],
  )

  useEffect(
    () => subscribeToAuthenticationRequired(reauthenticate),
    [reauthenticate],
  )

  useEffect(() => {
    const controller = new AbortController()
    void getAuthSession(controller.signal).then(
      (session) => {
        if (!controller.signal.aborted) acceptSession(session)
      },
      () => {
        if (!controller.signal.aborted) setState({ phase: 'failed' })
      },
    )
    return () => controller.abort()
  }, [acceptSession, resolutionAttempt])

  useEffect(() => {
    const revalidateRestoredPage = () => {
      restoredFromCache.current = true
      redirecting.current = false
      setState({ phase: 'resolving' })
      setResolutionAttempt((value) => value + 1)
    }
    const pageShown = (event: PageTransitionEvent) => {
      if (event.persisted) revalidateRestoredPage()
    }
    const historyChanged = () => {
      if (isSessionSignedOut()) revalidateRestoredPage()
    }
    addEventListener('pageshow', pageShown)
    addEventListener('popstate', historyChanged)
    return () => {
      removeEventListener('pageshow', pageShown)
      removeEventListener('popstate', historyChanged)
    }
  }, [])

  useEffect(() => {
    if (state.phase !== 'anonymous') return
    if (browserStudioPathname() === '/auth/signed-out') {
      clearSessionRecovery()
      return
    }
    if (isSessionSignedOut()) {
      replace(browserStudioPath('/auth/signed-out'))
      return
    }
    reauthenticate()
  }, [reauthenticate, replace, state.phase])

  if (state.phase === 'failed')
    return (
      <SessionFailure
        onRetry={() => {
          setState({ phase: 'resolving' })
          setResolutionAttempt((value) => value + 1)
        }}
      />
    )
  if (state.phase === 'anonymous' && browserStudioPathname() === '/auth/signed-out')
    return <SignedOutLanding />
  if (state.phase !== 'authenticated') return <AuthenticationLoading />

  return (
    <AuthenticatedProject
      key={`${state.session.account.id}:${state.session.expiresAt}`}
      session={state.session}
      loadNavigation={loadNavigation}
      onReauthenticate={reauthenticate}
    />
  )
}
