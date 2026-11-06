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
  isMatchDone,
  MATCH_MODE_ENDLESS,
  MATCH_COMPLETED,
  MATCH_OP_PICK,
  MATCH_TICK_MS,
  MATCH_UNLOCK_REVEAL,
  MATCH_UNLOCK_SHUFFLE,
  MATCH_UNLOCK_UNDO,
  newMatch,
  type MatchState,
} from './engine'
import { restoreMatchSave, useMatch3Store } from './store'

// useMatch3Local(userId, unlocks?) runs a practice endless game entirely in the
// browser; it never touches the network and never feeds ranks or rewards.
//
// Returns Match3Session (see ./actions.ts) plus nothing else:
//   { state, active, pick(id), skill(kind), restart(), quit(), connection,
//     paused, setPaused(paused), tick() }
// - connection is always 'online'.
// - The game clock is the sum of the per-input deltas, measured with
//   performance.now(). It stops while paused (boss key) and while the tab is
//   hidden, so neither can cost the player a combo.
// - After every legal action the inputs so far are saved under the user's key
//   in the match3-local store and replayed through the engine on the next
//   mount; a save the engine refuses starts a new game instead.
// - quit() clears the save and ends the session (active becomes false).
// - restart() deals a new random game with every skill unlocked unless
//   unlocks says otherwise.
const allUnlocks =
  MATCH_UNLOCK_REVEAL | MATCH_UNLOCK_UNDO | MATCH_UNLOCK_SHUFFLE

type Game = { state: MatchState; inputs: number[] }

function loadGame(userId: number | undefined, unlocks: number): Game {
  const saved =
    userId === undefined
      ? null
      : useMatch3Store.getState().byUser[String(userId)]?.saved
  const restored = restoreMatchSave(saved)
  if (restored) return restored
  const seed = crypto.getRandomValues(new Uint32Array(1))[0]
  return { state: newMatch(seed, MATCH_MODE_ENDLESS, unlocks), inputs: [] }
}

export function useMatch3Local(
  userId: number | undefined,
  unlocks: number = allUnlocks
): Match3Session {
  const [initial] = useState(() => loadGame(userId, unlocks))
  const [state, setState] = useState<MatchState>(initial.state)
  const [active, setActive] = useState(true)
  const [paused, setPausedState] = useState(false)
  const game = useRef<Game>(initial)
  const lastAt = useRef(performance.now())
  const pausedSince = useRef<number | null>(null)
  const userPaused = useRef(false)
  const loadedFor = useRef(userId)

  // Time stands still while paused or hidden: the stretch is added back to
  // lastAt when the clock resumes.
  const syncClock = useCallback(() => {
    const frozen = userPaused.current || document.hidden
    const now = performance.now()
    if (frozen && pausedSince.current === null) {
      pausedSince.current = now
    } else if (!frozen && pausedSince.current !== null) {
      lastAt.current += now - pausedSince.current
      pausedSince.current = null
    }
  }, [])

  const load = useCallback(
    (next: Game) => {
      game.current = next
      lastAt.current = performance.now()
      pausedSince.current = null
      userPaused.current = false
      setState(next.state)
      setActive(true)
      setPausedState(false)
      syncClock()
    },
    [syncClock]
  )

  useEffect(() => {
    document.addEventListener('visibilitychange', syncClock)
    return () => document.removeEventListener('visibilitychange', syncClock)
  }, [syncClock])

  useEffect(() => {
    if (loadedFor.current === userId) return
    loadedFor.current = userId
    load(loadGame(userId, unlocks))
  }, [userId, unlocks, load])

  const commit = (op: number, arg: number) => {
    if (!active || userPaused.current || document.hidden) return false
    const now = performance.now()
    const plan = planMatchAction(
      game.current.state,
      op,
      arg,
      now - lastAt.current
    )
    if (!plan) return false
    lastAt.current += plan.spentMs
    game.current = {
      state: plan.next,
      inputs: [...game.current.inputs, plan.word],
    }
    setState(plan.next)
    const store = useMatch3Store.getState()
    if (userId === undefined) return true
    if (isMatchDone(plan.next)) {
      const levels =
        plan.next.status === MATCH_COMPLETED
          ? plan.next.level
          : plan.next.level - 1
      store.recordBest(userId, levels)
      store.setSaved(userId, null)
      setActive(false)
    } else {
      store.setSaved(userId, {
        seed: plan.next.seed,
        mode: plan.next.mode,
        unlocks: plan.next.unlocks,
        inputs: game.current.inputs,
      })
    }
    return true
  }

  const pick = (id: number) => commit(MATCH_OP_PICK, id)
  const skill = (kind: MatchSkill) => commit(MATCH_SKILL_OPS[kind], 0)
  const restart = () => {
    if (userId !== undefined) useMatch3Store.getState().setSaved(userId, null)
    load(loadGame(undefined, unlocks))
  }
  const quit = () => {
    if (userId !== undefined) useMatch3Store.getState().setSaved(userId, null)
    setActive(false)
  }
  const setPaused = (value: boolean) => {
    userPaused.current = value
    setPausedState(value)
    syncClock()
  }
  const tick = () => {
    const now = pausedSince.current ?? performance.now()
    return (
      game.current.state.clock +
      Math.max(0, Math.floor((now - lastAt.current) / MATCH_TICK_MS))
    )
  }

  return {
    state,
    active,
    pick,
    skill,
    restart,
    quit,
    connection: 'online',
    paused,
    setPaused,
    tick,
  }
}
