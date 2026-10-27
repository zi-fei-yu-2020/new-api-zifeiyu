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
      if (next?.id !== session.current?.id || next?.status !== 'playing') {
        input.current = { direction: 0, dash: false, upgrade: 0 }
      }
      session.current = next
      quitRequested.current = false
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
      clockOrigin.current =
        performance.now() -
        (next ? next.server_time - (next.started_at || next.server_time) : 0)
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
    const version = generation.current
    const controller = new AbortController()
    request.current = controller
    const task = Promise.resolve()
      .then(async () => {
        try {
          if (recoveryRequested.current && !quitRequested.current) {
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
          setMatch(confirmed)
          setDisplay(structuredClone(state.current))
          setConnection(remaining.length >= 50 ? 'reconnecting' : 'online')
          if (confirmed.status !== 'playing') {
            recoveryRequested.current = false
            onFinishRef.current()
          }
        } catch {
          if (generation.current === version && !controller.signal.aborted) {
            // Either transport failed or the server rejected the packet (for
            // example a duplicate sequence after a timeout); re-installing the
            // authoritative duel is safe in both cases.
            recoveryRequested.current = true
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
    await synchronize()
  }

  return { match, display, state, input, connection, install, quit }
}
