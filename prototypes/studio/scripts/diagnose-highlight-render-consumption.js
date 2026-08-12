/*
 * Browser-side diagnostic for EvidenceHighlightLayer render consumption.
 *
 * Run this in the Studio page DevTools console, then call:
 *
 *   await FREE_loadHighlightRenderFiles()
 *
 * Select:
 *   1. prototypes/parsing_service/data/diagnostics/real-extraction-routing/highlight-routing-report.json
 *   2. prototypes/parsing_service/data/documents/<sha>/parsed_document.json
 *
 * Or, if you already have both objects:
 *
 *   FREE_diagnoseHighlightRender({ routingReport, parsedDocument })
 *
 * The script checks:
 *   - .pdf-viewer container and overlay canvas dimensions
 *   - .page[data-page-number] DOM presence and sizes
 *   - bbox -> page CSS rect conversion using parsed page point dimensions
 *   - whether converted rects fit inside their page and overlay canvas
 *   - whether the overlay canvas has non-transparent pixels near the expected rect
 */

(function installFreeHighlightRenderDiagnostic(global) {
  function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  function byPage(parsedDocument) {
    const out = new Map()
    for (const page of Array.isArray(parsedDocument?.pages) ? parsedDocument.pages : []) {
      if (
        typeof page.page === 'number' &&
        typeof page.width_pt === 'number' &&
        typeof page.height_pt === 'number'
      ) {
        out.set(page.page, page)
      }
    }
    return out
  }

  function findContainer() {
    const candidates = [
      ...document.querySelectorAll('[aria-label="PDF document"] .overflow-auto, .pdf-viewer'),
    ]
    return candidates.find((el) => {
      const style = getComputedStyle(el)
      return style.overflowY === 'auto' || style.overflowY === 'scroll'
    }) ?? candidates.find((el) => el.scrollHeight > el.clientHeight) ?? candidates[0] ?? null
  }

  function findOverlayCanvas(container) {
    const canvases = [...container.querySelectorAll('canvas')]
    return canvases.find((canvas) =>
      canvas.classList.contains('pointer-events-none') ||
      canvas.getAttribute('aria-hidden') === 'true',
    ) ?? canvases.find((canvas) => {
      const style = getComputedStyle(canvas)
      return style.position === 'absolute' && Number(style.zIndex || 0) >= 10
    }) ?? null
  }

  function rectOf(el) {
    const rect = el.getBoundingClientRect()
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
    }
  }

  function sampleCanvasAlpha(canvas, x, y, radius = 2) {
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const scaleX = canvas.width / Math.max(1, canvas.getBoundingClientRect().width)
    const scaleY = canvas.height / Math.max(1, canvas.getBoundingClientRect().height)
    const cx = Math.round(x * scaleX)
    const cy = Math.round(y * scaleY)
    let samples = 0
    let nonTransparent = 0
    let maxAlpha = 0
    for (let yy = cy - radius; yy <= cy + radius; yy++) {
      for (let xx = cx - radius; xx <= cx + radius; xx++) {
        if (xx < 0 || yy < 0 || xx >= canvas.width || yy >= canvas.height) continue
        const alpha = ctx.getImageData(xx, yy, 1, 1).data[3]
        samples++
        if (alpha > 0) nonTransparent++
        maxAlpha = Math.max(maxAlpha, alpha)
      }
    }
    return { samples, nonTransparent, maxAlpha }
  }

  function scanCanvasAlpha(canvas, step = 4) {
    const ctx = canvas.getContext('2d')
    if (!ctx || canvas.width <= 0 || canvas.height <= 0) {
      return {
        step,
        sampled: 0,
        nonTransparent: 0,
        bounds: null,
        rows: [],
      }
    }

    let sampled = 0
    let nonTransparent = 0
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    const rowBuckets = new Map()

    for (let y = 0; y < canvas.height; y += step) {
      const image = ctx.getImageData(0, y, canvas.width, 1).data
      for (let x = 0; x < canvas.width; x += step) {
        sampled++
        const alpha = image[x * 4 + 3]
        if (alpha <= 0) continue
        nonTransparent++
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
        const bucket = Math.floor(y / 100) * 100
        rowBuckets.set(bucket, (rowBuckets.get(bucket) ?? 0) + 1)
      }
    }

    return {
      step,
      sampled,
      nonTransparent,
      bounds: nonTransparent > 0 ? { minX, minY, maxX, maxY } : null,
      rows: [...rowBuckets.entries()]
        .sort(([a], [b]) => a - b)
        .map(([y, count]) => ({ y, count })),
    }
  }

  function pageBands(container, parsedDocument) {
    const containerRect = container.getBoundingClientRect()
    const pages = byPage(parsedDocument)
    return [...container.querySelectorAll('.page[data-page-number]')].map((pageEl) => {
      const pageNumber = Number(pageEl.getAttribute('data-page-number'))
      const pageRect = pageEl.getBoundingClientRect()
      const top = pageRect.top - containerRect.top + container.scrollTop + pageEl.clientTop
      const left = pageRect.left - containerRect.left + container.scrollLeft + pageEl.clientLeft
      return {
        pageNumber,
        top,
        bottom: top + pageEl.clientHeight,
        left,
        right: left + pageEl.clientWidth,
        clientWidth: pageEl.clientWidth,
        clientHeight: pageEl.clientHeight,
        parsedWidthPt: pages.get(pageNumber)?.width_pt ?? null,
        parsedHeightPt: pages.get(pageNumber)?.height_pt ?? null,
      }
    })
  }

  function alphaByPage(canvas, bands, step = 4) {
    const ctx = canvas.getContext('2d')
    if (!ctx) return []
    return bands.map((band) => {
      let sampled = 0
      let nonTransparent = 0
      let maxAlpha = 0
      const startY = Math.max(0, Math.floor(band.top))
      const endY = Math.min(canvas.height, Math.ceil(band.bottom))
      const startX = Math.max(0, Math.floor(band.left))
      const endX = Math.min(canvas.width, Math.ceil(band.right))
      for (let y = startY; y < endY; y += step) {
        const image = ctx.getImageData(startX, y, Math.max(1, endX - startX), 1).data
        for (let x = 0; x < endX - startX; x += step) {
          sampled++
          const alpha = image[x * 4 + 3]
          if (alpha > 0) nonTransparent++
          maxAlpha = Math.max(maxAlpha, alpha)
        }
      }
      return {
        pageNumber: band.pageNumber,
        top: Number(band.top.toFixed(1)),
        bottom: Number(band.bottom.toFixed(1)),
        sampled,
        nonTransparent,
        maxAlpha,
      }
    })
  }

  function diagnoseHighlightRender({ routingReport, parsedDocument }) {
    if (!isRecord(routingReport)) throw new Error('routingReport must be an object')
    if (!isRecord(parsedDocument)) throw new Error('parsedDocument must be an object')

    const container = findContainer()
    if (!container) throw new Error('Could not find .pdf-viewer container')
    const overlayCanvas = findOverlayCanvas(container)
    if (!overlayCanvas) throw new Error('Could not find EvidenceHighlightLayer overlay canvas')

    const containerRect = container.getBoundingClientRect()
    const pages = byPage(parsedDocument)
    const bands = pageBands(container, parsedDocument)
    const canvasAlphaScan = scanCanvasAlpha(overlayCanvas)
    const canvasAlphaByPage = alphaByPage(overlayCanvas, bands)
    const matched = (Array.isArray(routingReport.highlights) ? routingReport.highlights : [])
      .filter((item) => item?.matched && item.match?.bbox && typeof item.match.pageNumber === 'number')

    const rows = matched.map((item) => {
      const pageNumber = item.match.pageNumber
      const page = pages.get(pageNumber)
      const pageEl = container.querySelector(`.page[data-page-number="${pageNumber}"]`)
      if (!page || !pageEl) {
        return {
          path: item.path,
          pageNumber,
          segmentId: item.sourceScope?.segmentId,
          ok: false,
          reason: !page ? 'missing_parsed_page_dims' : 'missing_page_element',
        }
      }

      const pageRect = pageEl.getBoundingClientRect()
      const scaleX = pageEl.clientWidth / page.width_pt
      const scaleY = pageEl.clientHeight / page.height_pt
      const bbox = item.match.bbox
      const rect = {
        x: bbox.x0 * scaleX,
        y: bbox.y0 * scaleY,
        width: (bbox.x1 - bbox.x0) * scaleX,
        height: (bbox.y1 - bbox.y0) * scaleY,
      }
      const withinPage =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.x >= -1 &&
        rect.y >= -1 &&
        rect.x + rect.width <= pageEl.clientWidth + 1 &&
        rect.y + rect.height <= pageEl.clientHeight + 1

      const pageTop = pageRect.top - containerRect.top + container.scrollTop + pageEl.clientTop
      const pageLeft = pageRect.left - containerRect.left + container.scrollLeft + pageEl.clientLeft
      const canvasX = pageLeft + rect.x
      const canvasY = pageTop + rect.y
      const centerX = canvasX + rect.width / 2
      const centerY = canvasY + rect.height / 2
      const withinCanvas =
        canvasX >= -2 &&
        canvasY >= -2 &&
        canvasX + rect.width <= overlayCanvas.width + 2 &&
        canvasY + rect.height <= overlayCanvas.height + 2
      const alpha = sampleCanvasAlpha(overlayCanvas, centerX, centerY)

      return {
        path: item.path,
        value: item.value,
        segmentId: item.sourceScope?.segmentId,
        pageNumber,
        ownedTables: item.ownedTableIds?.join(', ') ?? '',
        pageClient: `${pageEl.clientWidth}x${pageEl.clientHeight}`,
        pagePts: `${page.width_pt}x${page.height_pt}`,
        scaleX: Number(scaleX.toFixed(4)),
        scaleY: Number(scaleY.toFixed(4)),
        rect: `${rect.x.toFixed(1)},${rect.y.toFixed(1)} ${rect.width.toFixed(1)}x${rect.height.toFixed(1)}`,
        canvasXY: `${canvasX.toFixed(1)},${canvasY.toFixed(1)}`,
        withinPage,
        withinCanvas,
        alphaMax: alpha?.maxAlpha ?? null,
        alphaHits: alpha?.nonTransparent ?? null,
        ok: withinPage && withinCanvas && (alpha?.maxAlpha ?? 0) > 0,
        reason:
          !withinPage ? 'rect_outside_page'
            : !withinCanvas ? 'rect_outside_overlay_canvas'
              : (alpha?.maxAlpha ?? 0) <= 0 ? 'no_overlay_pixels_at_expected_rect'
                : 'ok',
      }
    })

    const summary = {
      container: rectOf(container),
      scroll: {
        scrollTop: container.scrollTop,
        scrollLeft: container.scrollLeft,
        scrollWidth: container.scrollWidth,
        scrollHeight: container.scrollHeight,
        clientWidth: container.clientWidth,
        clientHeight: container.clientHeight,
      },
      overlayCanvas: {
        width: overlayCanvas.width,
        height: overlayCanvas.height,
        css: rectOf(overlayCanvas),
      },
      pageElements: container.querySelectorAll('.page[data-page-number]').length,
      pageBands: bands,
      canvasAlphaScan,
      canvasAlphaByPage,
      matchedHighlights: matched.length,
      ok: rows.filter((row) => row.ok).length,
      failed: rows.filter((row) => !row.ok).length,
      failuresByReason: rows.reduce((acc, row) => {
        acc[row.reason] = (acc[row.reason] ?? 0) + 1
        return acc
      }, {}),
    }

    const report = { summary, rows }
    global.__FREE_HIGHLIGHT_RENDER_REPORT__ = report
    console.log('FREE highlight render diagnostic summary:', summary)
    console.table(canvasAlphaByPage)
    console.table(rows)
    return report
  }

  async function loadJsonFile(label) {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.style.display = 'none'
    document.body.appendChild(input)
    try {
      const file = await new Promise((resolve, reject) => {
        input.addEventListener('change', () => {
          const selected = input.files?.[0]
          selected ? resolve(selected) : reject(new Error(`No file selected for ${label}`))
        }, { once: true })
        console.log(`Select ${label}`)
        input.click()
      })
      return JSON.parse(await file.text())
    } finally {
      input.remove()
    }
  }

  async function loadHighlightRenderFiles() {
    const routingReport = await loadJsonFile('highlight-routing-report.json')
    const parsedDocument = await loadJsonFile('parsed_document.json')
    return diagnoseHighlightRender({ routingReport, parsedDocument })
  }

  global.FREE_diagnoseHighlightRender = diagnoseHighlightRender
  global.FREE_loadHighlightRenderFiles = loadHighlightRenderFiles
})(window)
