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
import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

import type { GameState } from './engine'

export type GameSettings = {
  weekly_reward_version?: number
  weekly_first_quota?: number
  weekly_second_quota?: number
  weekly_third_quota?: number
  enabled: boolean
  rewards_enabled: boolean
  daily_quota: number
  daily_budget: number
  weekly_budget: number
  reward_version: number
  first_token_quota: number
  subsequent_token_quota: number
  pvp_enabled?: boolean
  pvp_min_stake?: number
  pvp_max_stake?: number
}
export type GameRun = {
  id: string
  day: string
  week: string
  started_at: number
  finished_at: number
  status: 'running' | 'defeated' | 'survived' | 'abandoned'
  score: number
  quota_awarded: number
  reward_version: number
  first_token_quota: number
  subsequent_token_quota: number
  state: GameState
  server_time: number
}
export type GameStatus = {
  settings: GameSettings
  budgets: {
    weekly_reward_version?: number
    weekly_first_quota?: number
    weekly_second_quota?: number
    weekly_third_quota?: number
    weekly_rewards_enabled?: boolean
    daily_quota: number
    daily_remaining: number
    weekly_pool: number
    first_token_quota: number
    subsequent_token_quota: number
    daily_reserved: number
    unlimited: boolean
    max_run_reward: number
    can_start: boolean
  }
  run: GameRun | null
  day: string
  week: string
  resets_at: number
  server_time: number
}
export type GameRewards = {
  budgets: GameStatus['budgets']
  week: string
  enabled: boolean
  rewards_enabled: boolean
  server_time: number
}
export type Rank = {
  name: string
  score: number
  runs: number
  rank: number
  is_me: boolean
}
type Envelope<T> = { success: boolean; data: T; message?: string }
const path = '/api/user/game'
function unwrap<T>(response: Envelope<T>): T {
  requireServerSuccess(response)
  return response.data
}
export const getGameStatus = (signal?: AbortSignal) =>
  api.get<Envelope<GameStatus>>(path, { signal }).then((r) => unwrap(r.data))
export const getGameRewards = () =>
  api
    .get<Envelope<GameRewards>>(`${path}/rewards`, { skipErrorHandler: true })
    .then((r) => unwrap(r.data))
export const startGame = () =>
  api
    .post<Envelope<GameRun>>(`${path}/start`, undefined, {
      skipErrorHandler: true,
      skipBusinessError: true,
    })
    .then((r) => unwrap(r.data))
export const sendInputs = (
  id: string,
  from: number,
  inputs: number[],
  quit = false,
  signal?: AbortSignal
) =>
  api
    .post<Envelope<GameRun>>(
      `${path}/input`,
      { id, from, inputs, quit },
      { timeout: 10000, skipErrorHandler: true, signal }
    )
    .then((r) => unwrap(r.data))
export const getRankings = (period: 'day' | 'week') =>
  api
    .get<Envelope<Rank[]>>(`${path}/rankings`, { params: { period } })
    .then((r) => unwrap(r.data))
export const saveSettings = (settings: GameSettings) =>
  api
    .put<Envelope<GameSettings>>(`${path}/settings`, settings)
    .then((r) => unwrap(r.data))

export const getGameSettings = () =>
  api
    .get<Envelope<GameSettings>>(`${path}/settings`)
    .then((r) => unwrap(r.data))
