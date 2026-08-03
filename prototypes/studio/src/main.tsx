import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
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

if (import.meta.env.DEV)
  void import('./llmInspector/mount.tsx').then(({ mountLlmInspector }) =>
    mountLlmInspector(),
  )
