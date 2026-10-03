import { useContext } from 'react'
import type { ReactNode } from 'react'
import { ResearcherSessionContext } from './sessionContext.ts'
import {
  clearSessionSignedOut,
  markSessionSignedOut,
} from './sessionRecovery.ts'
import Button from '../ui/Button.tsx'
import { clearModelKeys } from '../modelKeys/modelKeyStore.ts'
import { browserStudioPath } from '../studioUrl.js'

type AuthCardProps = {
  title: string
  description: string
  children: ReactNode
}

function AuthCard({ title, description, children }: AuthCardProps) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <section className="w-full max-w-md animate-fadeup overflow-hidden rounded-2xl border border-line bg-surface shadow-page">
        <header className="border-b border-line bg-surface-muted px-7 pb-5 pt-6">
          <img
            src={browserStudioPath('/free-logo.png')}
            alt=""
            className="mb-1 h-14 w-auto object-contain object-left"
          />
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent">
            Research workspace
          </p>
          <h1 className="mt-2 font-serif text-2xl font-semibold text-ink">
            {title}
          </h1>
          <p className="mt-1.5 text-sm leading-6 text-ink-muted">
            {description}
          </p>
        </header>
        <div className="px-7 py-6">{children}</div>
      </section>
    </main>
  )
}

function SignOutButton() {
  const researcherSession = useContext(ResearcherSessionContext)
  // Studio evicts its copy of the keys at logout; this browser's copy goes here.
  const signOut = () => {
    markSessionSignedOut()
    if (researcherSession) clearModelKeys(researcherSession.session.account.id)
  }
  return (
    <form
      action={browserStudioPath('/auth/logout')}
      method="post"
      onSubmit={signOut}
    >
      <Button type="submit" variant="secondary" size="sm">
        Sign out
      </Button>
    </form>
  )
}

export function AuthenticationLoading() {
  return (
    <AuthCard
      title="Opening FREE Studio"
      description="Verifying your Microsoft Entra session before the research workspace loads."
    >
      <p role="status" aria-live="polite" className="text-sm font-medium text-ink-muted">
        Resolving session…
      </p>
    </AuthCard>
  )
}

export function SessionFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <AuthCard
      title="Session unavailable"
      description="FREE Studio could not verify your session. No project data has been loaded."
    >
      <p role="alert" className="mb-4 text-sm text-danger">
        Session verification failed. Try again.
      </p>
      <Button variant="secondary" size="md" onClick={onRetry}>
        Try again
      </Button>
    </AuthCard>
  )
}

export function SignedOutLanding() {
  return (
    <AuthCard
      title="You have signed out"
      description="Your FREE Studio session and local recovery data have been cleared."
    >
      <form
        action={browserStudioPath('/auth/login')}
        method="get"
        onSubmit={clearSessionSignedOut}
      >
        <Button type="submit" variant="secondary" size="md" className="w-full">
          Sign in with Microsoft
        </Button>
      </form>
    </AuthCard>
  )
}

export function SessionExpiryWarning({ onContinue }: { onContinue: () => void }) {
  return (
    <aside
      className="fixed left-1/2 top-4 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-accent/40 bg-surface px-4 py-3 shadow-float"
    >
      <p role="alert" className="text-sm text-ink">Your session expires soon.</p>
      <Button variant="secondary" size="sm" onClick={onContinue}>
        Continue session
      </Button>
    </aside>
  )
}

export function SessionControls() {
  const researcherSession = useContext(ResearcherSessionContext)
  if (!researcherSession) return null
  const { displayName } = researcherSession.session.account
  return (
    <details className="relative min-w-0 flex-1">
      <summary
        className="flex cursor-pointer list-none items-center rounded-sm text-[11px] font-semibold text-ink-muted outline-none hover:text-accent [&::-webkit-details-marker]:hidden"
        role="button"
        aria-label="Researcher Account"
        title={displayName}
      >
        <span className="min-w-0 truncate">{displayName}</span>
      </summary>
      <div
        aria-label="Researcher session"
        className="absolute bottom-full left-0 z-10 mb-2 flex w-max max-w-56 flex-col items-start gap-1 rounded-2xl border border-line bg-surface p-2.5 shadow-float"
      >
        <SignOutButton />
      </div>
    </details>
  )
}

export function ProjectLoading() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas">
      <p role="status" className="text-sm font-medium text-ink-muted">
        Loading research workspace…
      </p>
    </main>
  )
}

export function ProjectLoadFailure({ onRetry }: { onRetry: () => void }) {
  const researcherSession = useContext(ResearcherSessionContext)
  return (
    <AuthCard
      title="Workspace unavailable"
      description="Your session is ready, but the research workspace could not be loaded."
    >
      {researcherSession && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
          <p className="min-w-0 truncate text-xs text-ink-muted">
            Signed in as{' '}
            <strong className="text-ink">
              {researcherSession.session.account.displayName}
            </strong>
          </p>
          <SignOutButton />
        </div>
      )}
      <p role="alert" className="mb-4 text-sm text-danger">
        Workspace loading failed. Try again.
      </p>
      <Button variant="secondary" size="md" onClick={onRetry}>
        Try again
      </Button>
    </AuthCard>
  )
}
