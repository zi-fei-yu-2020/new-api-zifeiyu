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
import { describe, expect, it } from 'vitest'

import fixtures from '../../../../../../pkg/tokengame/testdata/duel-replays.json'
import {
  advanceDuel,
  buildDuelStreams,
  DUEL_DURATION,
  DUEL_TICK_MS,
  forfeit,
  newDuel,
  replayDuelTo,
  step,
  type DuelInputBatch,
} from '../duel-engine'

describe('authoritative duel replay contract', () => {
  for (const fixture of fixtures) {
    it(`matches the Go duel replay for seed ${fixture.seed} after ${fixture.inputs1.length} inputs`, () => {
      const state = newDuel(fixture.seed)
      for (let i = 0; i < fixture.inputs1.length; i++) {
        step(state, fixture.inputs1[i], fixture.inputs2[i])
      }
      expect(state).toEqual(fixture.state)
      if (fixture.state.finished) {
        const end = structuredClone(state)
        step(state, 3, 3)
        expect(state).toEqual(end)
      }
    })
  }
})

it('rebuilds the settled state from on-time batches exactly like raw streams', () => {
  const fixture = fixtures[2]
  const startedAt = 1_000_000
  const segments: {
    player: number
    seq: number
    from_tick: number
    inputs: number[]
    received_at: number
  }[] = []
  for (const [player, inputs] of [
    [1, fixture.inputs1],
    [2, fixture.inputs2],
  ] as const) {
    let seq = 0
    for (let from = 0; from < inputs.length; from += 97) {
      const slice = inputs.slice(from, from + 97)
      segments.push({
        player,
        seq: ++seq,
        from_tick: from,
        inputs: slice,
        // Every batch arrives the instant its first tick opens, so the
        // simulation never consumes one of its own ticks as neutral.
        received_at: startedAt + from * DUEL_TICK_MS,
      })
    }
  }
  // Insertion order follows arrival order, like the server's row ids.
  segments.sort((a, b) => a.received_at - b.received_at || a.player - b.player)
  const batches: DuelInputBatch[] = segments.map((segment, index) => ({
    id: index + 1,
    ...segment,
    quit: false,
  }))
  batches.reverse()
  const [inputs1, inputs2] = buildDuelStreams(batches)
  expect(inputs1).toEqual(fixture.inputs1)
  expect(inputs2).toEqual(fixture.inputs2)
  const replayed = replayDuelTo(fixture.seed, startedAt, batches, DUEL_DURATION)
  const expected = structuredClone(fixture.state)
  expected.players[0].cursor = fixture.inputs1.length
  expected.players[1].cursor = fixture.inputs2.length
  expect(replayed).toEqual(expected)
})

it('rolls back accepted late inputs so replay matches the authoritative state', () => {
  const seed = 42
  const startedAt = 1_000_000
  const batches: DuelInputBatch[] = [
    {
      id: 1,
      player: 1,
      seq: 1,
      from_tick: 0,
      inputs: [3],
      received_at: startedAt + 10 * DUEL_TICK_MS,
      quit: false,
    },
    {
      id: 2,
      player: 2,
      seq: 1,
      from_tick: 0,
      inputs: [5, 5],
      received_at: startedAt + 30 * DUEL_TICK_MS,
      quit: false,
    },
  ]
  // Player two submitted moves for ticks 0-1 after the shared clock had
  // passed them. The accepted inputs still take effect through deterministic
  // rollback, and replay must produce the same state as the full streams.
  const state = replayDuelTo(seed, startedAt, batches, 30)
  expect(state.tick).toBe(30)
  expect(state.players[0].x).toBeGreaterThan(2500)
  expect(state.players[1].x).toBe(7500)
  expect(state.players[1].y).toBeGreaterThan(3500)
  // Scrubbing before the first batch arrived hides it entirely.
  expect(replayDuelTo(seed, startedAt, batches, 5).players[0].x).toBe(2500)
  const expected = newDuel(seed)
  advanceDuel(expected, 30, [3], [5, 5])
  expect(state).toEqual(expected)
})

it('applies a recorded resignation at its arrival tick and not before', () => {
  const startedAt = 2_000_000
  const batches: DuelInputBatch[] = [
    {
      id: 1,
      player: 2,
      seq: 1,
      from_tick: 0,
      inputs: [],
      received_at: startedAt + 5 * DUEL_TICK_MS,
      quit: true,
    },
  ]
  expect(replayDuelTo(11, startedAt, batches, 3).finished).toBe(false)
  const resigned = replayDuelTo(11, startedAt, batches, 10)
  expect(resigned.finished).toBe(true)
  expect(resigned.winner).toBe(1)
})

it('keeps both duels byte-identical for identical seeds and input streams', () => {
  const fixture = fixtures[0]
  const run = () => {
    const state = newDuel(fixture.seed)
    for (let i = 0; i < fixture.inputs1.length; i++) {
      step(state, fixture.inputs1[i], fixture.inputs2[i])
    }
    return JSON.stringify(state)
  }
  expect(run()).toBe(run())
})

it('records a forfeit as a knockout for the resigning slot only', () => {
  const state = newDuel(11)
  step(state, 0, 0)
  forfeit(state, 1)
  expect(state.finished).toBe(true)
  expect(state.winner).toBe(1)
  expect(state.players[1].hp).toBe(0)
  expect(state.players[0].hp).toBe(100)
})

it('clamps the cursor to the submitted stream length while the clock advances', () => {
  const fixture = fixtures[2]
  const state = newDuel(fixture.seed)
  advanceDuel(state, 50, fixture.inputs1.slice(0, 120), [])
  expect(state.tick).toBe(50)
  expect(state.players[0].cursor).toBe(50)
  expect(state.players[1].cursor).toBe(0)
})
