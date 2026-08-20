import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import {
  AuthenticationLoading,
  LoginForm,
  PasswordChangeForm,
  ProjectLoadFailure,
  ProjectLoading,
  SessionControls,
  SessionFailure,
} from './AuthForms.tsx'
import { getAuthSession } from './authApi.ts'
import type {
  AuthenticatedSession,
  AuthSession,
} from './authApi.ts'
import { subscribeToAuthenticationRequired } from './authenticatedFetch.ts'
import { currentReturnPath } from './returnPath.ts'

type ProjectNavigationModule = {
  ProjectNavigationProvider: ComponentType<{ children: ReactNode }>
  ProjectRoutes: ComponentType
}

export type ProjectNavigationLoader = () => Promise<ProjectNavigationModule>

type AuthState =
  | { phase: 'resolving' }
  | { phase: 'failed' }
  | { phase: 'anonymous'; notice?: string }
  | { phase: 'authenticated'; session: AuthenticatedSession }

function loadProjectNavigation(): Promise<ProjectNavigationModule> {
  return import('../ProjectNavigation.tsx')
}

function AuthenticatedProject({
  session,
  loadNavigation,
  onLoggedOut,
}: {
  session: AuthenticatedSession
  loadNavigation: ProjectNavigationLoader
  onLoggedOut: () => void
}) {
  const [navigation, setNavigation] =
    useState<ProjectNavigationModule | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)

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

  const retryNavigation = () => {
    setNavigation(null)
    setLoadFailed(false)
    setLoadAttempt((value) => value + 1)
  }
  let project = <ProjectLoading />
  if (loadFailed)
    project = <ProjectLoadFailure onRetry={retryNavigation} />
  else if (navigation) {
    const { ProjectNavigationProvider, ProjectRoutes } = navigation
    project = (
      <ProjectNavigationProvider>
        <ProjectRoutes />
      </ProjectNavigationProvider>
    )
  }

  return (
    <>
      {project}
      <SessionControls session={session} onLoggedOut={onLoggedOut} />
    </>
  )
}

export default function AuthApplication({
  loadNavigation = loadProjectNavigation,
}: {
  loadNavigation?: ProjectNavigationLoader
}) {
  const [state, setState] = useState<AuthState>({ phase: 'resolving' })
  const [resolutionAttempt, setResolutionAttempt] = useState(0)
  const authenticationTransitioned = useRef(true)

  const acceptSession = useCallback((session: AuthSession) => {
    if (!session.authenticated) {
      authenticationTransitioned.current = true
      setState({ phase: 'anonymous' })
      return
    }
    authenticationTransitioned.current = session.account.mustChangePassword
    if (!session.account.mustChangePassword)
      history.replaceState(null, '', currentReturnPath())
    setState({ phase: 'authenticated', session })
  }, [])

  useEffect(
    () =>
      subscribeToAuthenticationRequired(() => {
        if (authenticationTransitioned.current) return
        authenticationTransitioned.current = true
        setState({
          phase: 'anonymous',
          notice: 'Your session expired. Sign in again.',
        })
      }),
    [],
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

  if (state.phase === 'resolving') return <AuthenticationLoading />
  if (state.phase === 'failed')
    return (
      <SessionFailure
        onRetry={() => {
          setState({ phase: 'resolving' })
          setResolutionAttempt((value) => value + 1)
        }}
      />
    )
  if (state.phase === 'anonymous')
    return (
      <LoginForm notice={state.notice} onAuthenticated={acceptSession} />
    )
  if (state.session.account.mustChangePassword)
    return (
      <PasswordChangeForm
        session={state.session}
        onPasswordChanged={() => {
          history.replaceState(null, '', '/login')
          setState({
            phase: 'anonymous',
            notice: 'Password changed. Sign in with your new password.',
          })
        }}
        onLoggedOut={() => {
          history.replaceState(null, '', '/login')
          setState({ phase: 'anonymous', notice: 'You have signed out.' })
        }}
      />
    )

  return (
    <AuthenticatedProject
      session={state.session}
      loadNavigation={loadNavigation}
      onLoggedOut={() => {
        authenticationTransitioned.current = true
        setState({ phase: 'anonymous', notice: 'You have signed out.' })
      }}
    />
  )
}
