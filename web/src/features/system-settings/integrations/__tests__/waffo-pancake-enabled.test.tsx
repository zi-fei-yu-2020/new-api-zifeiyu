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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { PaymentSettingsFixture as Fixture } from './payment-settings-fixture'

function renderSettings(enabled = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Fixture enabled={enabled} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      message: 'success',
      data: {
        stores: [
          {
            id: 'store',
            name: 'Test store',
            status: 'active',
            prodEnabled: false,
            onetimeProducts: [
              { id: 'product', name: 'Wallet top-up', status: 'active' },
            ],
          },
        ],
      },
    },
  })
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
  vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      message: 'success',
      data: { stores: [], store_id: 'store', product_id: 'product' },
    },
  })
})

afterEach(() => vi.restoreAllMocks())

test('saving test configuration does not enable payments', async () => {
  const user = userEvent.setup()
  renderSettings()
  await user.click(screen.getByRole('tab', { name: 'Waffo Pancake' }))
  await user.type(
    screen.getByPlaceholderText('https://example.com/wallet'),
    'https://test.example/wallet'
  )
  await user.click(screen.getByRole('button', { name: 'Save all settings' }))
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      '/api/option/waffo-pancake/save',
      expect.objectContaining({ return_url: 'https://test.example/wallet' })
    )
  )
  expect(api.put).not.toHaveBeenCalled()
  expect(
    screen.getByRole('switch', { name: 'Enable Waffo Pancake payments' })
  ).not.toBeChecked()
})

test('a failed credential save does not enable payments', async () => {
  vi.mocked(api.post).mockResolvedValue({
    data: { message: 'error', data: 'Failed to save configuration' },
  })
  const user = userEvent.setup()
  renderSettings()
  await user.click(screen.getByRole('tab', { name: 'Waffo Pancake' }))
  await user.type(
    screen.getByPlaceholderText('https://example.com/wallet'),
    'https://test.example/wallet'
  )
  await user.click(
    screen.getByRole('switch', { name: 'Enable Waffo Pancake payments' })
  )
  await user.click(screen.getByRole('button', { name: 'Save all settings' }))
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      '/api/option/waffo-pancake/save',
      expect.anything()
    )
  )
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save all settings' })
    ).not.toBeDisabled()
  )
  expect(api.put).not.toHaveBeenCalled()
})

test('saved test credentials stay disabled until the operator enables and saves payments', async () => {
  const user = userEvent.setup()
  renderSettings()
  await user.click(screen.getByRole('tab', { name: 'Waffo Pancake' }))
  const toggle = screen.getByRole('switch', {
    name: 'Enable Waffo Pancake payments',
  })
  expect(toggle).not.toBeChecked()
  await user.click(toggle)
  expect(toggle).toBeChecked()
  expect(api.put).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Save all settings' }))
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith('/api/option/', {
      key: 'WaffoPancakeEnabled',
      value: true,
    })
  )
  expect(api.put).toHaveBeenCalledTimes(1)
  expect(api.post).not.toHaveBeenCalledWith(
    '/api/option/waffo-pancake/save',
    expect.anything()
  )
})

test('disabling payments saves only the switch and preserves stored credentials', async () => {
  const user = userEvent.setup()
  renderSettings(true)
  await user.click(screen.getByRole('tab', { name: 'Waffo Pancake' }))
  const toggle = screen.getByRole('switch', {
    name: 'Enable Waffo Pancake payments',
  })
  expect(toggle).toBeChecked()
  await user.click(toggle)
  await user.click(screen.getByRole('button', { name: 'Save all settings' }))
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith('/api/option/', {
      key: 'WaffoPancakeEnabled',
      value: false,
    })
  )
  expect(api.put).toHaveBeenCalledTimes(1)
  expect(api.post).not.toHaveBeenCalledWith(
    '/api/option/waffo-pancake/save',
    expect.anything()
  )
})
