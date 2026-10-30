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
  cleanup,
  render,
  screen,
  within,
  act,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { getSelf } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { GameCenter } from '.'
import {
  getGameStatus,
  getGameRewards,
  type GameRun,
  type GameStatus,
} from './api'
import { newGame } from './engine'
import { getMatchStatus, type MatchRun, type MatchStatus } from './match3/api'

vi.mock('@/lib/api', () => ({ getSelf: vi.fn() }))
vi.mock('@/components/layout/components/public-layout', () => ({
  PublicLayout: (props: { children: ReactNode }) => props.children,
}))
vi.mock('./arena', () => ({ Arena: () => <div /> }))
vi.mock('./leaderboard', () => ({ Leaderboard: () => <div /> }))
vi.mock('./match3/match3-panel', () => ({ Match3Panel: () => <div /> }))
vi.mock('./match3/api', () => ({ getMatchStatus: vi.fn() }))
vi.mock('./api', () => ({
  getGameStatus: vi.fn(),
  getGameRewards: vi.fn(),
  startGame: vi.fn(),
}))
vi.mock('./use-game-session', () => ({
  useGameSession: () => ({
    run,
    display: run.state,
    state: { current: run.state },
    input: { current: { direction: 0, dash: false, upgrade: 0 } },
    connection: 'connected',
    install,
    quit: vi.fn(),
  }),
}))
let client: QueryClient
let run: GameRun
let status: GameStatus
const install = vi.fn()
beforeEach(() => {
  useAuthStore.getState().auth.setUser(null)
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  run = {
    id: 'existing-run',
    day: '2026-10-18',
    week: '2026-10-12',
    status: 'defeated',
    started_at: Date.now() - 180000,
    finished_at: Date.now(),
    server_time: Date.now(),
    score: 5677,
    quota_awarded: 0,
    reward_version: 2,
    first_token_quota: 0,
    subsequent_token_quota: 0,
    state: { ...newGame(42), hp: 0, picked_tokens: 101, score: 5677 },
  }
  status = {
    run,
    day: run.day,
    week: run.week,
    server_time: Date.now(),
    resets_at: Date.now() + 3600000,
    settings: {
      enabled: true,
      rewards_enabled: true,
      reward_version: 2,
      daily_quota: 0,
      daily_budget: 0,
      weekly_budget: 0,
      first_token_quota: 2500000,
      subsequent_token_quota: 250000,
    },
    budgets: {
      daily_quota: 0,
      daily_remaining: 0,
      weekly_pool: 0,
      first_token_quota: 2500000,
      subsequent_token_quota: 250000,
      daily_reserved: 0,
      unlimited: true,
      max_run_reward: 49000000,
      can_start: true,
    },
  }
  vi.mocked(getGameStatus).mockImplementation(async () => status)
  vi.mocked(getMatchStatus).mockResolvedValue({
    daily_run: null,
    endless_run: null,
  } as unknown as MatchStatus)
  vi.mocked(getGameRewards).mockImplementation(async () => ({
    budgets: status.budgets,
    week: status.week,
    enabled: status.settings.enabled,
    rewards_enabled: status.settings.rewards_enabled,
    server_time: Date.now(),
  }))
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.clearAllMocks()
})
function show() {
  render(
    <QueryClientProvider client={client}>
      <GameCenter />
    </QueryClientProvider>
  )
}
it('shows newly enabled rewards without changing an already completed zero-reward result', async () => {
  show()
  const note = await screen.findByText(/This run keeps its starting rules:/)
  expect(note).toHaveTextContent(/first token, then \$0/)
  const card = screen.getByText('Pickup rewards').closest('section')
  expect(card).not.toBeNull()
  expect(within(card as HTMLElement).getByText('$5')).toBeVisible()
  expect(within(card as HTMLElement).getByText('$0.5')).toBeVisible()
  expect(screen.getByText(/Quota awarded:/)).toHaveTextContent('$0')
  expect(
    screen.getByText(
      /Only first, second and third place receive weekly rewards/
    )
  ).toBeVisible()
  expect(screen.queryByText(/ranks 4/)).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Start today’s challenge' })
  ).not.toBeInTheDocument()
})
it('keeps the live estimate at zero for a run started before rewards were enabled', async () => {
  run.status = 'running'
  run.state.hp = 100
  show()
  await screen.findByText(/This run keeps its starting rules:/)
  expect(screen.getByText(/101 tokens/)).toHaveTextContent('Reward $0')
})
it('retains an active paid run estimate when new-run rewards have been disabled', async () => {
  run.status = 'running'
  run.state.hp = 100
  run.state.picked_tokens = 3
  run.first_token_quota = 2500000
  run.subsequent_token_quota = 250000
  status.settings.rewards_enabled = false
  status.budgets.first_token_quota = 0
  status.budgets.subsequent_token_quota = 0
  show()
  await screen.findByText(/This run keeps its starting rules:/)
  expect(screen.getByText(/3 tokens/)).toHaveTextContent('Reward $6')
})

