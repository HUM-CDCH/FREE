import { createContext } from 'react'
import type { AuthenticatedSession } from '../../shared/authSession.contract'

export const ResearcherSessionContext = createContext<{
  session: AuthenticatedSession
  onLoggedOut: () => void
} | null>(null)
