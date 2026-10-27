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

import type { DuelInputBatch, DuelState } from './duel-engine'

export type PvPPlayerView = {
  slot: number
  secret?: string
  cursor: number
  seq: number
  score: number
  hp: number
}
export type PvPOpponentView = {
  id: number
  name: string
  display_name: string
  cursor: number
  score: number
  hp: number
}
export type PvPMatchView = {
  id: string
  mode: 'ranked' | 'friendly'
  status: 'invited' | 'playing' | 'finished' | 'cancelled'
  stake: number
  seed: number
  you: PvPPlayerView
  opponent: PvPOpponentView
  state: DuelState | null
  winner_slot: number
  you_delta_quota: number | null
  invite_code: string | null
  created_at: number
  started_at: number
  finished_at: number
  server_time: number
}
export type PvPQueueView = {
  waiting: boolean
  waited_ms: number
  stake: number
}
export type PvPStatus = {
  enabled: boolean
  min_stake: number
  max_stake: number
  queue: PvPQueueView | null
  match: PvPMatchView | null
  server_time: number
}
export type PvPMatchSummary = {
  id: string
  mode: 'ranked' | 'friendly'
  status: 'invited' | 'playing' | 'finished' | 'cancelled'
  stake: number
  opponent_name: string
  my_score: number
  opponent_score: number
  result: 'win' | 'lose' | 'draw' | ''
  delta_quota: number
  created_at: number
  finished_at: number
}
export type PvPReplay = {
  seed: number
  stake: number
  players: { slot: number; user_id: number; name: string; score: number }[]
  winner_slot: number
  inputs: DuelInputBatch[]
  started_at: number
  finished_at: number
}

type Envelope<T> = { success: boolean; data: T; message?: string }
const path = '/api/user/game/pvp'
function unwrap<T>(response: Envelope<T>): T {
  if (!response.success) {
    throw new Error(response.message || 'Unable to load the PvP duel')
  }
  return response.data
}

// The signature key is imported once per secret and cached as a promise, so
// every synchronization batch only awaits the HMAC itself.
const duelKeys = new Map<string, Promise<CryptoKey>>()
function importDuelKey(secret: string) {
  let key = duelKeys.get(secret)
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    duelKeys.set(secret, key)
  }
  return key
}

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

// Mirrors model/pvp.go pvpSignature: the tag covers every field the server
// treats as client-authoritative for one input batch.
export async function signPvPInput(
  secret: string,
  matchId: string,
  slot: number,
  seq: number,
  from: number,
  quit: boolean,
  inputs: number[]
) {
  const message = `pvp1|${matchId}|${slot}|${seq}|${from}|${quit ? 1 : 0}|${inputs.join(',')}`
  const key = await importDuelKey(secret)
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message)
  )
  return toHex(mac)
}

export const getPvPStatus = (signal?: AbortSignal) =>
  api
    .get<Envelope<PvPStatus>>(`${path}/status`, { signal })
    .then((r) => unwrap(r.data))
export const joinPvPQueue = (stake: number) =>
  api
    .post<Envelope<{ queued: boolean; match: PvPMatchView | null }>>(
      `${path}/queue`,
      { stake },
      { skipErrorHandler: true, skipBusinessError: true }
    )
    .then((r) => unwrap(r.data))
export const leavePvPQueue = () =>
  api
    .delete<Envelope<{ left: boolean }>>(`${path}/queue`, {
      skipErrorHandler: true,
      skipBusinessError: true,
    })
    .then((r) => unwrap(r.data))
export const getPvPMatch = (signal?: AbortSignal) =>
  api
    .get<Envelope<PvPMatchView>>(`${path}/match`, { signal })
    .then((r) => unwrap(r.data))
export const submitPvPInput = (
  matchId: string,
  seq: number,
  from: number,
  inputs: number[],
  quit: boolean,
  sig: string,
  signal?: AbortSignal
) =>
  api
    .post<Envelope<PvPMatchView>>(
      `${path}/input`,
      { match_id: matchId, seq, from, inputs, quit, sig },
      {
        timeout: 10000,
        skipErrorHandler: true,
        skipBusinessError: true,
        signal,
      }
    )
    .then((r) => unwrap(r.data))
export const createPvPFriendly = (stake: number) =>
  api
    .post<Envelope<{ code: string; match: PvPMatchView }>>(
      `${path}/friendly/create`,
      { stake },
      { skipErrorHandler: true, skipBusinessError: true }
    )
    .then((r) => unwrap(r.data))
export const joinPvPFriendly = (code: string) =>
  api
    .post<Envelope<{ match: PvPMatchView }>>(
      `${path}/friendly/join`,
      { code },
      { skipErrorHandler: true, skipBusinessError: true }
    )
    .then((r) => unwrap(r.data))
export const listPvPMatches = (
  page: number,
  pageSize: number,
  signal?: AbortSignal
) =>
  api
    .get<Envelope<{ items: PvPMatchSummary[]; total: number }>>(
      `${path}/matches`,
      { params: { page, page_size: pageSize }, signal }
    )
    .then((r) => unwrap(r.data))
export const getPvPReplay = (matchId: string, signal?: AbortSignal) =>
  api
    .get<Envelope<PvPReplay>>(`${path}/matches/${matchId}/replay`, { signal })
    .then((r) => unwrap(r.data))
