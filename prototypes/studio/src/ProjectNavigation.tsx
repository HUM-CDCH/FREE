import { createActorContext } from '@xstate/react'
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import {
  browserNavigationDeps,
  navigationMachine,
  projectContextIdFromLocation,
} from './projectNavigation'

const Navigation = createActorContext(navigationMachine)

export function ProjectNavigationProvider({
  children,
}: {
  children: ReactNode
}) {
  return (
    <Navigation.Provider
      logic={navigationMachine}
      options={{
        input: {
          deps: browserNavigationDeps(),
          initialProjectContextId: projectContextIdFromLocation(),
        },
      }}
    >
      {children}
    </Navigation.Provider>
  )
}

function ErrorState() {
  const actor = Navigation.useActorRef()
  const failure = Navigation.useSelector((snapshot) => snapshot.context.failure)
  const projects = Navigation.useSelector(
    (snapshot) => snapshot.context.projects,
  )
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-xl font-semibold">Could not load Project Contexts</h1>
      <p className="mt-2 text-ink-muted">{failure?.message}</p>
      <button
        className="mt-4 rounded-lg bg-accent px-3 py-2 text-white"
        type="button"
        onClick={() => actor.send({ type: 'RETRY' })}
      >
        Retry
      </button>
      {projects.length > 0 && (
        <>
          <h2 className="mt-8 font-semibold">Recent Project Contexts</h2>
          <ul className="mt-2 space-y-2">
            {projects.map((project) => (
              <li key={project.projectContextId}>
                <button
                  className="w-full rounded-lg border border-line p-3 text-left hover:bg-accent-ghost"
                  type="button"
                  onClick={() =>
                    actor.send({
                      type: 'OPEN_PROJECT',
                      projectContextId: project.projectContextId,
                    })
                  }
                >
                  {project.name}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  )
}

export function ProjectRoutes() {
  const actor = Navigation.useActorRef()
  const snapshot = Navigation.useSelector((state) => state)
  useEffect(() => {
    const changed = () =>
      actor.send({
        type: 'URL_CHANGED',
        projectContextId: projectContextIdFromLocation(),
      })
    addEventListener('popstate', changed)
    return () => removeEventListener('popstate', changed)
  }, [actor])
  if (snapshot.matches('loadingList') || snapshot.matches('loadingChooser'))
    return (
      <main className="p-8" aria-busy="true">
        Loading Project Contexts…
      </main>
    )
  if (snapshot.matches('listError') || snapshot.matches('chooserError'))
    return <ErrorState />
  if (snapshot.matches('projectList'))
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="text-xl font-semibold">Project Contexts</h1>
        <a className="mt-2 inline-block text-accent underline" href="/studio">
          Open Studio workspace
        </a>
        <ul className="mt-4 space-y-2">
          {snapshot.context.projects.map((project) => (
            <li key={project.projectContextId}>
              <button
                className="w-full rounded-lg border border-line p-3 text-left hover:bg-accent-ghost"
                type="button"
                onClick={() =>
                  actor.send({
                    type: 'OPEN_PROJECT',
                    projectContextId: project.projectContextId,
                  })
                }
              >
                {project.name}
              </button>
            </li>
          ))}
        </ul>
      </main>
    )
  const choice = snapshot.context.chooser
  return (
    <main className="mx-auto max-w-xl p-8">
      <button
        className="text-accent underline"
        type="button"
        onClick={() => actor.send({ type: 'GO_PROJECT_LIST' })}
      >
        All Project Contexts
      </button>
      <h1 className="mt-4 text-xl font-semibold">
        {choice?.projectContext.name}
      </h1>
      <h2 className="mt-6 font-semibold">Source Documents</h2>
      <ul className="mt-2 space-y-2">
        {choice?.sourceDocuments.map((document) => (
          <li
            className="rounded-lg border border-line p-3"
            key={document.sourceDocumentId}
          >
            {document.name}
          </li>
        ))}
      </ul>
    </main>
  )
}
