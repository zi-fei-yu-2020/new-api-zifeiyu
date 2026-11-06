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
  MATCH_SKILL_OPS,
  planMatchAction,
  type Match3Session,
  type MatchSkill,
} from './actions'
import {
  getMatchStatus,
  sendMatchInputs,
  startMatch,
  transientRetryDelay,
  type MatchMode,
  type MatchRun,
} from './api'
import {
  applyMatch,
  isMatchDone,
  MATCH_MAX_BATCH,
  MATCH_MODE_DAILY,
  MATCH_MODE_ENDLESS,
  MATCH_OP_PICK,
  MATCH_TICK_MS,
  newMatch,
  type MatchState,
} from './engine'

// useMatch3Run(mode, onFinish) plays a daily or ranked endless run against the
// server. The local engine applies every legal action at once; a sync round
// every 2s sends the unacknowledged inputs, and the authoritative state the
// server returns replaces the local mirror before the still-unacknowledged
// inputs are replayed on top of it.
//
// Returns Match3Session (see ./actions.ts) plus:
//   run      the last MatchRun the server confirmed (null before install)
//   install  (run | null) => void   adopts a run from the status query or from
//                                   startMatch; resets pending inputs and clock
// Session members: state, active, pick(id), skill(kind), restart(), quit(),
// connection ('online' | 'reconnecting'), paused, setPaused(paused), tick().
// - restart() resigns a running run, starts a new one in the same mode and
//   installs it. It rejects with the start error so the caller can toast it.
//   For the daily mode the server answers with today's finished run.
// - quit() resolves once the server confirms the run is over, or after three
//   rounds. A quit survives a recovery that re-installs the same run.
// - paused (boss key) freezes the local clock and blocks actions, but the
//   sync loop keeps running. A hidden tab freezes the clock the same way.
// - onFinish(run) fires once per run when the server reports it is over.
// - mode is fixed for the lifetime of the hook instance.
export type Match3RunSession = Match3Session & {
  run: MatchRun | null
  install: (run: MatchRun | null) => void
}

// After this many consecutive non-transient failures of the same batch it can
// never be accepted, so the queued inputs are dropped and the run is recovered
// from the server.
const MAX_BATCH_REJECTIONS = 2

