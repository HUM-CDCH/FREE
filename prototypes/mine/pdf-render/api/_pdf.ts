/// <reference types="node" />

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { createRequire } from 'node:module'

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

const execFileAsync = promisify(execFile)
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

const localConversionScript = `
import base64
import json
import sys
from pathlib import Path
from pdf_utils import convert_pdf_to_images

def encode_image(image_path):
    with open(image_path, "rb") as image_file:
        return base64.b64encode(image_file.read()).decode("utf-8")

paths = convert_pdf_to_images(sys.argv[1], sys.argv[2], dpi=int(sys.argv[3]))
print(json.dumps({
    "pages": len(paths),
    "images": [
        {
            "filename": Path(path).name,
            "media_type": "image/png",
            "data_url": f"data:image/png;base64,{encode_image(path)}",
        }
        for path in paths
    ],
}))
`

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
    (await pdfFromService(file)) ?? (await pdfFromLocalPdfJs(file)) ?? (await pdfFromLocalPython(file))
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

async function pdfFromLocalPython(file: File): Promise<z.infer<typeof convertedPdfSchema>> {
  const tempDir = await mkdtemp(join(tmpdir(), 'free-pdf-'))
  const pdfPath = join(tempDir, 'document.pdf')
  const outputDir = join(tempDir, 'images')

  try {
    await writeFile(pdfPath, new Uint8Array(await file.arrayBuffer()))
    const { stdout } = await execFileAsync(
      'uv',
      ['run', 'python', '-c', localConversionScript, pdfPath, outputDir, String(PDF_DPI)],
      {
        cwd: parsingServicePath(),
        maxBuffer: LOCAL_MAX_BUFFER,
      },
    )
    return convertedPdfSchema.parse(JSON.parse(stdout))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

function parsingServiceUrl(): string {
  return (process.env.PARSING_SERVICE_URL ?? 'http://127.0.0.1:8000').replace(/\/+$/, '')
}

function parsingServicePath(): string {
  return process.env.PARSING_SERVICE_PATH ?? resolve(process.cwd(), '..', 'parsing_service')
}
