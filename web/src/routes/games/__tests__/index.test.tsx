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
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { GameStatus } from '@/features/game-center/api'
import { newGame } from '@/features/game-center/engine'
import { gameStatusQueryOptions } from '@/features/game-center/query-options'
import { api } from '@/lib/api'
import { isWorkbenchEnabledForGuard } from '@/lib/nav-modules'
import { useAuthStore } from '@/stores/auth-store'

import { Route } from '../index'

vi.mock('@/features/game-center', () => ({ GameCenter: () => null }))
vi.mock('@/lib/auth-session', () => ({ resolveAuthentication: vi.fn() }))
vi.mock('@/lib/nav-modules', () => ({ isWorkbenchEnabledForGuard: vi.fn() }))

type GamesBeforeLoad = (args: {
  context: { queryClient: QueryClient }
  location: { href: string }
}) => Promise<unknown>

let client: QueryClient

function loadGames(): Promise<unknown> {
  return (Route.options.beforeLoad as GamesBeforeLoad)({
    context: { queryClient: client },
    location: { href: '/games' },
  })
}

function runningStatus(): GameStatus {
  return {
    run: {
      id: 'running-run',
      day: '2026-10-29',
      week: '2026-10-26',
      started_at: Date.now(),
      finished_at: 0,
      server_time: Date.now(),
      status: 'running',
      score: 0,
      quota_awarded: 0,
      reward_version: 3,
      first_token_quota: 2500000,
      subsequent_token_quota: 250000,
      state: newGame(42),
    },
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
      can_start: false,
    },
  }
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  useAuthStore.setState((state) => ({
    auth: {
      ...state.auth,
      user: { id: 1, username: 'player', role: 1 },
      accessToken: 'access-token',
    },
  }))
  vi.mocked(isWorkbenchEnabledForGuard).mockResolvedValue(false)
})

afterEach(() => {
  cleanup()
  client.clear()
  useAuthStore.getState().auth.reset()
})

it('shares the signal-aware guard fetch with the page without a mount refetch', async () => {
  const status = runningStatus()
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: status },
  } as never)

  await loadGames()
  const { result } = renderHook(() => useQuery(gameStatusQueryOptions), {
    wrapper: (props: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        {props.children}
      </QueryClientProvider>
    ),
  })

  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data).toEqual(status)
  expect(get).toHaveBeenCalledTimes(1)
  expect(get.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
})

it('falls through to the page error state when the guard status fetch fails', async () => {
  vi.spyOn(api, 'get').mockRejectedValue(new Error('Status offline'))

  await expect(loadGames()).resolves.toBeUndefined()

  expect(client.getQueryState(['game-status'])?.status).toBe('error')
})

it('redirects to sign-in when the user is not authenticated', async () => {
  useAuthStore.getState().auth.reset()

  await expect(loadGames()).rejects.toMatchObject({
    options: { to: '/sign-in' },
  })
})

it.each([
  ['has no run today', 'none'],
  ['has a finished run', 'defeated'],
])(
  'redirects to the dashboard when the workbench is off and the user %s',
  async (_name, kind) => {
    const status = runningStatus()
    const run =
      kind === 'none' || !status.run
        ? null
        : { ...status.run, status: 'defeated' as const }
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: { ...status, run } },
    } as never)

    await expect(loadGames()).rejects.toMatchObject({
      options: { to: '/dashboard' },
    })
  }
)

it('keeps a running game reachable when the workbench is off', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: runningStatus() },
  } as never)

  await expect(loadGames()).resolves.toBeUndefined()
})

it.each(['playing', 'invited'])(
  'keeps the page reachable for a %s PvP duel when the workbench is off',
  async (status) => {
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (String(url).includes('/pvp/status')) {
        return {
          data: {
            success: true,
            data: { enabled: true, queue: null, match: { id: 'm', status } },
          },
        }
      }
      return {
        data: { success: true, data: { ...runningStatus(), run: null } },
      }
    })

    await expect(loadGames()).resolves.toBeUndefined()
  }
)

it('still redirects when the PvP status holds only a finished duel', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (String(url).includes('/pvp/status')) {
      return {
        data: {
          success: true,
          data: {
            enabled: true,
            queue: null,
            match: { id: 'm', status: 'finished' },
          },
        },
      }
    }
    return { data: { success: true, data: { ...runningStatus(), run: null } } }
  })

  await expect(loadGames()).rejects.toMatchObject({
    options: { to: '/dashboard' },
  })
})

it('skips the status fetch when the workbench is enabled', async () => {
  vi.mocked(isWorkbenchEnabledForGuard).mockResolvedValue(true)
  const get = vi.spyOn(api, 'get')

  await expect(loadGames()).resolves.toBeUndefined()

  expect(get).not.toHaveBeenCalled()
})
