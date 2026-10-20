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

import { sendInputs, getGameStatus, type GameRun } from './api'
import {
  gameCursor,
  isDone,
  MAX_INPUT_BATCH,
  newGame,
  step,
  TICK_MS,
  type GameState,
} from './engine'

export function useGameSession(onFinish: () => void) {
  const [run, setRun] = useState<GameRun | null>(null)
  const [display, setDisplay] = useState<GameState>(() => newGame(42))
  const [connection, setConnection] = useState<'online' | 'reconnecting'>(
    'online'
  )
  const state = useRef<GameState>(newGame(42))
  const session = useRef<GameRun | null>(null)
  const input = useRef({ direction: 0, dash: false, upgrade: 0 })
  const pending = useRef<number[]>([])
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
    (next: GameRun | null) => {
      cancelSynchronization()
      if (next?.id !== session.current?.id || next?.status !== 'running') {
        input.current = { direction: 0, dash: false, upgrade: 0 }
      }
      session.current = next
      quitRequested.current = false
      recoveryRequested.current = false
      state.current = next ? structuredClone(next.state) : newGame(42)
      pending.current = []
      clockOrigin.current =
        performance.now() - (next ? next.server_time - next.started_at : 0)
      setRun(next)
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
      current.status !== 'running' ||
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
          if (
            recoveryRequested.current &&
            pending.current.length === 0 &&
            !quitRequested.current
          ) {
            const data = await getGameStatus(controller.signal)
            if (generation.current !== version || controller.signal.aborted) {
              return
            }
            install(data.run)
            if (data.run?.status !== 'running') onFinishRef.current()
            return
          }
          const from = gameCursor(state.current) - pending.current.length
          const batch = pending.current.slice(0, MAX_INPUT_BATCH)
          const confirmed = await sendInputs(
            current.id,
            from,
            batch,
            quitRequested.current,
            controller.signal
          )
          if (
            generation.current !== version ||
            session.current?.id !== current.id ||
            controller.signal.aborted
          ) {
            return
          }
          const acknowledged = gameCursor(confirmed.state) - from
          if (acknowledged < 0) {
            pending.current = []
            recoveryRequested.current = true
            setConnection('reconnecting')
            return
          }
          const remaining =
            confirmed.status === 'running'
              ? pending.current.slice(acknowledged)
              : []
          pending.current = remaining
          state.current = structuredClone(confirmed.state)
          for (const value of remaining) step(state.current, value)
          session.current = confirmed
          setRun(confirmed)
          setDisplay(structuredClone(state.current))
          setConnection(remaining.length >= 50 ? 'reconnecting' : 'online')
          if (confirmed.status !== 'running') {
            recoveryRequested.current = false
            onFinishRef.current()
          }
        } catch {
          if (generation.current === version && !controller.signal.aborted) {
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
        current.status !== 'running' ||
        document.hidden ||
        recoveryRequested.current ||
        quitRequested.current
      ) {
        return
      }
      const target =
        Math.floor((performance.now() - clockOrigin.current) / TICK_MS) - 1
      if (
        target - gameCursor(state.current) > MAX_INPUT_BATCH ||
        pending.current.length >= MAX_INPUT_BATCH
      ) {
        setConnection('reconnecting')
        return
      }
      let advanced = false
      while (
        gameCursor(state.current) < target &&
        !isDone(state.current) &&
        pending.current.length < MAX_INPUT_BATCH
      ) {
        const value =
          input.current.direction |
          (input.current.dash ? 16 : 0) |
          (input.current.upgrade << 5)
        input.current.dash = false
        input.current.upgrade = 0
        step(state.current, value)
        pending.current.push(value)
        advanced = true
      }
      if (pending.current.length >= 50) setConnection('reconnecting')
      if (advanced) setDisplay(structuredClone(state.current))
    }, TICK_MS)
    const sync = window.setInterval(() => {
      void synchronize()
    }, 2000)
    const visibility = () => {
      input.current = { direction: 0, dash: false, upgrade: 0 }
      if (document.hidden || session.current?.status !== 'running') return
      recoveryRequested.current = true
      setConnection('reconnecting')
      void synchronize()
    }
    const reconnect = () => {
      if (session.current?.status !== 'running') return
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

  return { run, display, state, input, connection, install, quit }
}
