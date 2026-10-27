/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import type {
  TranslationFormat,
  TranslationRegion,
  TranslationSource,
  TranslationUnit,
} from '../types'
import { groupTranslationSegments, readDocx } from './docx'

export const MAX_FILE_BYTES = 10 * 1024 * 1024
// Keep the limit above the largest supported 20-page technical PDF while
// leaving enough headroom for the structured translation batches.
export const MAX_SOURCE_CHARACTERS = 100_000
export const MAX_PDF_PAGES = 20
const CHUNK_CHARACTERS = 4_000

export function splitTranslationText(text: string): TranslationUnit[] {
  const normalized = text.replaceAll('\r\n', '\n').trim()
  if (!normalized) throw new Error('No readable text was found in this file.')
  if (normalized.length > MAX_SOURCE_CHARACTERS) {
    throw new Error(
      'The source exceeds the 100,000 character limit. Split it into smaller files.'
    )
  }
  const units: TranslationUnit[] = []
  let remaining = normalized
  while (remaining.length > CHUNK_CHARACTERS) {
    let splitAt = remaining.lastIndexOf('\n', CHUNK_CHARACTERS)
    if (splitAt < CHUNK_CHARACTERS / 2) {
      splitAt = remaining.lastIndexOf(' ', CHUNK_CHARACTERS)
    }
    if (splitAt < CHUNK_CHARACTERS / 2) splitAt = CHUNK_CHARACTERS
    // Never split a surrogate pair when translating emoji or supplementary scripts.
    const last = remaining.charCodeAt(splitAt - 1)
    if (last >= 0xd800 && last <= 0xdbff) splitAt -= 1
    units.push({ text: remaining.slice(0, splitAt).trimEnd() })
    remaining = remaining.slice(splitAt).trimStart()
  }
  if (remaining) units.push({ text: remaining })
  return units
}

