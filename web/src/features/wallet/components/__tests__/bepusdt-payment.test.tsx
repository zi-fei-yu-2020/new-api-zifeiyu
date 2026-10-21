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
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { requestPaymentAmount, usePayment } from '../../hooks/use-payment'
import { getMinTopupAmount } from '../../lib/payment'
import type { TopupInfo } from '../../types'
import { BepusdtPaymentStatus } from '../bepusdt-payment-status'
import { PaymentConfirmDialog } from '../dialogs/payment-confirm-dialog'

afterEach(() => {
  vi.restoreAllMocks()
  useAuthStore.getState().auth.reset()
})

test('BEpusdt quotes use the dedicated endpoint and its own minimum amount', async () => {
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { message: 'success', data: '2.50' } })
  expect(await requestPaymentAmount(2, 'bepusdt')).toBe(2.5)
  expect(post).toHaveBeenCalledWith(
    '/api/user/bepusdt/amount',
    { amount: 2 },
    expect.anything()
  )
  const info = {
    enable_online_topup: true,
    min_topup: 10,
    enable_bepusdt_topup: true,
    bepusdt_min_topup: 1,
  } as TopupInfo
  expect(getMinTopupAmount(info)).toBe(1)
  expect(getMinTopupAmount(info, 'bepusdt')).toBe(1)
  expect(getMinTopupAmount(info, 'epay')).toBe(10)
})

test('BEpusdt confirmation identifies USD and prevents unquoted payments', () => {
  const confirm = vi.fn()
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    onConfirm: confirm,
    topupAmount: 2,
    paymentAmount: 2.5,
    paymentMethod: { name: 'BEpusdt', type: 'bepusdt' },
    calculating: false,
    processing: false,
  }
  const { rerender } = render(<PaymentConfirmDialog {...props} />)
  expect(screen.getByText('2.5 USD')).toBeVisible()
  rerender(<PaymentConfirmDialog {...props} paymentAmount={0} calculating />)
  expect(screen.getByRole('button', { name: 'Confirm Payment' })).toBeDisabled()
})

test('returning from checkout waits for server confirmation and refreshes the balance once', async () => {
  useAuthStore.getState().auth.setUser({ id: 1, username: 'buyer', role: 1 })
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValueOnce({
      data: {
        success: true,
        data: { status: 'pending', order_id: 'BEP-order-1' },
      },
    })
    .mockResolvedValue({
      data: {
        success: true,
        data: { status: 'success', order_id: 'BEP-order-1' },
      },
    })
  const onPaid = vi.fn().mockResolvedValue(undefined)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  render(
    <QueryClientProvider client={client}>
      <BepusdtPaymentStatus orderID='BEP-order-1' onPaid={onPaid} />
    </QueryClientProvider>
  )
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1))
  expect(onPaid).not.toHaveBeenCalled()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByText(
    'BEpusdt payment credited. Your balance has been updated.'
  )
  await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1))
  await client.invalidateQueries({ queryKey: ['bepusdt-payment'] })
  expect(onPaid).toHaveBeenCalledTimes(1)
})

test('a late quote from another gateway cannot replace the selected BEpusdt quote', async () => {
  type QuoteResponse = { data: { message: string; data: string } }
  let resolveEpay: (response: QuoteResponse) => void = () => undefined
  let resolveBepusdt: (response: QuoteResponse) => void = () => undefined
  const epay = new Promise<QuoteResponse>((resolve) => {
    resolveEpay = resolve
  })
  const bepusdt = new Promise<QuoteResponse>((resolve) => {
    resolveBepusdt = resolve
  })
  vi.spyOn(api, 'post').mockImplementation((url) =>
    url === '/api/user/bepusdt/amount' ? bepusdt : epay
  )
  const { result } = renderHook(() => usePayment())
  let first: Promise<number>, second: Promise<number>
  act(() => {
    first = result.current.calculatePaymentAmount(1, 'alipay')
    second = result.current.calculatePaymentAmount(1, 'bepusdt')
  })
  await act(async () => {
    resolveBepusdt({ data: { message: 'success', data: '1.00' } })
    await second
  })
  expect(result.current.amount).toBe(1)
  await act(async () => {
    resolveEpay({ data: { message: 'success', data: '7.00' } })
    await first
  })
  expect(result.current.amount).toBe(1)
  expect(result.current.calculating).toBe(false)
})
