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

import { PaymentSettingsFixture } from './payment-settings-fixture'

beforeEach(() => {
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
})
afterEach(() => vi.restoreAllMocks())

function renderSettings(enabled = false) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
  render(
    <QueryClientProvider client={client}>
      <PaymentSettingsFixture
        bepusdt={{
          BepusdtEnabled: enabled,
          BepusdtBaseURL: enabled ? 'https://pay.example' : '',
        }}
      />
    </QueryClientProvider>
  )
}

test('saving BEpusdt credentials keeps payments disabled by default', async () => {
  const user = userEvent.setup()
  renderSettings()
  await user.click(screen.getByRole('tab', { name: 'BEpusdt' }))
  expect(
    screen.getByRole('switch', { name: 'Enable BEpusdt payments' })
  ).not.toBeChecked()
  await user.type(
    screen.getByLabelText('BEpusdt gateway URL'),
    'https://pay.example'
  )
  await user.type(screen.getByLabelText('BEpusdt API token'), 'test-secret')
  await user.click(screen.getByRole('button', { name: 'Save all settings' }))
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.put).mock.calls.map((call) => call[1])).toEqual([
    { key: 'BepusdtBaseURL', value: 'https://pay.example' },
    { key: 'BepusdtApiKey', value: 'test-secret' },
  ])
})

test('enabling BEpusdt saves credentials before enabling the gateway', async () => {
  const user = userEvent.setup()
  renderSettings()
  await user.click(screen.getByRole('tab', { name: 'BEpusdt' }))
  await user.type(
    screen.getByLabelText('BEpusdt gateway URL'),
    'https://pay.example'
  )
  await user.type(screen.getByLabelText('BEpusdt API token'), 'test-secret')
  await user.click(
    screen.getByRole('switch', { name: 'Enable BEpusdt payments' })
  )
  await user.click(screen.getByRole('button', { name: 'Save all settings' }))
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(3))
  expect(vi.mocked(api.put).mock.calls[2][1]).toEqual({
    key: 'BepusdtEnabled',
    value: true,
  })
})

test('disabling BEpusdt can clear its address without replacing the hidden token', async () => {
  const user = userEvent.setup()
  renderSettings(true)
  await user.click(screen.getByRole('tab', { name: 'BEpusdt' }))
  expect(screen.getByLabelText('BEpusdt API token')).toHaveValue('')
  await user.click(
    screen.getByRole('switch', { name: 'Enable BEpusdt payments' })
  )
  await user.clear(screen.getByLabelText('BEpusdt gateway URL'))
  await user.click(screen.getByRole('button', { name: 'Save all settings' }))
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.put).mock.calls.map((call) => call[1])).toEqual([
    { key: 'BepusdtEnabled', value: false },
    { key: 'BepusdtBaseURL', value: '' },
  ])
})

test('invalid BEpusdt pricing is shown on the field and is not saved', async () => {
  const user = userEvent.setup()
  renderSettings()
  await user.click(screen.getByRole('tab', { name: 'BEpusdt' }))
  const price = screen.getByLabelText('USD price per credit unit')
  await user.clear(price)
  await user.type(price, '0')
  await user.click(screen.getByRole('button', { name: 'Save all settings' }))
  await waitFor(() => expect(price).toHaveAttribute('aria-invalid', 'true'))
  expect(api.put).not.toHaveBeenCalled()
})
