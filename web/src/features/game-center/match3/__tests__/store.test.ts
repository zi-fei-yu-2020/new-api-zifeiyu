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
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import replayFixtures from '../../../../../../pkg/tokengame/testdata/match3-replays.json'
import { MATCH_MODE_ENDLESS, newMatch } from '../engine'
import {
  DEFAULT_MATCH3_PREFS,
  restoreMatchSave,
  useMatch3LowMotion,
  useMatch3Store,
} from '../store'

const midGame = replayFixtures[4]
const withRejections = replayFixtures[6]

beforeEach(() => {
  localStorage.clear()
  useMatch3Store.setState({ byUser: {} })
})
afterEach(() => {
  cleanup()
  localStorage.clear()
})

function saveOf(fixture: (typeof replayFixtures)[number]) {
  return {
    seed: fixture.seed,
    mode: fixture.mode,
    unlocks: fixture.unlocks,
    inputs: fixture.inputs,
  }
}

describe('match3 store persistence', () => {
  it('keeps preferences and the saved game apart for two users', () => {
    const store = useMatch3Store.getState()
    store.setMuted(1, false)
    store.setLowMotion(1, 'on')
    store.setSaved(2, saveOf(midGame))

    const state = useMatch3Store.getState().byUser
    expect(state['1']).toMatchObject({
      muted: false,
      lowMotion: 'on',
      saved: null,
    })
    expect(state['2']).toMatchObject({
      ...DEFAULT_MATCH3_PREFS,
      saved: saveOf(midGame),
    })
  })

  it('records only a better best level', () => {
    const store = useMatch3Store.getState()
    store.recordBest(1, 4)
    store.recordBest(1, 2)

    expect(useMatch3Store.getState().byUser['1'].best).toBe(4)
  })

  it('starts muted with automatic motion for a user without saved preferences', () => {
    expect(DEFAULT_MATCH3_PREFS).toMatchObject({
      muted: true,
      lowMotion: 'auto',
      saved: null,
    })
  })

  it('rehydrates saved preferences from storage', async () => {
    localStorage.setItem(
      'match3-local',
      JSON.stringify({
        version: 1,
        state: {
          byUser: { '7': { ...DEFAULT_MATCH3_PREFS, best: 5, muted: false } },
        },
      })
    )

    await useMatch3Store.persist.rehydrate()

    expect(useMatch3Store.getState().byUser['7']).toMatchObject({
      best: 5,
      muted: false,
    })
  })

  it('ignores corrupt JSON in storage and keeps working', async () => {
    localStorage.setItem('match3-local', '{not json')

    await useMatch3Store.persist.rehydrate()
    useMatch3Store.getState().setMuted(1, false)

    expect(useMatch3Store.getState().byUser['1'].muted).toBe(false)
  })

  it('discards a stored state written by another version', async () => {
    localStorage.setItem(
      'match3-local',
      JSON.stringify({ version: 0, state: { byUser: { '7': { best: 9 } } } })
    )

    await useMatch3Store.persist.rehydrate()

    expect(useMatch3Store.getState().byUser).toEqual({})
  })

  it('repairs a single bad field and drops an entry that is not an object', async () => {
    localStorage.setItem(
      'match3-local',
      JSON.stringify({
        version: 1,
        state: {
          byUser: {
            '7': {
              best: 3,
              lowMotion: 'sideways',
              muted: 'no',
              saved: { seed: -1 },
            },
            '8': 'garbage',
            abc: { ...DEFAULT_MATCH3_PREFS },
          },
        },
      })
    )

    await useMatch3Store.persist.rehydrate()

    expect(useMatch3Store.getState().byUser).toEqual({
      '7': { best: 3, lowMotion: 'auto', muted: true, saved: null },
    })
  })

  it('keeps the in-memory state when writing to storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })

    expect(() => useMatch3Store.getState().setMuted(1, false)).not.toThrow()
    expect(useMatch3Store.getState().byUser['1'].muted).toBe(false)
  })
})

describe('restoreMatchSave', () => {
  it('rebuilds a practice game by replaying the saved inputs', () => {
    const restored = restoreMatchSave(saveOf(midGame))

    expect(restored?.state).toEqual(midGame.state)
    expect(restored?.inputs).toEqual(midGame.inputs)
  })

  it('discards a save whose replay contains a rejected action', () => {
    expect(restoreMatchSave(saveOf(withRejections))).toBeNull()
  })

  it('discards a save whose unlocks were raised to afford a skill', () => {
    const fresh = newMatch(5, MATCH_MODE_ENDLESS, 0)
    const reveal = (1 << 10) | 2
    expect(
      restoreMatchSave({
        seed: fresh.seed,
        mode: 0,
        unlocks: 0,
        inputs: [reveal],
      })
    ).toBeNull()
    expect(
      restoreMatchSave({ seed: 5, mode: 0, unlocks: 99, inputs: [] })
    ).toBeNull()
  })

  it('discards a finished run, a daily mode save and malformed shapes', () => {
    const finished = replayFixtures[5]

    expect(restoreMatchSave(saveOf(finished))).toBeNull()
    expect(restoreMatchSave({ ...saveOf(midGame), mode: 1 })).toBeNull()
    expect(
      restoreMatchSave({ ...saveOf(midGame), inputs: [1 << 18] })
    ).toBeNull()
    expect(restoreMatchSave({ ...saveOf(midGame), inputs: [5] })).toBeNull()
    expect(restoreMatchSave({ ...saveOf(midGame), seed: 1.5 })).toBeNull()
    expect(restoreMatchSave('nonsense')).toBeNull()
    expect(restoreMatchSave(null)).toBeNull()
  })
})

describe('useMatch3LowMotion', () => {
  function mockReducedMotion(matches: boolean) {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        ({
          matches,
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList
    )
  }

  it('follows the system preference when set to auto', () => {
    mockReducedMotion(false)
    const quiet = renderHook(() => useMatch3LowMotion(1))
    expect(quiet.result.current).toBe(false)

    mockReducedMotion(true)
    const reduced = renderHook(() => useMatch3LowMotion(1))
    expect(reduced.result.current).toBe(true)
  })

  it('lets the player force low motion on or off against the system preference', () => {
    mockReducedMotion(true)
    useMatch3Store.getState().setLowMotion(1, 'off')
    const off = renderHook(() => useMatch3LowMotion(1))
    expect(off.result.current).toBe(false)

    mockReducedMotion(false)
    act(() => useMatch3Store.getState().setLowMotion(1, 'on'))
    const on = renderHook(() => useMatch3LowMotion(1))
    expect(on.result.current).toBe(true)
  })

  it('applies one user setting only to that user', () => {
    mockReducedMotion(false)
    useMatch3Store.getState().setLowMotion(1, 'on')

    expect(renderHook(() => useMatch3LowMotion(1)).result.current).toBe(true)
    expect(renderHook(() => useMatch3LowMotion(2)).result.current).toBe(false)
  })
})
