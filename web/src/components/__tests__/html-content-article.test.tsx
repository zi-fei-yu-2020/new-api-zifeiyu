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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { HtmlContent } from '../html-content'

const fullDocument = readFileSync(
  resolve(import.meta.dirname, 'fixtures/about-gateway-guide.html.txt'),
  'utf8'
)

test('indented full HTML documents render as headings and lists instead of Markdown code', () => {
  const { container } = render(
    <HtmlContent variant='article' content={fullDocument} />
  )
  expect(
    screen.getByRole('heading', { level: 1, name: '🚀 中转站网关配置指南' })
  ).toBeVisible()
  expect(
    screen.getByRole('heading', { level: 2, name: '六、开始使用' })
  ).toBeVisible()
  expect(screen.getAllByRole('list')).toHaveLength(2)
  expect(container.textContent).not.toContain('<h1>')
  expect(container.querySelector('style, meta, title')).toBeNull()
  const download = screen.getByRole('link', { name: 'cc-switch 下载' })
  expect(download).toHaveAttribute('target', '_blank')
  expect(download.getAttribute('rel')?.split(' ')).toEqual(
    expect.arrayContaining(['noopener', 'noreferrer'])
  )
})

test('HTML command blocks preserve exact newlines, blank lines and shell characters', () => {
  const { container } = render(
    <HtmlContent variant='article' content={fullDocument} />
  )
  const blocks = container.querySelectorAll('pre > code')
  expect(blocks).toHaveLength(4)
  const source = new DOMParser().parseFromString(fullDocument, 'text/html')
  source.querySelectorAll('pre > code').forEach((original, index) => {
    expect(blocks[index].textContent).toBe(original.textContent)
  })
  expect(blocks[0].textContent).toContain('$(curl -fsSL')
})

test('article HTML keeps content and uses the application typography instead of embedded positioning and colors', () => {
  const { container } = render(
    <HtmlContent
      variant='article'
      content='<style>h1{color:white;position:fixed;top:0}</style><h1 style="color:white" class="custom-heading">About our service</h1><p>Our tools</p><ul><li>Translation</li></ul><a href="https://example.com">Learn more</a>'
    />
  )
  expect(
    screen.getByRole('heading', { name: 'About our service' })
  ).toBeVisible()
  expect(screen.getByRole('heading')).not.toHaveAttribute('style')
  expect(screen.getByRole('heading')).not.toHaveClass('custom-heading')
  expect(screen.getByRole('list')).toHaveTextContent('Translation')
  expect(screen.getByRole('link', { name: 'Learn more' })).toHaveAttribute(
    'href',
    'https://example.com'
  )
  expect(container.querySelector('style')).toBeNull()
})

test('article HTML cannot inject scripts or embedded executable content', () => {
  const { container } = render(
    <HtmlContent
      variant='article'
      content='<script>alert(1)</script><iframe srcdoc="<script>alert(1)</script>"></iframe><img src="/logo.png" onerror="alert(1)"><p>Safe content</p>'
    />
  )
  expect(screen.getByText('Safe content')).toBeVisible()
  expect(container.querySelector('script, iframe, [onerror]')).toBeNull()
})
