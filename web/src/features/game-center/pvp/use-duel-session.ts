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
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  getPvPMatch,
  signPvPInput,
  submitPvPInput,
  type PvPMatchView,
} from './api'
import {
  DUEL_MAX_INPUT_BATCH,
  DUEL_TICK_MS,
  encodeDuelInput,
  newDuel,
  step,
  type DuelState,
} from './duel-engine'

export type DuelInput = { direction: number; dash: boolean; upgrade: number }

// A 429 or a transport failure means the batch may never have reached the
// server, so the unacknowledged inputs stay queued and the same batch is sent
// again after the returned delay. Anything else (a rejected packet, an expired
// session) cannot be fixed by resending and falls back to recovery. The delay
// is in milliseconds; null means the failure is not transient.
function transientRetryDelay(error: unknown): number | null {
  if (!isAxiosError(error)) return null
  const status = error.response?.status
  if (status === undefined) return 0
  if (status === 502 || status === 503 || status === 504) return 1000
  if (status !== 429) return null
  const seconds = Number(error.response?.headers?.['retry-after'])
  if (!Number.isFinite(seconds) || seconds <= 0) return 2000
  return Math.min(seconds, 10) * 1000
}

// useDuelSession mirrors useGameSession for duels: the local engine runs the
// whole duel world with the player's own inputs applied immediately, every
// synchronization sends one strictly sequenced, HMAC-signed batch and the
// authoritative state it returns overwrites the local mirror before the
// unacknowledged inputs are replayed on top of it.
export function useDuelSession(onFinish: () => void) {
  const [match, setMatch] = useState<PvPMatchView | null>(null)
  const [display, setDisplay] = useState<DuelState>(() => newDuel(42))
  const [connection, setConnection] = useState<'online' | 'reconnecting'>(
    'online'
  )
  // Whole seconds until tick 0; the server starts every duel a few seconds
  // after pairing so both players can arrive before the clock runs.
  const [countdown, setCountdown] = useState(0)
  const state = useRef<DuelState>(newDuel(42))
  const session = useRef<PvPMatchView | null>(null)
  const slot = useRef(1)
  const secret = useRef('')
  const input = useRef<DuelInput>({ direction: 0, dash: false, upgrade: 0 })
  const pending = useRef<number[]>([])
  const confirmedCursor = useRef(0)
  const confirmedSeq = useRef(0)
  const clockOrigin = useRef(0)
  const generation = useRef(0)
  const inFlight = useRef<Promise<void> | null>(null)
  const request = useRef<AbortController | null>(null)
  const quitRequested = useRef(false)
  const recoveryRequested = useRef(false)
  const retryAt = useRef(0)
  const onFinishRef = useRef(onFinish)
  onFinishRef.current = onFinish

  const cancelSynchronization = useCallback(() => {
    generation.current++
    request.current?.abort()
    request.current = null
    inFlight.current = null
  }, [])

  const install = useCallback(
    (next: PvPMatchView | null) => {
      cancelSynchronization()
      const preserveQuit =
        quitRequested.current &&
        next?.status === 'playing' &&
        next.id === session.current?.id
      if (next?.id !== session.current?.id || next?.status !== 'playing') {
        input.current = { direction: 0, dash: false, upgrade: 0 }
      }
      session.current = next
      quitRequested.current = preserveQuit
      recoveryRequested.current = false
      slot.current = next?.you.slot ?? 1
      secret.current = next?.you.secret ?? ''
      confirmedCursor.current = next?.you.cursor ?? 0
      confirmedSeq.current = next?.you.seq ?? 0
      if (next?.state) {
        state.current = structuredClone(next.state)
      } else {
        state.current = newDuel(next?.seed ?? 42)
      }
      pending.current = []
      retryAt.current = 0
      clockOrigin.current =
        performance.now() -
        (next ? next.server_time - (next.started_at || next.server_time) : 0)
      setCountdown(
        next?.status === 'playing'
          ? Math.max(
              0,
              Math.ceil((clockOrigin.current - performance.now()) / 1000)
            )
          : 0
      )
      setMatch(next)
      setDisplay(structuredClone(state.current))
      setConnection('online')
    },
    [cancelSynchronization]
  )

  const synchronize = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current
    const current = session.current
    if (
      !current ||
      current.status !== 'playing' ||
      (document.hidden && !quitRequested.current)
    ) {
      return Promise.resolve()
    }
    const now = performance.now()
    // Nothing to report before tick 0 unless a packet is already queued or
    // the player resigns, and a rate-limited client waits out Retry-After.
    if (
      (now < retryAt.current && !quitRequested.current) ||
      (now < clockOrigin.current &&
        pending.current.length === 0 &&
        !quitRequested.current &&
        !recoveryRequested.current)
    ) {
      return Promise.resolve()
    }
    const version = generation.current
    const controller = new AbortController()
    request.current = controller
    const task = Promise.resolve()
      .then(async () => {
        try {
          if (recoveryRequested.current) {
            const fresh = await getPvPMatch(controller.signal)
            if (generation.current !== version || controller.signal.aborted) {
              return
            }
            install(fresh)
            if (fresh?.status !== 'playing') onFinishRef.current()
            return
          }
          const from = confirmedCursor.current
          const batch = pending.current.slice(0, DUEL_MAX_INPUT_BATCH)
          const seq = confirmedSeq.current + 1
          const sig = await signPvPInput(
            secret.current,
            current.id,
            slot.current,
            seq,
            from,
            quitRequested.current,
            batch
          )
          const confirmed = await submitPvPInput(
            current.id,
            seq,
            from,
            batch,
            quitRequested.current,
            sig,
            controller.signal
          )
          if (
            generation.current !== version ||
            session.current?.id !== current.id ||
            controller.signal.aborted
          ) {
            return
          }
          // A response carrying our sequence number proves the whole batch
          // was stored; the view cursor is only a fallback for a duel that
          // ended mid-batch.
          let acknowledged = batch.length
          if (confirmed.status !== 'playing' || confirmed.you.seq !== seq) {
            acknowledged = Math.max(
              0,
              Math.min(batch.length, confirmed.you.cursor - from)
            )
          }
          const remaining =
            confirmed.status === 'playing'
              ? pending.current.slice(acknowledged)
              : []
          pending.current = remaining
          confirmedCursor.current = from + acknowledged
          confirmedSeq.current = confirmed.you.seq
          if (confirmed.state) {
            state.current = structuredClone(confirmed.state)
          }
          // The opponent's unsynchronized ticks stay neutral until the next
          // authoritative snapshot arrives.
          for (const value of remaining) {
            if (slot.current === 1) step(state.current, value, 0)
            else step(state.current, 0, value)
          }
          session.current = confirmed
          retryAt.current = 0
          setMatch(confirmed)
          setDisplay(structuredClone(state.current))
          setConnection(remaining.length >= 50 ? 'reconnecting' : 'online')
          if (confirmed.status !== 'playing') {
            recoveryRequested.current = false
            onFinishRef.current()
          }
        } catch (error) {
          if (generation.current === version && !controller.signal.aborted) {
            const delay = transientRetryDelay(error)
            if (delay === null) {
              // The server rejected the packet (for example a duplicate
              // sequence after a timeout); re-installing the authoritative
              // duel is the only way back in step.
              recoveryRequested.current = true
            } else {
              retryAt.current = performance.now() + delay
            }
            setConnection('reconnecting')
          }
        }
      })
      .finally(() => {
        if (inFlight.current === task) {
          inFlight.current = null
          request.current = null
        }
      })
    inFlight.current = task
    return task
  }, [install])

  useEffect(() => {
    const simulate = window.setInterval(() => {
      const current = session.current
      if (current?.status === 'playing') {
        setCountdown(
          Math.max(
            0,
            Math.ceil((clockOrigin.current - performance.now()) / 1000)
          )
        )
      }
      if (
        !current ||
        current.status !== 'playing' ||
        document.hidden ||
        recoveryRequested.current ||
        quitRequested.current
      ) {
        return
      }
      const target =
        Math.floor((performance.now() - clockOrigin.current) / DUEL_TICK_MS) - 1
      const cursor = () => confirmedCursor.current + pending.current.length
      if (pending.current.length >= DUEL_MAX_INPUT_BATCH) {
        setConnection('reconnecting')
        return
      }
      if (target - cursor() > DUEL_MAX_INPUT_BATCH) {
        setConnection('reconnecting')
      }
      let advanced = false
      while (
        cursor() < target &&
        !state.current.finished &&
        pending.current.length < DUEL_MAX_INPUT_BATCH
      ) {
        // More than one batch behind the server clock: those ticks are already
        // consumed as neutral server-side, so record neutral catch-up batches
        // (the server accepts from + len up to the allowed tick) until the
        // cursor is close enough to resume real inputs. The local mirror
        // already sits on the authoritative tick, so it is not stepped here.
        if (target - cursor() > DUEL_MAX_INPUT_BATCH) {
          pending.current.push(0)
          continue
        }
        const value = encodeDuelInput(
          input.current.direction,
          input.current.dash,
          input.current.upgrade
        )
        input.current.dash = false
        input.current.upgrade = 0
        if (slot.current === 1) step(state.current, value, 0)
        else step(state.current, 0, value)
        pending.current.push(value)
        advanced = true
      }
      if (pending.current.length >= 50) setConnection('reconnecting')
      if (advanced) setDisplay(structuredClone(state.current))
    }, DUEL_TICK_MS)
    const sync = window.setInterval(() => {
      void synchronize()
    }, 600)
    const visibility = () => {
      input.current = { direction: 0, dash: false, upgrade: 0 }
      if (document.hidden || session.current?.status !== 'playing') return
      recoveryRequested.current = true
      setConnection('reconnecting')
      void synchronize()
    }
    const reconnect = () => {
      if (session.current?.status !== 'playing') return
      cancelSynchronization()
      retryAt.current = 0
      setConnection('reconnecting')
      void synchronize()
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('online', reconnect)
    return () => {
      cancelSynchronization()
      clearInterval(simulate)
      clearInterval(sync)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('online', reconnect)
    }
  }, [synchronize, cancelSynchronization])

  const quit = async () => {
    quitRequested.current = true
    input.current = { direction: 0, dash: false, upgrade: 0 }
    if (inFlight.current) await inFlight.current
    // A recovery round only refreshes the cursor and sequence number, so the
    // quit batch itself goes out on a following round.
    for (let attempt = 0; attempt < 3; attempt++) {
      await synchronize()
      if (session.current?.status !== 'playing') return
    }
  }

  return { match, display, state, input, connection, countdown, install, quit }
}
