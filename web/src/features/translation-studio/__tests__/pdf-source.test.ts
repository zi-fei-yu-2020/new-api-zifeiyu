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
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { readTranslationFile } from '../lib/source'

const pdf = vi.hoisted(() => ({
  items: [] as object[],
  operations: [] as number[],
  cleanup: vi.fn(),
  destroy: vi.fn(),
}))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  OPS: {
    paintImageXObject: 85,
    paintInlineImageXObject: 86,
    paintImageMaskXObject: 83,
    paintImageXObjectRepeat: 88,
    paintInlineImageXObjectGroup: 87,
    paintImageMaskXObjectGroup: 84,
    paintImageMaskXObjectRepeat: 89,
  },
  Util: { transform: () => [1, 0, 0, 10, 10, 10] },
  getDocument: () => ({
    destroy: pdf.destroy,
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: pdf.items }),
        getOperatorList: async () => ({ fnArray: pdf.operations }),
        getViewport: ({ scale }: { scale: number }) => ({
          width: 200 * scale,
          height: 300 * scale,
          scale,
          transform: [1, 0, 0, 1, 0, 0],
        }),
        render: () => ({ promise: Promise.resolve() }),
        cleanup: pdf.cleanup,
      }),
    }),
  }),
}))
beforeEach(() => {
  pdf.items = [
    {
      str: 'Product safety attachment',
      hasEOL: true,
      width: 150,
      transform: [1, 0, 0, 10, 10, 10],
    },
  ]
  pdf.operations = []
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/jpeg;base64,cGFnZQ=='
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D
  )
})
afterEach(() => vi.restoreAllMocks())
async function prepare() {
  const bytes = new TextEncoder().encode('%PDF-test')
  const file = new File([bytes], 'attachment.pdf')
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => bytes.buffer,
  })
  return readTranslationFile(file, new AbortController().signal)
}
function legacySignal() {
  return {
    aborted: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as AbortSignal
}
it('keeps searchable text-only PDFs on the structured text path', async () => {
  const result = await prepare()
  expect(result.imagePages).toBe(0)
  expect(result.units[0].segments?.[0].text).toBe('Product safety attachment')
  expect(result.units[0].image).toBeUndefined()
})
it('keeps a mixed page on the structured text path when searchable text exists', async () => {
  pdf.operations = [85]
  const result = await prepare()
  expect(result.imagePages).toBe(0)
  expect(result.units[0].segments?.[0].text).toBe('Product safety attachment')
  expect(result.units[0].image).toBeUndefined()
  expect(result.text).toContain('Product safety attachment')
  expect(result.renderedPages?.[0].regions.length).toBeGreaterThan(0)
})
it('continues to recognize scanned pages without selectable text', async () => {
  pdf.items = []
  pdf.operations = [86]
  const result = await prepare()
  expect(result.imagePages).toBe(1)
  expect(result.units[0].locateText).toBe(true)
})
it('does not require AbortSignal.throwIfAborted in older browsers', async () => {
  const bytes = new TextEncoder().encode('%PDF-test')
  const file = new File([bytes], 'attachment.pdf')
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => bytes.buffer,
  })
  const result = await readTranslationFile(file, legacySignal())
  expect(result.units[0].segments?.[0].text).toBe('Product safety attachment')
})
