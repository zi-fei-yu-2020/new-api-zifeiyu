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
import type { TranslationRegion, TranslationSegment } from '../types'

const STRUCTURE_ERROR =
  'The model did not preserve the document structure. Try another model; completed sections are retained.'

function readStructuredResponse(
  text: string,
  arrayKey?: 'regions'
): Record<string, unknown> {
  try {
    let content = text
      .trim()
      .replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')
    let value: unknown
    try {
      value = JSON.parse(content)
    } catch {
      // Some otherwise capable models add a short sentence before/after the
      // JSON object. Extract the outermost JSON value before rejecting it.
      const start = content.indexOf('{')
      const end = content.lastIndexOf('}')
      if (start < 0 || end <= start) throw new Error()
      content = content.slice(start, end + 1)
      value = JSON.parse(content)
    }
    if (Array.isArray(value) && arrayKey) return { [arrayKey]: value }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error()
    }
    return value as Record<string, unknown>
  } catch {
    throw new Error(STRUCTURE_ERROR)
  }
}

function translatedText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 16_000 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return (
        (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
        (code >= 0xd800 && code <= 0xdfff) ||
        code === 0xfffe ||
        code === 0xffff
      )
    })
  ) {
    throw new Error(STRUCTURE_ERROR)
  }
  return value
}

export function readSegmentTranslations(
  text: string,
  segments: TranslationSegment[]
): Record<string, string> {
  const data = readStructuredResponse(text)
  if (
    !Array.isArray(data.translations) ||
    data.translations.length !== segments.length
  ) {
    throw new Error(STRUCTURE_ERROR)
  }
  const expected = new Map(segments.map((segment) => [segment.id, segment]))
  const translations: Record<string, string> = {}
  for (const item of data.translations) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      !expected.has(item.id) ||
      Object.hasOwn(translations, item.id)
    ) {
      throw new Error(STRUCTURE_ERROR)
    }
    const translated = translatedText(item.text)
    const source = expected.get(item.id)?.text ?? ''
    // Runs often split words from their trailing space; do not join them accidentally.
    translations[item.id] =
      (source.match(/^\s+/)?.[0] ?? '') +
      translated.trim() +
      (source.match(/\s+$/)?.[0] ?? '')
  }
  return translations
}

export function readImageTranslations(
  text: string,
  page: number
): TranslationRegion[] {
  const data = readStructuredResponse(text, 'regions')
  if (!Array.isArray(data.regions) || data.regions.length > 250) {
    throw new Error(STRUCTURE_ERROR)
  }
  let length = 0
  return data.regions.map((item: unknown, index: number) => {
    if (
      !item ||
      typeof item !== 'object' ||
      !('box' in item) ||
      !('text' in item) ||
      !Array.isArray(item.box) ||
      item.box.length !== 4 ||
      !item.box.every(
        (n: unknown) => typeof n === 'number' && Number.isFinite(n)
      )
    ) {
      throw new Error(STRUCTURE_ERROR)
    }
    const box = item.box as [number, number, number, number]
    if (
      box[0] < 0 ||
      box[1] < 0 ||
      box[2] <= 0 ||
      box[3] <= 0 ||
      box[0] + box[2] > 1000 ||
      box[1] + box[3] > 1000
    ) {
      throw new Error(STRUCTURE_ERROR)
    }
    const translated = translatedText(item.text)
    length += translated.length
    if (length > 60_000) throw new Error(STRUCTURE_ERROR)
    return { id: `p${page}ocr${index}`, box, text: translated }
  })
}
