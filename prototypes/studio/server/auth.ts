import {
  createResearcherAccountStore,
  normalizeResearcherEmail,
  type ResearcherAccountRecord,
  type ResearcherAccountStore,
} from 'db'
import { ApiError } from '../api/_http.js'
import {
  hashPassword,
  PasswordPolicyError,
  validatePassword,
  verifyPassword,
} from './password.js'
import {
  createLoginLimiter,
  type LoginAttemptOutcome,
  type LoginLimiter,
} from './login-limiter.js'
import type { SessionManager } from './session.js'

const DUMMY_PASSWORD = 'invalid-password-verification'
const INVALID_CREDENTIALS_MESSAGE = 'Email or password is incorrect.'
const INVALID_PASSWORD_MESSAGE =
  'Password must contain between 15 and 128 Unicode characters.'

export type SessionView =
  | { authenticated: false }
  | {
      authenticated: true
      account: {
        id: string
        email: string
        mustChangePassword: boolean
      }
    }

export type UnauthenticatedState = {
  authenticated: false
  clearCookie: boolean
}

export type AuthenticatedState = {
  authenticated: true
  account: ResearcherAccountRecord
  renewalCookie: string
}

export type AuthenticationState = UnauthenticatedState | AuthenticatedState

export type LoginResult = {
  account: ResearcherAccountRecord
  sessionCookie: string
}

export type PasswordOperations = {
  validate(password: string): void
  hash(password: string): Promise<string>
  verify(password: string, representation: string): Promise<boolean>
}

export type AuthenticationBackendOptions = {
  store?: ResearcherAccountStore
  sessions: SessionManager
  limiter?: LoginLimiter
  passwords?: PasswordOperations
  dummyPasswordHash?: string
}

export type AuthenticationBackend = {
  inspect(request: Request): Promise<AuthenticationState>
  login(
    email: string,
    password: string,
    clientAddress: string,
  ): Promise<LoginResult>
  changePassword(
    account: ResearcherAccountRecord,
    currentPassword: string,
    newPassword: string,
  ): Promise<void>
}

export class LoginThrottledError extends ApiError {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super(
      429,
      'too_many_attempts',
      'Too many login attempts. Try again later.',
    )
    this.name = 'LoginThrottledError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

function authenticationUnavailable(cause: unknown): ApiError {
  return new ApiError(
    503,
    'authentication_unavailable',
    'Authentication is temporarily unavailable.',
    { cause },
  )
}

function invalidCredentials(): ApiError {
  return new ApiError(
    401,
    'invalid_credentials',
    INVALID_CREDENTIALS_MESSAGE,
  )
}

export function sessionView(state: AuthenticationState): SessionView {
  if (!state.authenticated) return { authenticated: false }
  return {
    authenticated: true,
    account: {
      id: state.account.id,
      email: state.account.email,
      mustChangePassword: state.account.mustChangePassword,
    },
  }
}

export async function createAuthenticationBackend(
  options: AuthenticationBackendOptions,
): Promise<AuthenticationBackend> {
  const store = options.store ?? createResearcherAccountStore()
  const sessions = options.sessions
  const limiter = options.limiter ?? createLoginLimiter()
  const passwords = options.passwords ?? {
    validate: validatePassword,
    hash: hashPassword,
    verify: verifyPassword,
  }
  const dummyPasswordHash =
    options.dummyPasswordHash ?? (await passwords.hash(DUMMY_PASSWORD))

  return {
    async inspect(request) {
      const cookie = sessions.read(request)
      if (!cookie.present) return { authenticated: false, clearCookie: false }
      if (!cookie.value)
        return { authenticated: false, clearCookie: true }

      const payload = sessions.verify(cookie.value)
      if (!payload) return { authenticated: false, clearCookie: true }

      let account: ResearcherAccountRecord | null
      try {
        account = await store.findById(payload.accountId)
      } catch (cause) {
        throw authenticationUnavailable(cause)
      }
      if (
        !account ||
        account.disabledAt !== null ||
        account.sessionVersion !== payload.sessionVersion
      )
        return { authenticated: false, clearCookie: true }

      const renewed = sessions.renew(payload)
      if (!renewed) return { authenticated: false, clearCookie: true }
      return {
        authenticated: true,
        account,
        renewalCookie: sessions.serialize(renewed),
      }
    },

    async login(email, password, clientAddress) {
      const normalizedEmail = normalizeResearcherEmail(email)
      const reservation = limiter.reserve(normalizedEmail, clientAddress)
      if (!reservation.accepted)
        throw new LoginThrottledError(reservation.retryAfterSeconds)

      let outcome: LoginAttemptOutcome = 'abandon'
      try {
        let account: ResearcherAccountRecord | null
        try {
          account = await store.findByEmail(normalizedEmail)
        } catch (cause) {
          throw authenticationUnavailable(cause)
        }

        const representation =
          account !== null && account.disabledAt === null
            ? account.passwordHash
            : dummyPasswordHash
        const verified = await passwords.verify(password, representation)
        if (!account || account.disabledAt !== null || !verified) {
          outcome = 'failure'
          throw invalidCredentials()
        }

        outcome = 'success'
        const payload = sessions.issue(account.id, account.sessionVersion)
        return { account, sessionCookie: sessions.serialize(payload) }
      } finally {
        reservation.complete(outcome)
      }
    },

    async changePassword(account, currentPassword, newPassword) {
      try {
        passwords.validate(newPassword)
      } catch (error) {
        if (error instanceof PasswordPolicyError)
          throw new ApiError(400, 'invalid_password', INVALID_PASSWORD_MESSAGE)
        throw error
      }

      if (!(await passwords.verify(currentPassword, account.passwordHash)))
        throw invalidCredentials()

      let replacement: string
      try {
        replacement = await passwords.hash(newPassword)
      } catch (error) {
        if (error instanceof PasswordPolicyError)
          throw new ApiError(400, 'invalid_password', INVALID_PASSWORD_MESSAGE)
        throw error
      }

      let updated: ResearcherAccountRecord | null
      try {
        updated = await store.replacePassword(
          account.id,
          account.sessionVersion,
          replacement,
          false,
        )
      } catch (cause) {
        throw authenticationUnavailable(cause)
      }
      if (!updated || updated.disabledAt !== null)
        throw new ApiError(
          401,
          'authentication_required',
          'Authentication is required.',
        )
    },
  }
}