export async function readTranslationFile(
  file: File,
  signal: AbortSignal
): Promise<TranslationSource> {
  if (file.size === 0) throw new Error('The selected file is empty.')
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('Choose a file smaller than 10 MB.')
  }
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (
    !['png', 'jpg', 'jpeg', 'webp', 'pdf', 'docx', 'txt', 'md'].includes(
      extension
    )
  ) {
    throw new Error(
      'Supported files: PNG, JPG, WebP, PDF, DOCX, TXT and Markdown.'
    )
  }
  const data = new Uint8Array(await file.arrayBuffer())
  signal.throwIfAborted()
  const result: TranslationSource = {
    name: file.name,
    size: file.size,
    text: '',
    units: [],
    pages: 0,
    imagePages: 0,
    format: extension as TranslationFormat,
  }
  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension)) {
    const isPng =
      data[0] === 0x89 &&
      data[1] === 0x50 &&
      data[2] === 0x4e &&
      data[3] === 0x47
    const isJpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    const isWebp =
      new TextDecoder().decode(data.slice(0, 4)) === 'RIFF' &&
      new TextDecoder().decode(data.slice(8, 12)) === 'WEBP'
    if (!isPng && !isJpeg && !isWebp) {
      throw new Error(
        'This image could not be read. Choose a PNG, JPG or WebP image.'
      )
    }
    let mime = 'image/webp'
    if (isPng) mime = 'image/png'
    else if (isJpeg) mime = 'image/jpeg'
    const bitmap = await createImageBitmap(file)
    try {
      signal.throwIfAborted()
      if (bitmap.width * bitmap.height > 40_000_000) {
        throw new Error('The image exceeds the 40 megapixel limit.')
      }
      const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d')
      if (!context) {
        throw new Error('Your browser could not prepare this image.')
      }
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const image = canvas.toDataURL('image/jpeg', 0.92)
      let binary = ''
      for (let offset = 0; offset < data.length; offset += 8192) {
        binary += String.fromCharCode(...data.subarray(offset, offset + 8192))
      }
      return {
        ...result,
        preview: image,
        imagePages: 1,
        units: [{ image, page: 1, locateText: true }],
        renderedPages: [
          {
            image: `data:${mime};base64,${btoa(binary)}`,
            width: bitmap.width,
            height: bitmap.height,
            regions: [],
          },
        ],
      }
    } finally {
      bitmap.close()
    }
  }
  if (extension === 'docx') {
    const document = await readDocx(data)
    signal.throwIfAborted()
    result.text = document.text
    result.units = document.units
    result.docx = document.template
    return result
  }
  if (extension !== 'pdf') {
    try {
      result.text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    } catch {
      throw new Error('Save the text file as UTF-8 and upload it again.')
    }
    result.units = splitTranslationText(result.text)
    return result
  }
  if (new TextDecoder().decode(data.slice(0, 5)) !== '%PDF-') {
    throw new Error('This PDF file could not be read.')
  }
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).href
  const loading = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    cMapUrl: '/static/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/static/pdfjs/standard_fonts/',
    wasmUrl: '/static/pdfjs/wasm/',
  })
  const cancel = () => {
    void loading.destroy()
  }
  signal.addEventListener('abort', cancel, { once: true })
  let imageBytes = 0
  try {
    signal.throwIfAborted()
    const pdf = await loading.promise
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new Error(
        'PDF files are limited to 20 pages. Split the PDF before uploading.'
      )
    }
    result.pages = pdf.numPages
    const textPages: string[] = []
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      signal.throwIfAborted()
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items
        .map((item) =>
          'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''
        )
        .join('')
        .trim()
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({
        scale: Math.min(2, 2000 / Math.max(base.width, base.height)),
      })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      await page.render({ canvas, viewport }).promise
      signal.throwIfAborted()
      const image = canvas.toDataURL('image/jpeg', 0.94)
      imageBytes += image.length
      if (imageBytes > 32 * 1024 * 1024) {
        throw new Error(
          'The scanned pages are too large. Split the PDF into smaller files.'
        )
      }
      // Embedded images are common in technical PDFs (logos, diagrams and
      // cover art). Keep pages with a searchable text layer on the structured
      // path; only image-only pages need a vision model.
      const regions: TranslationRegion[] = []
      if (text.length > 0) {
        textPages.push(text)
        if (textPages.join('\n').length > MAX_SOURCE_CHARACTERS) {
          throw new Error(
            'The source exceeds the 100,000 character limit. Split it into smaller files.'
          )
        }
      }
      if (text.length > 0) {
        for (const item of content.items) {
          if (!('str' in item) || !item.str.trim()) continue
          const m = pdfjs.Util.transform(viewport.transform, item.transform)
          const baseline = Math.hypot(m[0], m[1]) || 1
          const dx = (m[0] / baseline) * item.width * viewport.scale
          const dy = (m[1] / baseline) * item.width * viewport.scale
          const left = Math.max(
            0,
            Math.min(m[4], m[4] + dx, m[4] + m[2], m[4] + dx + m[2])
          )
          const top = Math.max(
            0,
            Math.min(m[5], m[5] + dy, m[5] + m[3], m[5] + dy + m[3])
          )
          const right = Math.min(
            viewport.width,
            Math.max(m[4], m[4] + dx, m[4] + m[2], m[4] + dx + m[2])
          )
          const bottom = Math.min(
            viewport.height,
            Math.max(m[5], m[5] + dy, m[5] + m[3], m[5] + dy + m[3]) +
              Math.hypot(m[2], m[3]) * 0.22
          )
          if (right <= left || bottom <= top) continue
          const region: TranslationRegion = {
            id: `p${pageNumber}r${regions.length}`,
            text: item.str,
            box: [
              (left / viewport.width) * 1000,
              (top / viewport.height) * 1000,
              ((right - left) / viewport.width) * 1000,
              ((bottom - top) / viewport.height) * 1000,
            ] as [number, number, number, number],
          }
          // Adjacent spans on one horizontal line are translated together.
          const previous = regions.at(-1)
          if (
            previous &&
            Math.abs(previous.box[1] - region.box[1]) < 2 &&
            Math.abs(previous.box[3] - region.box[3]) < 2 &&
            region.box[0] >= previous.box[0] &&
            region.box[0] - previous.box[0] - previous.box[2] < 8 &&
            previous.text.length + item.str.length < 2000
          ) {
            previous.text +=
              item.str.startsWith(' ') || previous.text.endsWith(' ')
                ? item.str
                : ` ${item.str}`
            previous.box[2] = Math.max(
              previous.box[2],
              region.box[0] + region.box[2] - previous.box[0]
            )
          } else regions.push(region)
        }
        result.units.push(
          ...groupTranslationSegments(
            regions.map((region) => ({
              id: region.id,
              text: region.text,
              paragraph: region.id,
            }))
          ).map((unit) => ({ ...unit, page: pageNumber }))
        )
      } else {
        result.units.push({ image, page: pageNumber, locateText: true })
        result.imagePages += 1
      }
      result.renderedPages ??= []
      result.renderedPages.push({
        image,
        width: base.width,
        height: base.height,
        regions,
      })
      result.preview ??= image
      canvas.width = 0
      canvas.height = 0
      page.cleanup()
    }
    result.text = textPages.join('\n\n')
    if (!result.units.length) {
      throw new Error('No readable text was found in this file.')
    }
    return result
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new Error('Unlock this password-protected PDF before uploading.')
    }
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
    await loading.destroy()
  }
}
