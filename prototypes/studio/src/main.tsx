import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ArchitectureMap from './architecture/components/ArchitectureMap'
import './architecture/components/keyframes.css'
import { ARCHITECTURE } from './architecture/graph'
import { isDeveloperUiEnabled } from './developerUi.ts'
import './index.css'
import 'pdfjs-dist/web/pdf_viewer.css'
import './pdf-viewer.css'
import {
  ProjectNavigationProvider,
  ProjectRoutes,
} from './ProjectNavigation.tsx'

const architectureRoute =
  window.location.pathname.replace(/\/$/, '') === '/~/architecture'

if (architectureRoute) {
  document.title = 'Architecture · FREE'
  const robots = document.createElement('meta')
  robots.name = 'robots'
  robots.content = 'noindex, nofollow'
  document.head.append(robots)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {architectureRoute ? (
      <ArchitectureMap data={ARCHITECTURE} />
    ) : (
      <ProjectNavigationProvider>
        <ProjectRoutes />
      </ProjectNavigationProvider>
    )}
  </StrictMode>,
)

const developerUiEnabled = isDeveloperUiEnabled()
let developerUiDisposed = false
let unmountLlmInspector: (() => void) | undefined

if (developerUiEnabled) {
  void import('./llmInspector/mount.tsx').then(({ mountLlmInspector }) => {
    const unmount = mountLlmInspector()
    if (developerUiDisposed) unmount()
    else unmountLlmInspector = unmount
  })
} else {
  // A launcher mounted by the previous module can survive a Vite hot update.
  document.getElementById('llm-inspector')?.remove()
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    developerUiDisposed = true
    unmountLlmInspector?.()
  })
}
