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

import boardFixtures from '../../../../../../pkg/tokengame/testdata/match3-boards.json'
import replayFixtures from '../../../../../../pkg/tokengame/testdata/match3-replays.json'
import {
  applyMatch,
  decodeMatchInput,
  encodeMatchInput,
  generateMatchLevel,
  isMatchDone,
  MATCH_MODE_ENDLESS,
  MATCH_OP_PICK,
  MATCH_OP_SHUFFLE,
  matchLevelSeed,
  newMatch,
  validMatchInput,
} from '../engine'

describe('match3 board generation parity', () => {
  for (const fixture of boardFixtures) {
    it(`matches the Go board for seed ${fixture.seed} level ${fixture.level}`, () => {
      const { tiles } = generateMatchLevel(
        matchLevelSeed(fixture.seed, fixture.level),
        fixture.level
      )
      expect(tiles).toEqual(fixture.tiles)
    })
  }

  it('covers the uint32 wraparound seed at the deepest level', () => {
    expect(
      boardFixtures.some((f) => f.seed === 4294967295 && f.level === 30)
    ).toBe(true)
  })
})

describe('match3 replay parity', () => {
  for (const fixture of replayFixtures) {
    it(`matches the Go state for seed ${fixture.seed} mode ${fixture.mode} after ${fixture.inputs.length} inputs`, () => {
      const state = newMatch(fixture.seed, fixture.mode, fixture.unlocks)
      for (const input of fixture.inputs) {
        expect(applyMatch(state, input)).toBe(true)
      }
      expect(state).toEqual(fixture.state)
    })
  }

  for (const fixture of replayFixtures.filter((f) => f.state.status !== 0)) {
    it(`leaves the finished run of seed ${fixture.seed} unchanged when more inputs arrive`, () => {
      const state = newMatch(fixture.seed, fixture.mode, fixture.unlocks)
      for (const input of fixture.inputs) applyMatch(state, input)
      expect(isMatchDone(state)).toBe(true)
      const before = structuredClone(state)

      expect(applyMatch(state, encodeMatchInput(MATCH_OP_PICK, 0, 5))).toBe(
        false
      )
      expect(state).toEqual(before)
    })
  }
})

describe('match3 input encoding', () => {
  it('round-trips op, arg and dt through one word', () => {
    const input = encodeMatchInput(MATCH_OP_PICK, 127, 255)
    expect(decodeMatchInput(input)).toEqual({ op: 1, arg: 127, dt: 255 })
  })

  it('rejects malformed words without touching the state', () => {
    const state = newMatch(1, MATCH_MODE_ENDLESS, 0)
    const before = structuredClone(state)

    expect(validMatchInput(MATCH_OP_SHUFFLE + 1)).toBe(false)
    expect(applyMatch(state, MATCH_OP_SHUFFLE + 1)).toBe(false)
    expect(applyMatch(state, -1)).toBe(false)
    expect(applyMatch(state, 1 << 18)).toBe(false)
    expect(state).toEqual(before)
  })
})