it('updates weekly amounts without reinstalling or rewinding the active game', async () => {
  run.status = 'running'
  run.state.hp = 100
  show()
  await screen.findByText(/This run keeps its starting rules:/)
  await waitFor(() => expect(install).toHaveBeenCalledTimes(1))
  vi.mocked(getGameRewards).mockResolvedValue({
    budgets: {
      ...status.budgets,
      weekly_reward_version: 2,
      weekly_first_quota: 15000000,
      weekly_second_quota: 10000000,
      weekly_third_quota: 5000000,
      weekly_pool: 30000000,
    },
    week: status.week,
    enabled: true,
    rewards_enabled: true,
    server_time: Date.now(),
  })
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['game-rewards'] })
  })
  const prizes = screen.getByRole('region', { name: 'Weekly podium rewards' })
  expect(await within(prizes).findByText('$30')).toBeVisible()
  expect(within(prizes).getByText('$20')).toBeVisible()
  expect(within(prizes).getByText('$10')).toBeVisible()
  expect(install).toHaveBeenCalledTimes(1)
  expect(screen.getByText(/101 tokens/)).toHaveTextContent('Reward $0')
})

it('refreshes the account balance after settlement without reloading the page', async () => {
  useAuthStore.getState().auth.setUser({
    id: 17,
    username: 'player',
    role: 1,
    group: 'default',
    quota: 500000,
  })
  vi.mocked(getSelf).mockResolvedValue({
    success: true,
    data: {
      id: 17,
      username: 'player',
      role: 1,
      group: 'default',
      quota: 3500000,
    },
  })
  show()
  await waitFor(() =>
    expect(useAuthStore.getState().auth.user?.quota).toBe(3500000)
  )
  expect(getSelf).toHaveBeenCalledTimes(1)
})
it('does not replace a different signed-in account with a delayed balance response', async () => {
  useAuthStore.getState().auth.setUser({
    id: 17,
    username: 'player',
    role: 1,
    group: 'default',
    quota: 500000,
  })
  let finish!: (value: unknown) => void
  vi.mocked(getSelf).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  show()
  await waitFor(() => expect(getSelf).toHaveBeenCalledTimes(1))
  await act(async () => {
    useAuthStore.getState().auth.setUser(null)
    finish({
      success: true,
      data: {
        id: 17,
        username: 'player',
        role: 1,
        group: 'default',
        quota: 3500000,
      },
    })
  })
  expect(useAuthStore.getState().auth.user).toBeNull()
})
it('places the rules inside the game section before the rewards and rankings', async () => {
  show()
  const rules = await screen.findByRole('region', { name: 'How to play' })
  const arena = screen.getByRole('region', { name: 'Daily challenge' })
  expect(arena).toContainElement(rules)
  expect(
    rules.compareDocumentPosition(screen.getByText('Pickup rewards')) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
})
it('shows the upgrade choice in the arena with the paused-combat explanation', async () => {
  run.status = 'running'
  run.state.hp = 100
  run.state.tick = 200
  run.state.clock_tick = 200
  show()
  const panel = await screen.findByRole('dialog', {
    name: 'Choose your upgrade',
  })
  expect(within(panel).getByText('Combat paused')).toBeVisible()
  expect(within(panel).getAllByRole('button')).toHaveLength(3)
  expect(screen.getByText('1:10')).toBeVisible()
})

it('opens the daily tab when a survivor run and a tile run are both running', async () => {
  run.status = 'running'
  vi.mocked(getMatchStatus).mockResolvedValue({
    daily_run: { id: 'tile-run', status: 'running' } as MatchRun,
    endless_run: null,
  } as MatchStatus)
  show()

  await waitFor(() => expect(getMatchStatus).toHaveBeenCalled())
  await act(async () => {})
  expect(screen.getByRole('tab', { name: 'Daily challenge' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
})

it('hides the survivor upgrade dialog while another tab is shown so its hotkeys stay free', async () => {
  run.status = 'running'
  run.state.hp = 100
  run.state.tick = 200
  run.state.clock_tick = 200
  show()
  await screen.findByRole('dialog', { name: 'Choose your upgrade' })

  await userEvent.click(screen.getByRole('tab', { name: 'Tile Match' }))

  expect(
    screen.queryByRole('dialog', { name: 'Choose your upgrade' })
  ).not.toBeInTheDocument()
})

it('opens the tile tab when only a tile run is running', async () => {
  vi.mocked(getMatchStatus).mockResolvedValue({
    daily_run: { id: 'tile-run', status: 'running' } as MatchRun,
    endless_run: null,
  } as MatchStatus)
  show()

  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Tile Match' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  )
})
