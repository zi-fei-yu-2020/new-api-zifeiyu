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
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { formatQuota } from '@/lib/format'

import * as pvpApi from '../api'
import type { PvPMatchSummary, PvPMatchView } from '../api'
import { newDuel } from '../duel-engine'
import { PvpLobby } from '../lobby'

let client: QueryClient
let currentMatch: PvPMatchView | null
let getStatus: ReturnType<typeof vi.spyOn>

function finishedMatch(id: string, opponentName: string): PvPMatchView {
  const now = Date.now()
  return {
    id,
    mode: 'ranked',
    status: 'finished',
    stake: 500000,
    seed: 7,
    you: { slot: 1, cursor: 1200, seq: 20, score: 100, hp: 80 },
    opponent: {
      id: 2,
      name: opponentName,
      display_name: opponentName,
      cursor: 1200,
      score: 80,
      hp: 0,
    },
    state: newDuel(7),
    winner_slot: 1,
    you_delta_quota: 500000,
    invite_code: null,
    created_at: now - 120000,
    started_at: now - 120000,
    finished_at: now,
    server_time: now,
  }
}

function invitedMatch(): PvPMatchView {
  const now = Date.now()
  return {
    id: 'invite-1',
    mode: 'friendly',
    status: 'invited',
    stake: 500000,
    seed: 7,
    you: {
      slot: 1,
      secret: 'invite-secret',
      cursor: 0,
      seq: 0,
      score: 0,
      hp: 100,
    },
    opponent: {
      id: 0,
      name: '',
      display_name: '',
      cursor: 0,
      score: 0,
      hp: 100,
    },
    state: null,
    winner_slot: 0,
    you_delta_quota: null,
    invite_code: 'abcd1234',
    created_at: now,
    started_at: 0,
    finished_at: 0,
    server_time: now,
  }
}

function historyItem(
  id: string,
  opponentName: string,
  myScore = 10,
  opponentScore = 8
): PvPMatchSummary {
  return {
    id,
    mode: 'ranked',
    status: 'finished',
    stake: 500000,
    opponent_name: opponentName,
    my_score: myScore,
    opponent_score: opponentScore,
    result: 'win',
    delta_quota: 500000,
    created_at: Date.now() - 120000,
    finished_at: Date.now(),
  }
}

function Wrapper(props: { children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
  )
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  currentMatch = finishedMatch('duel-1', 'First rival')
  getStatus = vi.spyOn(pvpApi, 'getPvPStatus').mockImplementation(async () => ({
    enabled: true,
    min_stake: 500000,
    max_stake: 5000000,
    queue: null,
    match: currentMatch,
    server_time: Date.now(),
  }))
  vi.spyOn(pvpApi, 'listPvPMatches').mockResolvedValue({ items: [], total: 0 })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(async () => {
  await i18next.changeLanguage('en')
  client.clear()
  vi.restoreAllMocks()
})

it('keeps dismissed results out of the lobby while allowing a new result to install', async () => {
  const user = userEvent.setup()
  render(<PvpLobby />, { wrapper: Wrapper })

  // Wait for the duel session to install, otherwise the transient
  // ResultBanner button is captured and unmounted before the click lands.
  const stage = await screen.findByRole('region', { name: 'PvP duel' })
  const back = within(stage).getByRole('button', { name: 'Back to lobby' })
  await user.click(back)
  await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2))

  expect(
    await screen.findByRole('region', { name: 'Ranked matchmaking' })
  ).toBeVisible()
  expect(screen.getByRole('region', { name: 'Friendly duel' })).toBeVisible()
  expect(
    screen.queryByRole('region', { name: 'PvP duel' })
  ).not.toBeInTheDocument()

  currentMatch = finishedMatch('duel-2', 'Second rival')
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['pvp-status'] })
  })

  expect(await screen.findByText('Second rival')).toBeVisible()
  expect(screen.getByRole('region', { name: 'PvP duel' })).toBeVisible()
  expect(
    screen.queryByRole('region', { name: 'Ranked matchmaking' })
  ).not.toBeInTheDocument()
})

