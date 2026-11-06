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
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { getRankings, type Rank } from '../api'
import { Leaderboard } from '../leaderboard'

vi.mock('../api', () => ({ getRankings: vi.fn() }))

const row: Rank = {
  name: 'Ada',
  score: 900,
  runs: 1,
  rank: 1,
  is_me: true,
  level: 7,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function show(props: Partial<Parameters<typeof Leaderboard>[0]>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Leaderboard weeklyPrizes={[]} {...props} />
    </QueryClientProvider>
  )
}

it('loads the supplied board with its hints and shows the row level', async () => {
  const fetchRankings = vi.fn().mockResolvedValue([row])
  show({
    queryKey: 'match3-rankings',
    fetchRankings,
    dayHint: 'Day hint',
    weekHint: 'Week hint',
  })

  expect(await screen.findByText('Ada')).toBeVisible()
  expect(screen.getByText('Level 7')).toBeVisible()
  expect(screen.getByText('Day hint')).toBeVisible()
  expect(fetchRankings).toHaveBeenCalledWith('day')
  expect(getRankings).not.toHaveBeenCalled()

  await userEvent.click(screen.getByRole('tab', { name: 'This week' }))
  expect(await screen.findByText('Week hint')).toBeVisible()
  expect(fetchRankings).toHaveBeenCalledWith('week')
})

it('keeps the token game board and wording by default', async () => {
  vi.mocked(getRankings).mockResolvedValue([{ ...row, level: undefined }])
  show({})

  expect(await screen.findByText('Ada')).toBeVisible()
  expect(screen.queryByText(/^Level/)).not.toBeInTheDocument()
  expect(screen.getByText('One attempt. Highest score wins.')).toBeVisible()
  expect(getRankings).toHaveBeenCalledWith('day')
})

it('numbers daily tile levels from one and leaves the weekly level as is', async () => {
  const fetchRankings = vi.fn().mockResolvedValue([row])
  show({ fetchRankings, dayLevelOffset: 4 })

  expect(await screen.findByText('Level 3')).toBeVisible()

  await userEvent.click(screen.getByRole('tab', { name: 'This week' }))
  expect(await screen.findByText('Level 7')).toBeVisible()
})
