/// <reference types="node" />

import { createRequire } from 'node:module'

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

const PDF_DPI = 150

const require = createRequire(import.meta.url)
const { createCanvas } = require('@napi-rs/canvas')

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

type ConvertedPdf = {
  readonly pages: number
  readonly images: ReadonlyArray<{
    readonly filename: string
    readonly media_type: 'image/png'
    readonly data_url: string
  }>
}


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
  // PDFs are normally indexed to Markdown by the parsing service before reaching
  // the model; this local rasterisation only runs for the image-fallback path.
  const converted = (await pdfFromLocalPdfJs(file)) ?? undefined
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

async function pdfFromLocalPdfJs(file: File): Promise<ConvertedPdf | null> {
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

      // pdfjs 6 requires `canvas` alongside `canvasContext`; the @napi-rs/canvas
      // types don't line up with the DOM canvas types, hence the cast.
      await page
        .render({ canvas, canvasContext, viewport } as unknown as Parameters<typeof page.render>[0])
        .promise

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