it('clears an expired friendly invite and shows the expiry notice once', async () => {
  currentMatch = invitedMatch()
  const notify = vi.spyOn(toast, 'error')
  render(<PvpLobby />, { wrapper: Wrapper })

  expect(
    await screen.findByRole('region', { name: 'Friendly duel invite' })
  ).toBeVisible()
  currentMatch = null
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['pvp-status'] })
  })

  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith('PvP invite code has expired')
  )
  expect(
    screen.queryByRole('region', { name: 'Friendly duel invite' })
  ).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Friendly duel' })).toBeVisible()

  await act(async () => {
    await client.invalidateQueries({ queryKey: ['pvp-status'] })
  })
  expect(notify).toHaveBeenCalledTimes(1)
})

it('does not reinstall a stale playing view over the same finished match', async () => {
  const submit = vi.spyOn(pvpApi, 'submitPvPInput')
  render(<PvpLobby />, { wrapper: Wrapper })
  const stage = await screen.findByRole('region', { name: 'PvP duel' })
  expect(within(stage).getByText('Duel finished')).toBeVisible()

  currentMatch = {
    ...finishedMatch('duel-1', 'First rival'),
    status: 'playing',
    winner_slot: 0,
    you_delta_quota: null,
  }
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['pvp-status'] })
  })

  expect(within(stage).getByText('Duel finished')).toBeVisible()
  expect(
    within(stage).getByRole('button', { name: 'Back to lobby' })
  ).toBeVisible()
  expect(
    within(stage).queryByRole('button', { name: 'Resign' })
  ).not.toBeInTheDocument()
  expect(submit).not.toHaveBeenCalled()
})

it('keeps the current history page visible while the next page loads', async () => {
  let resolvePageTwo!: (value: {
    items: PvPMatchSummary[]
    total: number
  }) => void
  vi.spyOn(pvpApi, 'listPvPMatches').mockImplementation((page) => {
    if (page === 1) {
      return Promise.resolve({
        items: [historyItem('history-1', 'First page rival')],
        total: 20,
      })
    }
    return new Promise((resolve) => {
      resolvePageTwo = resolve
    })
  })
  const user = userEvent.setup()
  render(<PvpLobby />, { wrapper: Wrapper })
  const history = await screen.findByRole('region', {
    name: 'PvP match history',
  })
  expect(await within(history).findByText(/First page rival/)).toBeVisible()

  await user.click(within(history).getByRole('button', { name: 'Next' }))

  expect(within(history).getByText(/First page rival/)).toBeVisible()
  expect(within(history).queryByText(/No duels yet/)).not.toBeInTheDocument()
  await act(async () => {
    resolvePageTwo({
      items: [historyItem('history-2', 'Second page rival')],
      total: 20,
    })
  })
  expect(await within(history).findByText(/Second page rival/)).toBeVisible()
})

it('shows a loading state instead of the empty message during the first history load', async () => {
  let resolveFirst!: (value: {
    items: PvPMatchSummary[]
    total: number
  }) => void
  vi.spyOn(pvpApi, 'listPvPMatches').mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve
      })
  )
  render(<PvpLobby />, { wrapper: Wrapper })
  const history = await screen.findByRole('region', {
    name: 'PvP match history',
  })

  expect(within(history).getByText('Loading...')).toBeVisible()
  expect(within(history).queryByText(/No duels yet/)).not.toBeInTheDocument()
  await act(async () => {
    resolveFirst({
      items: [historyItem('history-1', 'Loaded rival')],
      total: 1,
    })
  })
  expect(await within(history).findByText(/Loaded rival/)).toBeVisible()
})

it('formats history scores and counts with the active interface locale', async () => {
  vi.spyOn(pvpApi, 'listPvPMatches').mockResolvedValue({
    items: [historyItem('history-1', 'Locale rival', 1234, 5678)],
    total: 1234,
  })
  await act(() => i18next.changeLanguage('zhCN'))
  render(<PvpLobby />, { wrapper: Wrapper })
  const history = await screen.findByRole('region', {
    name: 'PvP match history',
  })
  expect(await within(history).findByText(/1,234 : 5,678/)).toBeVisible()
  expect(within(history).getByText('1,234 duels')).toBeVisible()

  await act(() => i18next.changeLanguage('fr'))
  const french = new Intl.NumberFormat('fr')
  const expectedScore = `${french.format(1234)} : ${french.format(5678)} · ${formatQuota(500000)}`
  expect(
    within(history).getByText(
      (_content, element) => element?.textContent === expectedScore
    )
  ).toBeVisible()
  const expectedTotal = `${french.format(1234)} duels`
  expect(
    within(history).getByText(
      (_content, element) => element?.textContent === expectedTotal
    )
  ).toBeVisible()
})
