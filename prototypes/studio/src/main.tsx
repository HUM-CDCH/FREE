import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import AuthApplication from './auth/AuthApplication.tsx'
import './index.css'
import 'pdfjs-dist/web/pdf_viewer.css'
import './pdf-viewer.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthApplication />
  </StrictMode>,
)
