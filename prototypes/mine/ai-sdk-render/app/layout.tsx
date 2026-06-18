import type { Metadata } from 'next'
import './globals.css'
import 'pdfjs-dist/web/pdf_viewer.css'
import './pdf-viewer.css'

export const metadata: Metadata = {
  title: 'FREE AI SDK Prototype',
  description: 'Parallel FREE prototype using Next.js and the Vercel AI SDK.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
