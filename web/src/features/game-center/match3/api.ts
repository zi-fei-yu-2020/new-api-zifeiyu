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
import { isAxiosError } from 'axios'

import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

import type { MatchState } from './engine'

export type MatchMode = 'daily' | 'endless'
export type MatchRunStatus = 'running' | 'completed' | 'lost' | 'abandoned'
export type MatchRun = {
  id: string
  mode: MatchMode
  day: string
  week: string
  status: MatchRunStatus
  unlocks: number
  level: number
  score: number
  started_at: number
  updated_at: number
  finished_at: number
  state: MatchState
  server_time: number
}
export type MatchStatus = {
  settings: { enabled: boolean; rewards_enabled: boolean }
  day: string
  week: string
  resets_at: number
  server_time: number
  daily_run: MatchRun | null
  endless_run: MatchRun | null
  profile: { best_level: number; xp: number; rank: number; unlocks: number }
  weekly_prizes: number[]
  weekly_total: number
  weekly_rewards_enabled: boolean
}
export type MatchRank = {
  name: string
  score: number
  runs: number
  rank: number
  is_me: boolean
  level?: number
}
type Envelope<T> = { success: boolean; data: T; message?: string }
const path = '/api/user/game/match3'
function unwrap<T>(response: Envelope<T>): T {
  requireServerSuccess(response)
  return response.data
}

export const getMatchStatus = (signal?: AbortSignal) =>
  api.get<Envelope<MatchStatus>>(path, { signal }).then((r) => unwrap(r.data))
export const startMatch = (mode: MatchMode) =>
  api
    .post<Envelope<MatchRun>>(
      `${path}/start`,
      { mode },
      { skipErrorHandler: true, skipBusinessError: true }
    )
    .then((r) => unwrap(r.data))
export const sendMatchInputs = (
  id: string,
  from: number,
  inputs: number[],
  quit = false,
  signal?: AbortSignal
) =>
  api
    .post<Envelope<MatchRun>>(
      `${path}/input`,
      { id, from, inputs, quit },
      { timeout: 10000, skipErrorHandler: true, signal }
    )
    .then((r) => unwrap(r.data))
export const getMatchRankings = (mode: MatchMode) =>
  api
    .get<Envelope<MatchRank[]>>(`${path}/rankings`, { params: { mode } })
    .then((r) => unwrap(r.data))

// A 429 or a transport failure means the batch may never have reached the
// server, and resending from the same cursor is idempotent, so the queued
// inputs stay and are sent again after the returned delay in milliseconds.
// Anything else (a rejected batch, an expired session) cannot be fixed by
// resending; null tells the caller to recover from the authoritative run.
export function transientRetryDelay(error: unknown): number | null {
  if (!isAxiosError(error)) return null
  const status = error.response?.status
  if (status === undefined) return 0
  if (status === 502 || status === 503 || status === 504) return 1000
  if (status !== 429) return null
  const seconds = Number(error.response?.headers?.['retry-after'])
  if (!Number.isFinite(seconds) || seconds <= 0) return 2000
  return Math.min(seconds, 10) * 1000
}
