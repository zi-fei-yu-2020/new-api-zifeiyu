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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { SettingsPageProvider } from '../components/settings-page-context'
import { GameSettingsSection } from '../site/game-settings-section'

const settings = {
  enabled: true,
  rewards_enabled: true,
  reward_version: 2,
  daily_quota: 0,
  first_token_quota: 2500000,
  subsequent_token_quota: 250000,
  daily_budget: 0,
  weekly_budget: 50000,
  pvp_enabled: true,
  pvp_min_stake: 500000,
  pvp_max_stake: 50000000,
}
let client: QueryClient
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: settings },
  })
  vi.spyOn(api, 'put').mockImplementation(async (_url, payload) => ({
    data: { success: true, data: payload },
  }))
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
})
function Workspace() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <QueryClientProvider client={client}>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <GameSettingsSection />
      </SettingsPageProvider>
    </QueryClientProvider>
  )
}
it('saves only game configuration and retains reward amounts when toggling the game', async () => {
  render(<Workspace />)
  const enabled = await screen.findByRole('switch', { name: 'Game Center' })
  expect(
    screen.queryByRole('switch', { name: 'Image Studio' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('switch', { name: 'Translation Studio' })
  ).not.toBeInTheDocument()
  expect(screen.getAllByRole('switch')).toHaveLength(5)
  expect(screen.getAllByRole('spinbutton')).toHaveLength(11)
  await userEvent.click(enabled)
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(api.put).toHaveBeenCalledOnce())
  expect(api.put).toHaveBeenCalledWith('/api/user/game/settings', {
    ...settings,
    weekly_reward_version: 2,
    weekly_first_quota: 15000,
    weekly_second_quota: 10000,
    weekly_third_quota: 7500,
    weekly_budget: 32500,
    enabled: false,
    match3_enabled: true,
    match3_rewards_enabled: false,
    match3_weekly_first_quota: 0,
    match3_weekly_second_quota: 0,
    match3_weekly_third_quota: 0,
  })
})
it('saves the PvP duel switch and stake bounds', async () => {
  render(<Workspace />)
  const pvpSwitch = await screen.findByRole('switch', {
    name: 'Enable PvP duels',
  })
  const min = screen.getByRole('spinbutton', {
    name: /Minimum duel stake/,
  })
  const max = screen.getByRole('spinbutton', {
    name: /Maximum duel stake/,
  })
  await userEvent.clear(min)
  await userEvent.type(min, '2')
  await userEvent.clear(max)
  await userEvent.type(max, '500')
  await userEvent.click(pvpSwitch)
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(api.put).toHaveBeenCalledOnce())
  expect(api.put).toHaveBeenCalledWith(
    '/api/user/game/settings',
    expect.objectContaining({
      pvp_enabled: false,
      pvp_min_stake: 1000000,
      pvp_max_stake: 250000000,
    })
  )
})
it('saves the Tile Match switches and podium amounts and refreshes its queries', async () => {
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  render(<Workspace />)
  const enabled = await screen.findByRole('switch', {
    name: 'Enable Tile Match',
  })
  const rewards = screen.getByRole('switch', {
    name: 'Enable Tile Match weekly rewards',
  })
  for (const [label, amount] of [
    ['Tile Match first-place reward', '9'],
    ['Tile Match second-place reward', '6'],
    ['Tile Match third-place reward', '3'],
  ]) {
    const input = screen.getByRole('spinbutton', { name: new RegExp(label) })
    await userEvent.clear(input)
    await userEvent.type(input, amount)
  }
  await userEvent.click(enabled)
  await userEvent.click(rewards)
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(api.put).toHaveBeenCalledOnce())
  expect(api.put).toHaveBeenCalledWith(
    '/api/user/game/settings',
    expect.objectContaining({
      match3_enabled: false,
      match3_rewards_enabled: true,
      match3_weekly_first_quota: 4500000,
      match3_weekly_second_quota: 3000000,
      match3_weekly_third_quota: 1500000,
    })
  )
  await waitFor(() => {
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['match3-status'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['match3-rankings'] })
  })
})
it('rejects a maximum duel stake below the minimum instead of saving it', async () => {
  render(<Workspace />)
  const max = await screen.findByRole('spinbutton', {
    name: /Maximum duel stake/,
  })
  await userEvent.clear(max)
  await userEvent.type(max, '0.5')
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Invalid game reward settings'
  )
  expect(api.put).not.toHaveBeenCalled()
})
it('rejects a capped daily budget below one run maximum reward and accepts zero', async () => {
  render(<Workspace />)
  const budget = await screen.findByRole('spinbutton', {
    name: /Total daily reward budget/,
  })
  await userEvent.clear(budget)
  await userEvent.type(budget, '1')
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  expect(
    await screen.findByText(
      'A capped daily budget must cover at least the maximum reward for one run'
    )
  ).toBeVisible()
  expect(api.put).not.toHaveBeenCalled()

  await userEvent.clear(budget)
  await userEvent.type(budget, '0')
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
})
it('does not turn an empty reward amount into an unintended zero-value reward', async () => {
  render(<Workspace />)
  const first = await screen.findByRole('spinbutton', {
    name: /First collected token/,
  })
  await userEvent.clear(first)
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Invalid game reward settings'
  )
  expect(api.put).not.toHaveBeenCalled()
})

it('saves independent weekly podium amounts and calculates their total', async () => {
  render(<Workspace />)
  for (const [label, amount] of [
    ['Weekly first-place reward', '30'],
    ['Weekly second-place reward', '20'],
    ['Weekly third-place reward', '10'],
  ]) {
    const input = await screen.findByRole('spinbutton', {
      name: new RegExp(label),
    })
    await userEvent.clear(input)
    await userEvent.type(input, amount)
  }
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(api.put).toHaveBeenCalledOnce())
  expect(api.put).toHaveBeenCalledWith(
    '/api/user/game/settings',
    expect.objectContaining({
      weekly_reward_version: 2,
      weekly_first_quota: 15000000,
      weekly_second_quota: 10000000,
      weekly_third_quota: 5000000,
      weekly_budget: 30000000,
    })
  )
})
it('rejects an empty weekly prize instead of silently making it zero', async () => {
  render(<Workspace />)
  const input = await screen.findByRole('spinbutton', {
    name: /Weekly third-place reward/,
  })
  await userEvent.clear(input)
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Invalid game reward settings'
  )
  expect(api.put).not.toHaveBeenCalled()
})
