import { useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import Button from '../ui/Button.tsx'
import { browserStudioPath } from '../studioUrl.js'
import {
  AuthHttpError,
  changePassword,
  login,
  logout,
} from './authApi.ts'
import type { AuthenticatedSession } from './authApi.ts'

const fieldClass =
  'w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent/20'
const labelClass = 'flex flex-col gap-1.5 text-xs font-semibold text-ink-muted'
const invalidCredentials = 'Email or password is incorrect.'
const passwordPolicy =
  'Password must contain between 6 and 128 Unicode characters.'

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

export function AuthenticationLoading() {
  return (
    <AuthCard
      title="Opening FREE Studio"
      description="Verifying your browser session before the research workspace loads."
    >
      <p
        role="status"
        aria-live="polite"
        className="text-sm font-medium text-ink-muted"
      >
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
      <Button variant="primary" size="md" onClick={onRetry}>
        Try again
      </Button>
    </AuthCard>
  )
}

export function LoginForm({
  notice,
  onAuthenticated,
}: {
  notice?: string
  onAuthenticated: (session: AuthenticatedSession, password: string) => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setFailure(null)
    try {
      onAuthenticated(await login(email, password), password)
    } catch (error) {
      if (error instanceof AuthHttpError && error.status === 429)
        setFailure('Too many login attempts. Try again later.')
      else if (error instanceof AuthHttpError && error.status === 401)
        setFailure(invalidCredentials)
      else setFailure('Sign in is unavailable. Try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthCard
      title="Sign in to FREE Studio"
      description="Use the Researcher Account provided by your deployment operator."
    >
      {notice && (
        <p
          role="status"
          className="mb-4 rounded-lg border border-green/30 bg-green-soft px-3 py-2 text-sm text-green"
        >
          {notice}
        </p>
      )}
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <label className={labelClass}>
          Email address
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            autoFocus
            className={fieldClass}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className={labelClass}>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={fieldClass}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {failure && (
          <p role="alert" className="text-sm text-danger">
            {failure}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          size="md"
          className="mt-1 w-full"
          disabled={pending}
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthCard>
  )
}

function LogoutButton({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  async function signOut() {
    if (pending) return
    setPending(true)
    setFailure(null)
    try {
      await logout()
      onLoggedOut()
    } catch (error) {
      if (error instanceof AuthHttpError && error.status === 401) {
        onLoggedOut()
        return
      }
      setFailure('Could not sign out. Try again.')
      setPending(false)
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() => void signOut()}
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </Button>
      {failure && (
        <p role="alert" className="text-xs text-danger">
          {failure}
        </p>
      )}
    </>
  )
}

export function PasswordChangeForm({
  session,
  temporaryPassword,
  onPasswordChanged,
  onLoggedOut,
}: {
  session: AuthenticatedSession
  temporaryPassword: string
  onPasswordChanged: () => void
  onLoggedOut: () => void
}) {
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<{
    message: string
    field: 'new-password' | 'confirmation' | 'form'
  } | null>(null)
  const newPasswordRef = useRef<HTMLInputElement>(null)
  const confirmationRef = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const scalarLength = Array.from(newPassword).length
    if (scalarLength < 15 || scalarLength > 128) {
      setFailure({ message: passwordPolicy, field: 'new-password' })
      newPasswordRef.current?.focus()
      return
    }
    if (newPassword !== confirmation) {
      setFailure({
        message: 'The new password confirmation does not match.',
        field: 'confirmation',
      })
      confirmationRef.current?.focus()
      return
    }

    setPending(true)
    setFailure(null)
    try {
      await changePassword(temporaryPassword, newPassword)
      onPasswordChanged()
    } catch (error) {
      if (
        error instanceof AuthHttpError &&
        error.code === 'authentication_required'
      )
        onLoggedOut()
      else if (error instanceof AuthHttpError && error.status === 400)
        setFailure({ message: passwordPolicy, field: 'new-password' })
      else if (error instanceof AuthHttpError && error.status === 401)
        setFailure({
          message: 'Password change failed. Sign out and sign in again.',
          field: 'form',
        })
      else
        setFailure({
          message: 'Password change is unavailable. Try again.',
          field: 'form',
        })
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthCard
      title="Choose a permanent password"
      description="Your temporary password must be replaced before the research workspace can load."
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <p className="min-w-0 truncate text-xs text-ink-muted">
          Signed in as <strong className="text-ink">{session.account.email}</strong>
        </p>
        <div className="flex flex-col items-end gap-1">
          <LogoutButton onLoggedOut={onLoggedOut} />
        </div>
      </div>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <label className={labelClass}>
          New password
          <input
            ref={newPasswordRef}
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
            aria-invalid={failure?.field === 'new-password'}
            aria-describedby={`password-policy${
              failure?.field === 'new-password' ? ' password-change-error' : ''
            }`}
            className={fieldClass}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </label>
        <p id="password-policy" className="-mt-2 text-xs leading-5 text-ink-faint">
          Use 6–128 Unicode characters. The password is stored exactly as entered.
        </p>
        <label className={labelClass}>
          Confirm new password
          <input
            ref={confirmationRef}
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            aria-invalid={failure?.field === 'confirmation'}
            aria-describedby={
              failure?.field === 'confirmation'
                ? 'password-change-error'
                : undefined
            }
            className={fieldClass}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        {failure && (
          <p
            id="password-change-error"
            role="alert"
            className="text-sm text-danger"
          >
            {failure.message}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          size="md"
          className="mt-1 w-full"
          disabled={pending}
        >
          {pending ? 'Changing password…' : 'Change password'}
        </Button>
      </form>
    </AuthCard>
  )
}

export function SessionControls({
  session,
  onLoggedOut,
}: {
  session: AuthenticatedSession
  onLoggedOut: () => void
}) {
  return (
    <aside
      aria-label="Researcher session"
      className="fixed bottom-3 right-3 z-40 flex max-w-[min(28rem,calc(100vw-1.5rem))] items-center gap-2 rounded-lg border border-line bg-surface/95 px-2.5 py-2 shadow-float backdrop-blur-sm"
    >
      <span className="min-w-0 truncate text-[11px] font-medium text-ink-muted">
        {session.account.email}
      </span>
      <div className="flex flex-col items-end gap-1">
        <LogoutButton onLoggedOut={onLoggedOut} />
      </div>
    </aside>
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
  return (
    <AuthCard
      title="Workspace unavailable"
      description="Your session is ready, but the research workspace could not be loaded."
    >
      <p role="alert" className="mb-4 text-sm text-danger">
        Workspace loading failed. Try again.
      </p>
      <Button variant="primary" size="md" onClick={onRetry}>
        Try again
      </Button>
    </AuthCard>
  )
}
