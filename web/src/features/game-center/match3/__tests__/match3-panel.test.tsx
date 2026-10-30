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
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth-store'

import type { Match3Session } from '../actions'
import { getMatchStatus, type MatchStatus } from '../api'
import { MATCH_MODE_ENDLESS, newMatch } from '../engine'
import { Match3Panel } from '../match3-panel'
import { DEFAULT_MATCH3_PREFS, useMatch3Store } from '../store'

const mocks = vi.hoisted(() => ({
  skill: vi.fn(() => true),
  setPaused: vi.fn(),
  tone: vi.fn(),
}))

vi.mock('../api', () => ({
  getMatchStatus: vi.fn(),
  getMatchRankings: vi.fn(),
  startMatch: vi.fn(),
}))
vi.mock('../../leaderboard', () => ({ Leaderboard: () => <div /> }))
vi.mock('../../weekly-rewards', () => ({ WeeklyRewards: () => <div /> }))
vi.mock('../sound', () => ({ playMatchTone: mocks.tone }))
vi.mock('../use-match3-run', () => ({
  useMatch3Run: (mode: string) => ({
    ...session(mode === 'daily' ? 12 : 3),
    run: null,
    install: vi.fn(),
  }),
}))
vi.mock('../use-match3-local', () => ({ useMatch3Local: () => session() }))

function session(cleared = 3): Match3Session {
  return {
    state: { ...newMatch(3, MATCH_MODE_ENDLESS, 7), cleared },
    active: true,
    pick: vi.fn(() => true),
    skill: mocks.skill,
    restart: vi.fn(),
    quit: vi.fn(),
    connection: 'online',
    paused: false,
    setPaused: mocks.setPaused,
    tick: () => 0,
  }
}

const status: MatchStatus = {
  settings: { enabled: true, rewards_enabled: false },
  day: '2026-10-30',
  week: '2026-10-26',
  resets_at: 0,
  server_time: 0,
  daily_run: null,
  endless_run: null,
  profile: { best_level: 0, xp: 0, rank: 0, unlocks: 7 },
  weekly_prizes: [0, 0, 0],
  weekly_total: 0,
  weekly_rewards_enabled: false,
}

function show(visible = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <Match3Panel visible={visible} />
    </QueryClientProvider>
  )
  return {
    rerender: (next: boolean) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <Match3Panel visible={next} />
        </QueryClientProvider>
      ),
  }
}

beforeEach(() => {
  vi.mocked(getMatchStatus).mockResolvedValue(status)
  useMatch3Store.setState({ byUser: {} })
  useAuthStore.getState().auth.setUser({
    id: 7,
    username: 'player',
    role: 1,
  })
})
afterEach(() => {
  vi.clearAllMocks()
  useAuthStore.getState().auth.setUser(null)
})

it('runs a skill from the 1, 2 and 3 hotkeys while the tab is visible', async () => {
  const user = userEvent.setup()
  show()
  await screen.findByRole('group', { name: 'Tile board' })

  await user.keyboard('123')

  expect(mocks.skill.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
    'reveal',
    'undo',
    'shuffle',
  ])
})

it('ignores the hotkeys when the tab is not visible', async () => {
  const user = userEvent.setup()
  show(false)
  await screen.findByRole('group', { name: 'Tile board' })

  await user.keyboard('123')

  expect(mocks.skill).not.toHaveBeenCalled()
})

it('ignores the hotkeys while a dialog is open', async () => {
  const user = userEvent.setup()
  show()
  await screen.findByRole('group', { name: 'Tile board' })
  await user.click(screen.getByRole('button', { name: 'End run' }))
  await screen.findByRole('alertdialog')

  await user.keyboard('1')

  expect(mocks.skill).not.toHaveBeenCalled()
})

it('ignores the hotkeys while typing in a field', async () => {
  const user = userEvent.setup()
  show()
  const field = document.createElement('input')
  document.body.append(field)
  field.focus()

  await user.keyboard('1')

  expect(mocks.skill).not.toHaveBeenCalled()
  field.remove()
})

it('pauses every session while the boss page is up and resumes after', async () => {
  const user = userEvent.setup()
  show()
  await screen.findByRole('group', { name: 'Tile board' })

  await user.keyboard('`')
  await screen.findByRole('dialog', { name: 'Chat completions' })
  await waitFor(() => expect(mocks.setPaused).toHaveBeenLastCalledWith(true))
  await user.keyboard('`')

  await waitFor(() => expect(mocks.setPaused).toHaveBeenLastCalledWith(false))
})

it('defaults to muted and persists the mute and low-motion switches for the user', async () => {
  const user = userEvent.setup()
  show()
  const muted = await screen.findByRole('switch', { name: 'Mute sound' })
  const motion = screen.getByRole('switch', { name: 'Reduce motion' })
  expect(muted).toBeChecked()
  expect(DEFAULT_MATCH3_PREFS.muted).toBe(true)

  await user.click(muted)
  await user.click(motion)

  const prefs = useMatch3Store.getState().byUser['7']
  expect(prefs.muted).toBe(false)
  expect(prefs.lowMotion).toBe('off')
})

it('follows an explicit low-motion override over the system preference', async () => {
  useMatch3Store.setState({
    byUser: { '7': { ...DEFAULT_MATCH3_PREFS, lowMotion: 'off' } },
  })
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <Match3Panel />
    </QueryClientProvider>
  )

  // jsdom reports prefers-reduced-motion, so 'off' must win over 'auto'.
  await screen.findByRole('group', { name: 'Tile board' })
  expect(container.querySelector('.match3')).toHaveAttribute(
    'data-low-motion',
    'false'
  )
})

it('follows the system preference when the switch is on auto', async () => {
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <Match3Panel />
    </QueryClientProvider>
  )

  await screen.findByRole('group', { name: 'Tile board' })
  expect(container.querySelector('.match3')).toHaveAttribute(
    'data-low-motion',
    'true'
  )
})

it('plays no clear tone when switching to a mode whose run has more cleared sets', async () => {
  const user = userEvent.setup()
  useMatch3Store.setState({
    byUser: { '7': { ...DEFAULT_MATCH3_PREFS, muted: false } },
  })
  show()
  await screen.findByRole('group', { name: 'Tile board' })

  await user.click(screen.getByRole('button', { name: 'Daily' }))

  expect(mocks.tone).not.toHaveBeenCalled()
})
