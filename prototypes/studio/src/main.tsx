import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { isDeveloperUiEnabled } from './developerUi.ts'
import './index.css'
import 'pdfjs-dist/web/pdf_viewer.css'
import './pdf-viewer.css'
import {
  ProjectNavigationProvider,
  ProjectRoutes,
} from './ProjectNavigation.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProjectNavigationProvider>
      <ProjectRoutes />
    </ProjectNavigationProvider>
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
