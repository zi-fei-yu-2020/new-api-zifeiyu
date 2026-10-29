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

import combatFixtures from '../../../../pkg/tokengame/testdata/combat-replays.json'
import fixtures from '../../../../pkg/tokengame/testdata/replays.json'
import sprintFixtures from '../../../../pkg/tokengame/testdata/sprint-replays.json'
import { isDone, newGame, step } from './engine'

describe('authoritative game replay contract', () => {
  it('keeps at least three replay fixtures for each solo engine version', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(3)
    expect(sprintFixtures.length).toBeGreaterThanOrEqual(3)
    expect(combatFixtures.length).toBeGreaterThanOrEqual(3)
  })

  for (const fixture of [...fixtures, ...sprintFixtures, ...combatFixtures]) {
    it(`matches the Go replay for seed ${fixture.seed} after ${fixture.inputs.length} inputs`, () => {
      const state = newGame(fixture.seed, fixture.state.version)
      for (const input of fixture.inputs) step(state, input)
      expect(state).toEqual(fixture.state)
      if (isDone(state)) {
        const end = structuredClone(state)
        step(state, 3)
        expect(state).toEqual(end)
      }
    })
  }
})

it('fires at the advertised rate and never targets the same enemy twice in a volley', () => {
  for (let level = 0; level <= 3; level++) {
    const state = newGame(42)
    for (let upgrade = 0; upgrade < level; upgrade++) {
      state.tick = (upgrade + 1) * 200
      state.clock_tick = state.tick
      step(state, 2 << 5)
    }
    expect(state.speed).toBe(140 + 35 * level)
    state.tick = 0
    state.clock_tick = 0
    state.attack_charge = 0
    let shots = 0
    for (let tick = 0; tick < 160; tick++) {
      state.enemies = [{ id: 1, x: 6000, y: 3500, hp: 1000, kind: 0 }]
      step(state, 0)
      if (state.beam_until === state.tick + 2) shots++
    }
    expect(shots).toBe(40 + 10 * level)
  }
  const state = newGame(42)
  state.tick = 3
  state.clock_tick = 3
  state.attack_charge = 300
  state.extra_targets = 2
  state.enemies = [
    { id: 1, x: 5500, y: 3500, hp: 40, kind: 0 },
    { id: 2, x: 5500, y: 3500, hp: 40, kind: 0 },
    { id: 3, x: 5800, y: 3500, hp: 40, kind: 0 },
    { id: 4, x: 9000, y: 3500, hp: 40, kind: 0 },
  ]
  step(state, 0)
  expect(state.enemies.map((enemy) => enemy.hp)).toEqual([37, 37, 37, 40])
  expect(state.beam_targets).toHaveLength(3)
})
