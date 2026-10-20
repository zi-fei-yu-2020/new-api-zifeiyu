import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { HtmlContent } from '../html-content'

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
