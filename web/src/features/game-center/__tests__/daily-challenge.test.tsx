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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { createAppQueryClient } from '@/lib/query-client'
import { createServerError } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import {
  getRankings,
  getGameRewards,
  getGameStatus,
  startGame,
  type GameRun,
  type GameStatus,
} from '../api'
import { DailyChallenge } from '../daily-challenge'
import { newGame } from '../engine'

vi.mock('../api', () => ({
  getRankings: vi.fn(),
  getGameRewards: vi.fn(),
  getGameStatus: vi.fn(),
  startGame: vi.fn(),
}))
vi.mock('../use-game-session', () => ({
  useGameSession: () => ({
    run: sessionRun,
    display: sessionRun?.state ?? previewState,
    state: { current: sessionRun?.state ?? previewState },
    input: { current: sessionInput },
    connection: 'online',
    install: installMock,
    quit: vi.fn(),
  }),
}))
vi.mock('../weekly-rewards', () => ({ WeeklyRewards: () => null }))
vi.mock('../upgrade-panel', () => ({ UpgradePanel: () => null }))

const budgetMessage = 'The daily reward budget cannot cover another run'
const closedMessage = 'The daily challenge is currently closed'
const previewState = newGame(42)
const installMock = vi.fn()
let sessionRun: GameRun | null
let sessionInput: { direction: number; dash: boolean; upgrade: number }
let client: ReturnType<typeof createAppQueryClient>

function createStatus(run: GameRun | null): GameStatus {
  return {
    run,
    day: '2026-10-29',
    week: '2026-10-26',
    server_time: Date.now(),
    resets_at: Date.now() + 3600000,
    settings: {
      enabled: true,
      rewards_enabled: true,
      reward_version: 3,
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
}

function finishedRun(): GameRun {
  return {
    id: 'finished-run',
    day: '2026-10-29',
    week: '2026-10-26',
    started_at: Date.now() - 90000,
    finished_at: Date.now(),
    server_time: Date.now(),
    status: 'defeated',
    score: 100,
    quota_awarded: 0,
    reward_version: 3,
    first_token_quota: 2500000,
    subsequent_token_quota: 250000,
    state: { ...newGame(42), hp: 0 },
  }
}

function show(): void {
  render(
    <QueryClientProvider client={client}>
      <DailyChallenge />
    </QueryClientProvider>
  )
}

beforeEach(async () => {
  client = createAppQueryClient()
  sessionRun = finishedRun()
  sessionInput = { direction: 0, dash: false, upgrade: 0 }
  useAuthStore.getState().auth.reset()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.mocked(getGameStatus).mockImplementation(async () =>
    createStatus(sessionRun)
  )
  vi.mocked(getGameRewards).mockImplementation(async () => ({
    budgets: createStatus(sessionRun).budgets,
    week: '2026-10-26',
    enabled: true,
    rewards_enabled: true,
    server_time: Date.now(),
  }))
  vi.mocked(getRankings).mockResolvedValue([])
  i18next.addResourceBundle(
    'zh',
    'translation',
    {
      [budgetMessage]: '今日奖励预算不足',
      [closedMessage]: '每日挑战暂未开放',
    },
    true,
    true
  )
  await i18next.changeLanguage('zh')
})

afterEach(async () => {
  client.clear()
  useAuthStore.getState().auth.reset()
  await i18next.changeLanguage('en')
})

it('leaves keyboard defaults and focus alone after the daily run has finished', async () => {
  show()
  await screen.findByText('Well played')
  const canvas = screen.getByLabelText(/Game arena/)
  expect(canvas).not.toHaveFocus()

  const allowed = fireEvent.keyDown(document.body, {
    key: 'ArrowRight',
    cancelable: true,
  })

  expect(allowed).toBe(true)
  expect(sessionInput.direction).toBe(0)
})

it('keeps status and ranking failures inline without automatic error toasts', async () => {
  const notify = vi.spyOn(toast, 'error').mockReturnValue('error')
  vi.mocked(getGameStatus).mockRejectedValue(new Error('Status offline'))
  vi.mocked(getRankings).mockRejectedValue(new Error('Rankings offline'))

  show()

  expect(
    await screen.findByText('Unable to load the daily challenge')
  ).toBeVisible()
  expect(await screen.findByText('Unable to load rankings')).toBeVisible()
  expect(notify).not.toHaveBeenCalled()
})

it.each([
  [budgetMessage, '今日奖励预算不足'],
  [closedMessage, '每日挑战暂未开放'],
])(
  'classifies %s from the server envelope after translation',
  async (messageKey, translatedMessage) => {
    sessionRun = null
    const notify = vi.spyOn(toast, 'error').mockReturnValue('error')
    vi.mocked(startGame).mockRejectedValue(
      createServerError({
        success: false,
        message: messageKey,
        message_key: messageKey,
      })
    )
    const user = userEvent.setup()
    show()

    const startButton = await screen.findByRole('button', {
      name: 'Start today’s challenge',
    })
    await waitFor(() => expect(startButton).toBeEnabled())
    await user.click(startButton)
    await user.click(
      await screen.findByRole('button', { name: 'Start challenge' })
    )

    await waitFor(() => expect(notify).toHaveBeenCalledWith(translatedMessage))
    expect(notify).toHaveBeenCalledTimes(1)
  }
)

it('records a newly started run in the status cache so a quick remount keeps it', async () => {
  sessionRun = null
  const started: GameRun = {
    ...finishedRun(),
    id: 'started-run',
    status: 'running',
  }
  vi.mocked(startGame).mockResolvedValue(started)
  const user = userEvent.setup()
  show()

  const startButton = await screen.findByRole('button', {
    name: 'Start today’s challenge',
  })
  await waitFor(() => expect(startButton).toBeEnabled())
  await user.click(startButton)
  await user.click(
    await screen.findByRole('button', { name: 'Start challenge' })
  )

  await waitFor(() =>
    expect(client.getQueryData<GameStatus>(['game-status'])?.run?.id).toBe(
      'started-run'
    )
  )
})

it('refetches the status once after the reset boundary instead of on every tick', async () => {
  const resetsAt = Date.now() - 1000
  vi.mocked(getGameStatus).mockImplementation(async () => ({
    ...createStatus(sessionRun),
    resets_at: resetsAt,
  }))
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    show()
    await waitFor(() =>
      expect(vi.mocked(getGameStatus).mock.calls.length).toBeGreaterThan(1)
    )
    const afterReset = vi.mocked(getGameStatus).mock.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(vi.mocked(getGameStatus).mock.calls.length).toBe(afterReset)
  } finally {
    vi.useRealTimers()
  }
})
