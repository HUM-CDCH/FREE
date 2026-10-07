import { Component, type ReactNode } from 'react'
import { getAuthSession } from './auth/authApi.ts'
import { reportAuthenticationRequired } from './auth/authenticatedFetch.ts'
import { Button, EmptyState } from './ui'

// A route module is code-split, so it is fetched with the session cookie long
// after the page loaded. React reports that fetch failing as a render error,
// which without a boundary unmounts the whole authenticated tree.
type RouteLoadBoundaryProps = {
  /** What failed to load, named as the Researcher sees it. */
  resource: string
  children: ReactNode
  readSession?: typeof getAuthSession
  reload?: () => void
}

// React caches a rejected `lazy` payload, so re-mounting the children cannot
// re-attempt the import. Reloading is the honest recovery, and it also follows
// the sign-in redirect when the session is what ended.
function reloadStudio(): void {
  window.location.reload()
}

export default class RouteLoadBoundary extends Component<
  RouteLoadBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(): void {
    // The usual cause is a session that ended: the module request answers with
    // the sign-in redirect, which is not JavaScript. The public session
    // endpoint says which it was, so a signed-out Researcher reaches sign-in
    // with their drafts captured, while a genuine load failure keeps its own
    // surface instead of pretending to be a sign-out.
    const readSession = this.props.readSession ?? getAuthSession
    void readSession().then(
      (session) => {
        if (!session.authenticated) reportAuthenticationRequired()
      },
      () => undefined,
    )
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <EmptyState
          className="max-w-sm bg-surface"
          icon="▢"
          tone="danger"
          title={`${this.props.resource} could not be loaded`}
          description="Reload Studio to try again."
        />
        <Button
          variant="secondary"
          size="md"
          onClick={this.props.reload ?? reloadStudio}
        >
          Reload
        </Button>
      </div>
    )
  }
}
