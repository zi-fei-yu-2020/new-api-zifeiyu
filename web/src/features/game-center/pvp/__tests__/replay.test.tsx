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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function koReplay(): pvpApi.PvPReplay {
  // Player 1 resigns one second in, so the settled duel ends at tick 10.
  return {
    seed: 7,
    stake: 1000,
    players: [
      { slot: 1, user_id: 1, name: 'Deleted account', score: 0 },
      { slot: 2, user_id: 2, name: 'Rival', score: 0 },
    ],
    winner_slot: 2,
    inputs: [
      {
        id: 1,
        player: 1,
        seq: 1,
        from_tick: 0,
        inputs: [],
        quit: true,
        received_at: 1_003_000,
      },
    ],
    started_at: 1_000_000,
    finished_at: 1_003_000,
  }
}

function renderReplay() {
  vi.spyOn(pvpApi, 'getPvPReplay').mockResolvedValue(koReplay())
  const client = createAppQueryClient()
  render(
    <QueryClientProvider client={client}>
      <DuelReplay matchId='duel-1' onClose={vi.fn()} />
    </QueryClientProvider>
  )
  return client
}

it('limits the slider to the settled end of a knocked-out duel and restarts from the final frame', async () => {
  const client = renderReplay()
  const slider = await screen.findByRole('slider', { hidden: true })
  expect(slider).toHaveAttribute('max', '10')
  expect(await screen.findByText('Deleted account (blue)')).toBeVisible()

  fireEvent.keyDown(slider, { key: 'End' })
  await waitFor(() => expect(screen.getByText(/^1\.0s \//)).toBeVisible())
  expect(slider).toHaveValue('10')

  fireEvent.click(screen.getByRole('button', { name: 'Play' }))
  expect(screen.getByText(/^0\.0s \//)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Pause' })).toBeVisible()
  client.clear()
})
