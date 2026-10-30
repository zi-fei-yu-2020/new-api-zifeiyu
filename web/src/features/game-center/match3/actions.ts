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
import {
  applyMatch,
  encodeMatchInput,
  MATCH_COMBO_WINDOW_TICKS,
  MATCH_MAX_ARG,
  MATCH_MAX_INPUTS,
  MATCH_OP_REVEAL,
  MATCH_OP_SHUFFLE,
  MATCH_OP_UNDO,
  MATCH_TICK_MS,
  type MatchState,
} from './engine'

// Exports: MatchSkill, MATCH_SKILL_OPS, MATCH_MAX_GAP_TICKS, Match3Session,
// planMatchAction.

export type MatchSkill = 'reveal' | 'undo' | 'shuffle'
export const MATCH_SKILL_OPS: Record<MatchSkill, number> = {
  reveal: MATCH_OP_REVEAL,
  undo: MATCH_OP_UNDO,
  shuffle: MATCH_OP_SHUFFLE,
}
// Idle time beyond the combo window changes nothing in the engine, so a longer
// gap is sent as this one capped delta instead of a chain of wait inputs. The
// claimed clock therefore never runs ahead of the wall clock.
export const MATCH_MAX_GAP_TICKS = MATCH_COMBO_WINDOW_TICKS + 1

// The session both hooks hand to the UI.
// - state is an immutable snapshot, replaced on every change and never mutated.
// - active is true while the run accepts actions (false before a run exists,
//   after the run is over, or after quit).
// - pick and skill return whether the action was legal and recorded; a
//   rejected action (covered tile, locked or unaffordable skill, a second
//   action inside the 200ms gap, paused, not active) is dropped and never sent.
// - restart starts a new game; quit gives the run up. Both may be async.
// - paused is the boss-key flag; setPaused toggles it.
// - tick() is the current game clock in 100ms ticks (state.clock plus the time
//   since the last input), for timers that must follow the engine clock.
export type Match3Session = {
  state: MatchState
  active: boolean
  pick: (id: number) => boolean
  skill: (kind: MatchSkill) => boolean
  restart: () => void | Promise<void>
  quit: () => void | Promise<void>
  connection: 'online' | 'reconnecting'
  paused: boolean
  setPaused: (paused: boolean) => void
  tick: () => number
}

// Applies one action elapsedMs after the previous input to a copy of state.
// The result carries the input word and how many of the elapsed milliseconds
// the word consumed (all of them when the gap was capped). A null result means
// the action would be a rejected no-op or would exceed the input budget, so
// the caller must neither commit nor send it.
export function planMatchAction(
  state: MatchState,
  op: number,
  arg: number,
  elapsedMs: number
): { next: MatchState; word: number; spentMs: number } | null {
  if (!Number.isInteger(arg) || arg < 0 || arg > MATCH_MAX_ARG) return null
  const ticks = Math.max(0, Math.floor(elapsedMs / MATCH_TICK_MS))
  const gap = Math.min(ticks, MATCH_MAX_GAP_TICKS)
  const word = encodeMatchInput(op, arg, gap)
  const next = structuredClone(state)
  if (!applyMatch(next, word)) return null
  if (next.rejected !== state.rejected || next.inputs > MATCH_MAX_INPUTS) {
    return null
  }
  return {
    next,
    word,
    spentMs: ticks > gap ? Math.max(0, elapsedMs) : gap * MATCH_TICK_MS,
  }
}
