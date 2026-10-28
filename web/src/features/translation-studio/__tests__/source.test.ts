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
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { readDocx } from '../lib/docx'
import {
  MAX_FILE_BYTES,
  readTranslationFile,
  splitTranslationText,
} from '../lib/source'

function sourceFile(bytes: Uint8Array, name: string) {
  const file = new File([new Uint8Array(bytes)], name)
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new Uint8Array(bytes).buffer,
  })
  return file
}

describe('translation source preparation', () => {
  it('splits long source text without dropping content or breaking Unicode pairs', () => {
    const source =
      `A short paragraph.\n\n${String.fromCodePoint(0x1f30d)}`.repeat(500)
    const units = splitTranslationText(source)
    expect(units.length).toBeGreaterThan(1)
    expect(
      units
        .map((unit) => unit.text)
        .join('')
        .replaceAll(/\s/g, '')
    ).toBe(source.replaceAll(/\s/g, ''))
    expect(units.every((unit) => (unit.text?.length ?? 0) <= 4000)).toBe(true)
    expect(
      units.every((unit) => !/[\ud800-\udbff]$/.test(unit.text ?? ''))
    ).toBe(true)
  })

  it('rejects empty and oversized text before any model request', () => {
    expect(() => splitTranslationText('   ')).toThrow('No readable text')
    expect(() => splitTranslationText('a'.repeat(100_001))).toThrow('100,000')
  })

  it('extracts DOCX paragraphs and table rows without rendering document HTML', async () => {
    const xml =
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Purchase order</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Price</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
    const bytes = zipSync({
      'word/document.xml': strToU8(xml),
      'unrelated.xml': strToU8('Ignore me'),
    })
    expect((await readDocx(bytes)).text).toBe('Purchase order\nItem\nPrice')
    const source = await readTranslationFile(
      sourceFile(bytes, 'order.docx'),
      new AbortController().signal
    )
    expect(source.format).toBe('docx')
    expect(source.docx).toBeDefined()
    expect(source.units[0].segments?.map((segment) => segment.text)).toEqual([
      'Purchase order',
      'Item',
      'Price',
    ])
    expect(source.imagePages).toBe(0)
    expect(source.pages).toBe(0)
  })

  it('rejects DOCX entity declarations and files without a document body', async () => {
    await expect(
      readDocx(zipSync({ 'word/document.xml': strToU8('<!DOCTYPE x><x/>') }))
    ).rejects.toThrow('unsupported XML')
    await expect(
      readDocx(zipSync({ 'other.xml': strToU8('<x/>') }))
    ).rejects.toThrow('invalid')
  })

  it('prepares a UTF-8 text file and honors cancellation', async () => {
    const file = sourceFile(strToU8('Translate this invoice.'), 'invoice.txt')
    const source = await readTranslationFile(file, new AbortController().signal)
    expect(source.text).toBe('Translate this invoice.')
    expect(source.units).toEqual([{ text: 'Translate this invoice.' }])
    const controller = new AbortController()
    controller.abort()
    await expect(
      readTranslationFile(file, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects unsupported formats, invalid UTF-8, fake images and oversize files', async () => {
    const signal = new AbortController().signal
    await expect(
      readTranslationFile(sourceFile(strToU8('hello'), 'old.doc'), signal)
    ).rejects.toThrow('Supported files')
    await expect(
      readTranslationFile(sourceFile(new Uint8Array([255]), 'bad.txt'), signal)
    ).rejects.toThrow('UTF-8')
    await expect(
      readTranslationFile(sourceFile(strToU8('<svg/>'), 'fake.png'), signal)
    ).rejects.toThrow('image could not be read')
    const file = sourceFile(strToU8('hello'), 'big.txt')
    Object.defineProperty(file, 'size', { value: MAX_FILE_BYTES + 1 })
    await expect(readTranslationFile(file, signal)).rejects.toThrow('10 MB')
  })
})
