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

import fixtures from '../../../../../../pkg/tokengame/testdata/duel-replays-v2.json'
import legacyFixtures from '../../../../../../pkg/tokengame/testdata/duel-replays.json'
import {
  advanceDuel,
  buildDuelStreams,
  createDuelReplayCursor,
  DUEL_DURATION,
  DUEL_TICK_MS,
  forfeit,
  newDuel,
  replayDuelTo,
  step,
  type DuelInputBatch,
} from '../duel-engine'

describe('authoritative duel replay contract', () => {
  for (const fixture of [...legacyFixtures, ...fixtures]) {
    it(`matches the Go duel v${fixture.state.version} replay for seed ${fixture.seed} after ${fixture.inputs1.length} inputs`, () => {
      const state = newDuel(fixture.seed, fixture.state.version)
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

it('replays stored late inputs as neutral without rewriting history', () => {
  const seed = 42
  const startedAt = 1_000_000
  const batches: DuelInputBatch[] = [
    {
      id: 1,
      player: 1,
      seq: 1,
      from_tick: 0,
      inputs: [3],
      received_at: startedAt + 30 * DUEL_TICK_MS,
      quit: false,
    },
    {
      id: 2,
      player: 2,
      seq: 1,
      from_tick: 0,
      inputs: [0, 0],
      received_at: startedAt + 50 * DUEL_TICK_MS,
      quit: false,
    },
  ]
  // Player two's moves for ticks 0-1 arrived past the commit boundary, so the
  // server stored them as neutral. Replay appends the stored streams and
  // matches the settled state instead of rolling the duel back.
  const state = replayDuelTo(seed, startedAt, batches, 30)
  expect(state.tick).toBe(30)
  expect(state.players[0].x).toBeGreaterThan(2500)
  expect(state.players[1].x).toBe(7500)
  // Scrubbing before the first batch arrived hides it entirely.
  expect(replayDuelTo(seed, startedAt, batches, 5).players[0].x).toBe(2500)
  const expected = newDuel(seed)
  advanceDuel(expected, 30, [3], [0, 0])
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
      received_at: startedAt + 25 * DUEL_TICK_MS,
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

it('matches full replay while incrementally advancing across arrivals and late inputs', () => {
  const seed = 42
  const startedAt = 1_000_000
  const batches: DuelInputBatch[] = [
    {
      id: 1,
      player: 1,
      seq: 1,
      from_tick: 0,
      inputs: [3, 3],
      received_at: startedAt + 25 * DUEL_TICK_MS,
      quit: false,
    },
    {
      id: 2,
      player: 2,
      seq: 1,
      from_tick: 0,
      inputs: [5, 5],
      received_at: startedAt + 32 * DUEL_TICK_MS,
      quit: false,
    },
    {
      id: 3,
      player: 1,
      seq: 2,
      from_tick: 2,
      inputs: [19],
      received_at: startedAt + 40 * DUEL_TICK_MS,
      quit: false,
    },
  ]
  const seek = createDuelReplayCursor(seed, startedAt, batches)
  let previous = seek(0)

  for (let target = 1; target <= 25; target++) {
    const current = seek(target)
    expect(current).toEqual(replayDuelTo(seed, startedAt, batches, target))
    if ([5, 12, 20].includes(target)) {
      expect(current).not.toBe(previous)
    } else {
      // Ordinary forward playback advances the cached world in place instead
      // of rebuilding every preceding tick from tick zero.
      expect(current).toBe(previous)
    }
    previous = current
  }

  const backward = seek(10)
  expect(backward).toEqual(replayDuelTo(seed, startedAt, batches, 10))
  expect(backward).not.toBe(previous)
  const discontinuous = seek(18)
  expect(discontinuous).toEqual(replayDuelTo(seed, startedAt, batches, 18))
  expect(discontinuous).not.toBe(backward)
})

it('uses a full replay for the settled end frame after a forward seek', () => {
  const startedAt = 1_000_000
  const seek = createDuelReplayCursor(11, startedAt, [])
  const beforeEnd = seek(DUEL_DURATION - 1)
  const end = seek(DUEL_DURATION)

  expect(end).toEqual(replayDuelTo(11, startedAt, [], DUEL_DURATION))
  expect(end).not.toBe(beforeEnd)
})

it('keeps version 1 duels on the legacy rules and defaults new duels to version 2', () => {
  expect(newDuel(7).version).toBe(2)
  expect(newDuel(7, 1).version).toBe(1)
  // Player two is strictly nearer, so only version 2 hands it the token.
  for (const [version, owner] of [
    [1, 0],
    [2, 1],
  ] as const) {
    const state = newDuel(42, version)
    state.tick = 10
    state.players[0].x = 4000
    state.players[1].x = 4600
    state.players[0].y = state.players[1].y = 3500
    state.tokens = [{ x: 4400, y: 3500, value: 10 }]
    step(state, 0, 0)
    expect(state.players[owner].collected).toBe(10)
    expect(state.players[1 - owner].collected).toBe(0)
  }
})
