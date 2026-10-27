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
  DocxTemplate,
  TranslationSegment,
  TranslationUnit,
} from '../types'

const WORD_NAMESPACES = [
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_XML_BYTES = 8 * 1024 * 1024
const MAX_CHARACTERS = 100_000

function parseWordXml(bytes: Uint8Array): Document {
  let xml: string
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('This DOCX file could not be read.')
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error('This DOCX file contains unsupported XML declarations.')
  }
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  if (document.querySelectorAll('parsererror').length) {
    throw new Error('This DOCX file could not be read.')
  }
  return document
}

function wordTextNodes(document: Document): Element[] {
  return [...document.querySelectorAll('*')].filter(
    (node) =>
      node.localName === 't' &&
      WORD_NAMESPACES.includes(node.namespaceURI ?? '')
  )
}

// Keep each run's identity, but translate adjacent runs together for context.
export function groupTranslationSegments(
  segments: TranslationSegment[]
): TranslationUnit[] {
  const units: TranslationUnit[] = []
  let batch: TranslationSegment[] = []
  let length = 0
  for (const segment of segments) {
    if (
      batch.length &&
      // Keep structured JSON batches small enough for compact models to return
      // every segment id without truncating or dropping entries.
      (length + segment.text.length > 1200 || batch.length >= 20)
    ) {
      units.push({ segments: batch })
      batch = []
      length = 0
    }
    batch.push(segment)
    length += segment.text.length
  }
  if (batch.length) units.push({ segments: batch })
  return units
}

export async function readDocx(data: Uint8Array): Promise<{
  template: DocxTemplate
  units: TranslationUnit[]
  text: string
}> {
  const { unzipSync } = await import('fflate')
  let expanded = 0
  let count = 0
  let oversized = false
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(data, {
      filter: (file) => {
        expanded += file.originalSize
        count += 1
        if (
          expanded > MAX_ARCHIVE_BYTES ||
          count > 4096 ||
          (file.name.endsWith('.xml') && file.originalSize > MAX_XML_BYTES)
        ) {
          oversized = true
        }
        return !oversized
      },
    })
  } catch {
    throw new Error('This DOCX file could not be read.')
  }
  if (oversized || !files['word/document.xml']) {
    throw new Error(
      'This DOCX file is invalid or its text content is too large.'
    )
  }
  const parts = Object.keys(files)
    .filter((name) =>
      /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(
        name
      )
    )
    .sort((a, b) => {
      if (a === 'word/document.xml') return -1
      if (b === 'word/document.xml') return 1
      return a.localeCompare(b)
    })
  const template: DocxTemplate = { files, nodes: [] }
  const segments: TranslationSegment[] = []
  const preview: string[] = []
  let total = 0
  for (const part of parts) {
    const document = parseWordXml(files[part])
    if (
      part === 'word/document.xml' &&
      !WORD_NAMESPACES.some(
        (namespace) => document.getElementsByTagNameNS(namespace, 'body').length
      )
    ) {
      throw new Error('This DOCX file could not be read.')
    }
    const paragraphIds = new Map<Element, string>()
    for (const [index, node] of wordTextNodes(document).entries()) {
      const text = node.textContent ?? ''
      if (!text.trim()) continue
      let parent = node.parentElement
      let paragraph: Element | null = null
      let deleted = false
      while (parent) {
        if (WORD_NAMESPACES.includes(parent.namespaceURI ?? '')) {
          if (parent.localName === 'p' && !paragraph) paragraph = parent
          if (parent.localName === 'del') deleted = true
        }
        parent = parent.parentElement
      }
      if (deleted) continue
      total += text.length
      if (total > MAX_CHARACTERS) {
        throw new Error(
          'The source exceeds the 100,000 character limit. Split it into smaller files.'
        )
      }
      if (paragraph && !paragraphIds.has(paragraph)) {
        paragraphIds.set(paragraph, `${part}:p${paragraphIds.size}`)
      }
      const paragraphId = paragraph
        ? (paragraphIds.get(paragraph) ?? `${part}:t${index}`)
        : `${part}:t${index}`
      const ids: string[] = []
      // Array.from preserves surrogate pairs; original whitespace is retained.
      const characters = [...text]
      for (let offset = 0; offset < characters.length; offset += 1200) {
        const id = `s${segments.length}`
        ids.push(id)
        segments.push({
          id,
          text: characters.slice(offset, offset + 1200).join(''),
          paragraph: paragraphId,
        })
      }
      template.nodes.push({ part, index, ids })
      preview.push(text)
    }
  }
  if (!segments.length) {
    throw new Error('No readable text was found in this file.')
  }
  return {
    template,
    units: groupTranslationSegments(segments),
    text: preview.join('\n'),
  }
}

export async function exportDocx(
  template: DocxTemplate,
  translations: Record<string, string>
): Promise<Blob> {
  const { zipSync, strToU8 } = await import('fflate')
  const files = { ...template.files }
  const parts = new Map<string, { document: Document; nodes: Element[] }>()
  for (const location of template.nodes) {
    // Partial exports keep an incomplete source node intact.
    if (!location.ids.every((id) => Object.hasOwn(translations, id))) continue
    let part = parts.get(location.part)
    if (!part) {
      const document = parseWordXml(files[location.part])
      part = { document, nodes: wordTextNodes(document) }
      parts.set(location.part, part)
    }
    const node = part.nodes[location.index]
    if (!node) throw new Error('This DOCX file could not be read.')
    node.textContent = location.ids.map((id) => translations[id]).join('')
    node.setAttributeNS(
      'http://www.w3.org/XML/1998/namespace',
      'xml:space',
      'preserve'
    )
  }
  for (const [name, part] of parts) {
    files[name] = strToU8(new XMLSerializer().serializeToString(part.document))
  }
  return new Blob([new Uint8Array(zipSync(files))], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}
