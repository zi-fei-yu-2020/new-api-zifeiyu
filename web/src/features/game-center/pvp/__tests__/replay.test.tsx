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
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, expect, it, vi } from 'vitest'

import { createAppQueryClient } from '@/lib/query-client'

import * as pvpApi from '../api'
import { DuelReplay } from '../replay'

afterEach(() => {
  vi.restoreAllMocks()
})

it('shows replay failures inline without emitting a global error toast', async () => {
  vi.spyOn(pvpApi, 'getPvPReplay').mockRejectedValue(new Error('Offline'))
  const notify = vi.spyOn(toast, 'error')
  const client = createAppQueryClient()
  render(
    <QueryClientProvider client={client}>
      <DuelReplay matchId='duel-1' onClose={vi.fn()} />
    </QueryClientProvider>
  )

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Unable to load the PvP replay'
  )
  expect(screen.getByRole('button', { name: 'Back' })).toBeVisible()
  expect(notify).not.toHaveBeenCalled()
  client.clear()
})
