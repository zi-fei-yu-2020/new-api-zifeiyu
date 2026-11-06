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

import { api } from '@/lib/api'

import replayFixtures from '../../../../../../pkg/tokengame/testdata/match3-replays.json'
import { decodeMatchInput, matchExposed, MATCH_COMPLETED } from '../engine'
import { useMatch3Store } from '../store'
import { useMatch3Local } from '../use-match3-local'

const midGame = replayFixtures[4]
const longRun = replayFixtures[7]

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  useMatch3Store.setState({ byUser: {} })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function saveOf(fixture: (typeof replayFixtures)[number], count?: number) {
  return {
    seed: fixture.seed,
    mode: fixture.mode,
    unlocks: fixture.unlocks,
    inputs: fixture.inputs.slice(0, count),
  }
}

describe('useMatch3Local', () => {
  it('records a legal pick, saves it for the user and refuses a covered tile', () => {
    const { result } = renderHook(() => useMatch3Local(7))
    const exposed = matchExposed(result.current.state)
    const covered = result.current.state.tiles.find(
      (t) => !exposed.includes(t.id)
    )
    expect(covered).toBeDefined()

    act(() => vi.advanceTimersByTime(500))
    let ok = false
    act(() => {
      ok = result.current.pick(exposed[0])
    })
    act(() => vi.advanceTimersByTime(500))
    let refused = true
    act(() => {
      refused = result.current.pick(covered?.id ?? -1)
    })

    expect(ok).toBe(true)
    expect(refused).toBe(false)
    expect(result.current.state.tray).toEqual([exposed[0]])
    const saved = useMatch3Store.getState().byUser['7'].saved
    expect(saved?.inputs).toHaveLength(1)
    expect(decodeMatchInput(saved?.inputs[0] ?? -1)).toEqual({
      op: 1,
      arg: exposed[0],
      dt: 5,
    })
  })

  it('restores a saved practice game by replaying it and makes no network call', () => {
    const get = vi.spyOn(api, 'get')
    const post = vi.spyOn(api, 'post')
    useMatch3Store.getState().setSaved(7, saveOf(midGame))

    const { result } = renderHook(() => useMatch3Local(7))

    expect(result.current.state).toEqual(midGame.state)
    expect(get).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('starts a new game and never trusts a tampered save', () => {
    const tampered = saveOf(midGame)
    tampered.inputs = [...tampered.inputs.slice(0, -1), 1 << 18]
    useMatch3Store.getState().setSaved(7, tampered)

    const { result } = renderHook(() => useMatch3Local(7))

    expect(result.current.state.inputs).toBe(0)
    expect(result.current.state.score).toBe(0)
  })

  it("does not load another user's save", () => {
    useMatch3Store.getState().setSaved(8, saveOf(midGame))

    const { result } = renderHook(() => useMatch3Local(7))

    expect(result.current.state.inputs).toBe(0)
  })

  it('stops the game clock while paused and refuses actions until resumed', () => {
    const { result } = renderHook(() => useMatch3Local(7))
    const id = matchExposed(result.current.state)[0]

    act(() => vi.advanceTimersByTime(300))
    act(() => result.current.setPaused(true))
    const frozen = result.current.tick()
    act(() => vi.advanceTimersByTime(60_000))
    let whilePaused = true
    act(() => {
      whilePaused = result.current.pick(id)
    })

    expect(result.current.paused).toBe(true)
    expect(result.current.tick()).toBe(frozen)
    expect(whilePaused).toBe(false)

    act(() => result.current.setPaused(false))
    act(() => vi.advanceTimersByTime(300))
    let resumed = false
    act(() => {
      resumed = result.current.pick(id)
    })

    expect(resumed).toBe(true)
    expect(result.current.tick()).toBe(frozen + 3)
  })

  it('does not count a hidden tab toward the combo clock', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const { result } = renderHook(() => useMatch3Local(7))
    act(() => vi.advanceTimersByTime(200))

    act(() => {
      hidden.mockReturnValue(true)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    act(() => vi.advanceTimersByTime(30_000))
    act(() => {
      hidden.mockReturnValue(false)
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(result.current.tick()).toBe(2)
  })

  it('records the best level, clears the save and goes inactive when the game is won', () => {
    const last = decodeMatchInput(longRun.inputs.at(-1) ?? -1)
    useMatch3Store.getState().setSaved(7, saveOf(longRun, -1))
    const { result } = renderHook(() => useMatch3Local(7, longRun.unlocks))
    expect(result.current.state.status).toBe(0)

    act(() => vi.advanceTimersByTime(1000))
    act(() => {
      result.current.pick(last.arg)
    })

    expect(result.current.state.status).toBe(MATCH_COMPLETED)
    expect(result.current.active).toBe(false)
    const prefs = useMatch3Store.getState().byUser['7']
    expect(prefs.best).toBe(30)
    expect(prefs.saved).toBeNull()
  })

  it('clears the save on quit and deals a fresh game on restart', () => {
    useMatch3Store.getState().setSaved(7, saveOf(midGame))
    const { result } = renderHook(() => useMatch3Local(7))

    act(() => result.current.quit())

    expect(result.current.active).toBe(false)
    expect(useMatch3Store.getState().byUser['7'].saved).toBeNull()

    act(() => {
      void result.current.restart()
    })

    expect(result.current.active).toBe(true)
    expect(result.current.state.inputs).toBe(0)
  })

  it('keeps playing when storage writes throw', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    const { result } = renderHook(() => useMatch3Local(7))
    const id = matchExposed(result.current.state)[0]

    act(() => vi.advanceTimersByTime(300))
    act(() => {
      result.current.pick(id)
    })

    expect(result.current.state.tray).toEqual([id])
  })
})
