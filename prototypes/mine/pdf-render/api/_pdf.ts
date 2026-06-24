/// <reference types="node" />

import { z } from 'zod'
import { createRequire } from 'node:module'

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

const PDF_DPI = 150
const SERVICE_TIMEOUT_MS = 3_000
const LOCAL_MAX_BUFFER = 256 * 1024 * 1024

const require = createRequire(import.meta.url)
const { createCanvas } = require('@napi-rs/canvas')

declare const process: {
  cwd(): string
  env: Record<string, string | undefined>
}

export type DocumentFilePart = {
  readonly type: 'file'
  readonly data: Uint8Array | string
  readonly filename: string
  readonly mediaType: string
}

export type PreparedFileParts = {
  readonly parts: readonly DocumentFilePart[]
  readonly pages: number | null
}

const convertedPdfSchema = z.object({
  pages: z.number().int().nonnegative(),
  images: z.array(
    z.object({
      filename: z.string(),
      media_type: z.literal('image/png'),
      data_url: z.string().startsWith('data:image/png;base64,'),
    }),
  ),
})


export async function documentFileParts(file: File): Promise<PreparedFileParts> {
  if (file.type === 'application/pdf') {
    return pdfFileParts(file)
  }

  return {
    pages: null,
    parts: [
      {
        type: 'file',
        data: new Uint8Array(await file.arrayBuffer()),
        filename: file.name,
        mediaType: file.type,
      },
    ],
  }
}

export async function pdfFileParts(file: File): Promise<PreparedFileParts> {
  const converted =
    (await pdfFromService(file)) ?? (await pdfFromLocalPdfJs(file)) ?? undefined
  if (!converted) {
    throw new Error('Failed to convert PDF to images')
  }
  return {
    pages: converted.pages,
    parts: converted.images.map((image) => ({
      type: 'file',
      data: image.data_url,
      filename: image.filename,
      mediaType: image.media_type,
    })),
  }
}

async function pdfFromLocalPdfJs(file: File): Promise<z.infer<typeof convertedPdfSchema> | null> {
  const data = new Uint8Array(await file.arrayBuffer())
  const loadingTask = pdfjsLib.getDocument({ data })
  const doc = await loadingTask.promise
  const images: Array<{ filename: string; media_type: 'image/png'; data_url: string }> = []

  try {
    for (let pageIndex = 1; pageIndex <= doc.numPages; pageIndex += 1) {
      const page = await doc.getPage(pageIndex)
      const viewport = page.getViewport({ scale: PDF_DPI / 72 })

      const canvas = createCanvas(viewport.width, viewport.height)
      const canvasContext = canvas.getContext('2d')

      await page.render({ canvasContext, viewport }).promise

      const pngBuffer = Buffer.from(canvas.toBuffer('image/png'))
      const base64Data = pngBuffer.toString('base64')
      images.push({
        filename: `page_${String(pageIndex).padStart(2, '0')}.png`,
        media_type: 'image/png',
        data_url: `data:image/png;base64,${base64Data}`,
      })

      await page.cleanup()
    }

    return {
      pages: doc.numPages,
      images,
    }
  } catch (error) {
    if (error instanceof Error) {
      return null
    }
    throw error
  } finally {
    await doc.cleanup()
  }
}

async function pdfFromService(file: File): Promise<z.infer<typeof convertedPdfSchema> | null> {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('dpi', String(PDF_DPI))

  try {
    const response = await fetch(`${parsingServiceUrl()}/convert/images`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    })
    if (!response.ok) {
      return null
    }
    return convertedPdfSchema.parse(await response.json())
  } catch (error) {
    if (error instanceof Error) {
      return null
    }
    throw error
  }
}


function parsingServiceUrl(): string {
  return (process.env.PARSING_SERVICE_URL ?? 'http://127.0.0.1:8000').replace(/\/+$/, '')
}
