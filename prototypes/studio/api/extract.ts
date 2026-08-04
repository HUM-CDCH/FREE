import {
  extractWithModel,
  json,
  modelError,
  parseDocument,
  parseTemperature,
  RequestError,
} from './_model'
import {
  findPrimaryArrayKey,
  getExtractionStrategy,
  pageRangeForOffsets,
  splitMarkdownByHeadings,
} from './_catalog_sections'

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData()
    const template = parseTemplate(form.get('template'))
    const instruction = stringValue(form.get('instruction'))
    const document = await parseDocument(form)
    const result = await extractWithModel({
      document,
      template,
      instruction,
      temperature: parseTemperature(form.get('temperature')),
      hasTables: form.get('has_tables') === 'true',
    })

    const debug = buildExtractDebug(document.markdown, template)
    return json(debug ? { ...result, debug } : result)
  } catch (error) {
    return modelError(error)
  }
}

function buildExtractDebug(markdown: string | null, template: unknown): unknown | null {
  if (!markdown) {
    return null
  }

  const strategy = getExtractionStrategy(template)
  const arrayKey = strategy === 'catalog' ? findPrimaryArrayKey(template) : null
  const sections = arrayKey ? splitMarkdownByHeadings(markdown) : []
  return {
    document_markdown: {
      length: markdown.length,
      exact_page_breaks: (markdown.match(/\n\n---\n\n/g) ?? []).length,
      loose_page_breaks: (markdown.match(/^[ \t]*---[ \t]*$/gm) ?? []).length,
      first_exact_page_break_index: markdown.indexOf('\n\n---\n\n'),
      first_loose_page_break_index: markdown.search(/^[ \t]*---[ \t]*$/m),
    },
    sectioning: {
      strategy,
      array_key: arrayKey,
      section_count: sections.length,
      sections: sections.map((section, index) => {
        const pageRange = pageRangeForOffsets(markdown, section.startOffset, section.endOffset)
        return {
          index,
          heading_text: section.headingText,
          start_offset: section.startOffset,
          end_offset: section.endOffset,
          start_page: pageRange.startPage,
          end_page: pageRange.endPage,
        }
      }),
    },
  }
}

function parseTemplate(value: FormDataEntryValue | null): unknown {
  if (value === null || value === '') {
    return {}
  }
  if (typeof value !== 'string') {
    throw new RequestError(400, 'template must be JSON')
  }
  return JSON.parse(value)
}

function stringValue(value: FormDataEntryValue | null): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