export function useMatch3Run(
  mode: MatchMode,
  onFinish: (run: MatchRun) => void
): Match3RunSession {
  const modeValue = mode === 'daily' ? MATCH_MODE_DAILY : MATCH_MODE_ENDLESS
  const [run, setRun] = useState<MatchRun | null>(null)
  const [state, setState] = useState<MatchState>(() =>
    newMatch(1, modeValue, 0)
  )
  const [connection, setConnection] = useState<'online' | 'reconnecting'>(
    'online'
  )
  const [paused, setPausedState] = useState(false)
  const [active, setActive] = useState(false)
  const local = useRef<MatchState>(state)
  const session = useRef<MatchRun | null>(null)
  const pending = useRef<number[]>([])
  const lastAt = useRef(performance.now())
  const frozenSince = useRef<number | null>(null)
  const userPaused = useRef(false)
  const generation = useRef(0)
  const inFlight = useRef<Promise<void> | null>(null)
  const request = useRef<AbortController | null>(null)
  const quitRequested = useRef(false)
  const recoveryRequested = useRef(false)
  const retryAt = useRef(0)
  const rejections = useRef(0)
  const onFinishRef = useRef(onFinish)
  onFinishRef.current = onFinish

  const cancelSynchronization = useCallback(() => {
    generation.current++
    request.current?.abort()
    request.current = null
    inFlight.current = null
  }, [])

  // Time stands still while paused or hidden: the frozen stretch is added back
  // to lastAt when the clock resumes.
  const syncClock = useCallback(() => {
    const frozen = userPaused.current || document.hidden
    const now = performance.now()
    if (frozen && frozenSince.current === null) {
      frozenSince.current = now
    } else if (!frozen && frozenSince.current !== null) {
      lastAt.current += now - frozenSince.current
      frozenSince.current = null
    }
  }, [])

  const publish = useCallback((next: MatchState, current: MatchRun | null) => {
    local.current = next
    setState(next)
    setActive(
      current?.status === 'running' &&
        !isMatchDone(next) &&
        !quitRequested.current
    )
  }, [])

  const install = useCallback(
    (next: MatchRun | null) => {
      cancelSynchronization()
      // A resignation must survive the recovery that re-installs the same
      // run, otherwise the quit batch is never sent.
      const preserveQuit =
        quitRequested.current &&
        next?.status === 'running' &&
        next.id === session.current?.id
      session.current = next
      quitRequested.current = preserveQuit
      recoveryRequested.current = false
      pending.current = []
      retryAt.current = 0
      rejections.current = 0
      lastAt.current = performance.now()
      frozenSince.current = null
      syncClock()
      setRun(next)
      publish(
        next ? structuredClone(next.state) : newMatch(1, modeValue, 0),
        next
      )
      setConnection('online')
    },
    [cancelSynchronization, modeValue, publish, syncClock]
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
    if (
      !recoveryRequested.current &&
      !quitRequested.current &&
      pending.current.length === 0
    ) {
      return Promise.resolve()
    }
    if (performance.now() < retryAt.current && !quitRequested.current) {
      return Promise.resolve()
    }
    const version = generation.current
    const controller = new AbortController()
    request.current = controller
    const task = Promise.resolve()
      .then(async () => {
        try {
          if (recoveryRequested.current && pending.current.length === 0) {
            const status = await getMatchStatus(controller.signal)
            if (generation.current !== version || controller.signal.aborted) {
              return
            }
            const fresh =
              mode === 'daily' ? status.daily_run : status.endless_run
            if (fresh?.id === current.id) {
              install(fresh)
              if (fresh.status !== 'running') onFinishRef.current(fresh)
              return
            }
            // The status no longer reports this run as running, so the sweep
            // or a resignation ended it. The final score is on the boards,
            // which the caller refetches from onFinish.
            const ended: MatchRun = { ...current, status: 'abandoned' }
            install(ended)
            onFinishRef.current(ended)
            return
          }
          const from = local.current.inputs - pending.current.length
          const batch = pending.current.slice(0, MATCH_MAX_BATCH)
          const confirmed = await sendMatchInputs(
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
          const acknowledged = confirmed.state.inputs - from
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
          rejections.current = 0
          retryAt.current = 0
          const mirror = structuredClone(confirmed.state)
          for (const value of remaining) applyMatch(mirror, value)
          session.current = confirmed
          setRun(confirmed)
          publish(mirror, confirmed)
          setConnection(remaining.length >= 50 ? 'reconnecting' : 'online')
          if (confirmed.status !== 'running') {
            recoveryRequested.current = false
            onFinishRef.current(confirmed)
          }
        } catch (error) {
          if (generation.current !== version || controller.signal.aborted) {
            return
          }
          setConnection('reconnecting')
          const delay = transientRetryDelay(error)
          if (delay !== null) {
            retryAt.current = performance.now() + delay
            return
          }
          rejections.current++
          if (rejections.current >= MAX_BATCH_REJECTIONS) {
            pending.current = []
            recoveryRequested.current = true
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
  }, [install, mode, publish])

  useEffect(() => {
    const sync = window.setInterval(() => {
      void synchronize()
    }, 2000)
    const visibility = () => {
      syncClock()
      if (document.hidden || session.current?.status !== 'running') return
      recoveryRequested.current = true
      setConnection('reconnecting')
      void synchronize()
    }
    const reconnect = () => {
      if (session.current?.status !== 'running') return
      cancelSynchronization()
      retryAt.current = 0
      setConnection('reconnecting')
      void synchronize()
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('online', reconnect)
    return () => {
      cancelSynchronization()
      clearInterval(sync)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('online', reconnect)
    }
  }, [synchronize, cancelSynchronization, syncClock])

  const commit = (op: number, arg: number) => {
    if (
      !active ||
      userPaused.current ||
      document.hidden ||
      recoveryRequested.current ||
      pending.current.length >= MATCH_MAX_BATCH
    ) {
      return false
    }
    const plan = planMatchAction(
      local.current,
      op,
      arg,
      performance.now() - lastAt.current
    )
    if (!plan) return false
    lastAt.current += plan.spentMs
    pending.current.push(plan.word)
    publish(plan.next, session.current)
    return true
  }

  const pick = (id: number) => commit(MATCH_OP_PICK, id)
  const skill = (kind: MatchSkill) => commit(MATCH_SKILL_OPS[kind], 0)
  const setPaused = (value: boolean) => {
    userPaused.current = value
    setPausedState(value)
    syncClock()
  }
  const tick = () => {
    const now = frozenSince.current ?? performance.now()
    return (
      local.current.clock +
      Math.max(0, Math.floor((now - lastAt.current) / MATCH_TICK_MS))
    )
  }

  const quit = async () => {
    quitRequested.current = true
    setActive(false)
    if (inFlight.current) await inFlight.current
    // A recovery round only refreshes the run, so the quit batch itself goes
    // out on a following round.
    for (let attempt = 0; attempt < 3; attempt++) {
      await synchronize()
      if (session.current?.status !== 'running') return
    }
  }

  const restart = async () => {
    if (session.current?.status === 'running') await quit()
    install(await startMatch(mode))
  }

  return {
    run,
    state,
    active,
    pick,
    skill,
    restart,
    quit,
    connection,
    paused,
    setPaused,
    tick,
    install,
  }
}
