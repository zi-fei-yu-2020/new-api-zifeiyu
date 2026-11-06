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
  version?: number
}

type Envelope<T> = { success: boolean; data: T; message?: string }
const path = '/api/user/game/pvp'
function unwrap<T>(response: Envelope<T>): T {
  if (!response.success) {
    throw new Error(response.message || 'Unable to load the PvP duel')
  }
  return response.data
}

// Browsers expose crypto.subtle only on secure origins, so a plain-HTTP
// deployment has no WebCrypto. The small SHA-256/HMAC below keeps input signing
// (and with it every staked duel) working there; the native path is preferred.
const sha256Primes: number[] = []
for (let n = 2; sha256Primes.length < 64; n++) {
  if (sha256Primes.every((prime) => n % prime !== 0)) sha256Primes.push(n)
}
const fractionBits = (value: number) =>
  Math.floor((value - Math.floor(value)) * 2 ** 32)
const sha256K = sha256Primes.map((prime) => fractionBits(Math.cbrt(prime)))
const sha256H = sha256Primes
  .slice(0, 8)
  .map((prime) => fractionBits(Math.sqrt(prime)))
const rotr = (value: number, bits: number) =>
  (value >>> bits) | (value << (32 - bits))

function sha256(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  const bitLength = data.length * 8
  view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32))
  view.setUint32(padded.length - 4, bitLength >>> 0)
  const hash = Uint32Array.from(sha256H)
  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = w[i - 16] + s0 + w[i - 7] + s1
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let i = 0; i < 64; i++) {
      const t1 =
        (h +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          sha256K[i] +
          w[i]) |
        0
      const t2 =
        ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) |
        0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    const round = [a, b, c, d, e, f, g, h]
    for (let i = 0; i < 8; i++) hash[i] += round[i]
  }
  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  hash.forEach((word, i) => outView.setUint32(i * 4, word))
  return out
}

function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = key.length > 64 ? sha256(key) : key
  const inner = new Uint8Array(64 + message.length)
  const outer = new Uint8Array(96)
  for (let i = 0; i < 64; i++) {
    inner[i] = (block[i] ?? 0) ^ 0x36
    outer[i] = (block[i] ?? 0) ^ 0x5c
  }
  inner.set(message, 64)
  outer.set(sha256(inner), 64)
  return sha256(outer)
}

// The signature key is imported once per secret and cached as a promise, so
// every synchronization batch only awaits the HMAC itself. A rejected import
// is evicted so a later batch can retry instead of replaying the failure.
const duelKeys = new Map<string, Promise<CryptoKey>>()
function importDuelKey(subtle: SubtleCrypto, secret: string) {
  let key = duelKeys.get(secret)
  if (!key) {
    key = subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    duelKeys.set(secret, key)
    key.catch(() => {
      if (duelKeys.get(secret) === key) duelKeys.delete(secret)
    })
  }
  return key
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  )
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
  const message = new TextEncoder().encode(
    `pvp1|${matchId}|${slot}|${seq}|${from}|${quit ? 1 : 0}|${inputs.join(',')}`
  )
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    try {
      const key = await importDuelKey(subtle, secret)
      return toHex(new Uint8Array(await subtle.sign('HMAC', key, message)))
    } catch {
      // Fall through to the portable implementation below.
    }
  }
  return toHex(hmacSha256(new TextEncoder().encode(secret), message))
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
