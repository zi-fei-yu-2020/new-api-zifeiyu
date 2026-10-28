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
// Model output is untrusted. Every reader validates shape and length and
// throws a fixed i18n key instead of rendering partial or malformed data.
export const MALFORMED_RESPONSE =
  'The model returned an unexpected format. Try again or choose another model.'

const MAX_TEXT = 8_000

export function parseModelJson(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error(MALFORMED_RESPONSE)
  try {
    const value: unknown = JSON.parse(body.slice(start, end + 1))
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(MALFORMED_RESPONSE)
    }
    return value as Record<string, unknown>
  } catch {
    throw new Error(MALFORMED_RESPONSE)
  }
}

export function readString(value: unknown, required = false): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT) {
    if (required || value != null) throw new Error(MALFORMED_RESPONSE)
    return ''
  }
  const text = value.trim()
  if (required && !text) throw new Error(MALFORMED_RESPONSE)
  return text
}

export function readStrings(value: unknown, limit = 12): string[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(MALFORMED_RESPONSE)
  return value
    .slice(0, limit)
    .map((item) => readString(item))
    .filter((item, index, all) => item && all.indexOf(item) === index)
}

export function readRecords<T>(
  value: unknown,
  read: (item: Record<string, unknown>) => T,
  limit = 12
): T[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(MALFORMED_RESPONSE)
  return value.slice(0, limit).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(MALFORMED_RESPONSE)
    }
    return read(item as Record<string, unknown>)
  })
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const value = key(item)
    if (seen.has(value)) return false
    seen.add(value)
    return true
  })
}

export function readScore(value: unknown, max: number): number {
  const score = typeof value === 'string' ? Number(value) : value
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new Error(MALFORMED_RESPONSE)
  }
  return Math.min(Math.max(Math.round(score), 0), max)
}
