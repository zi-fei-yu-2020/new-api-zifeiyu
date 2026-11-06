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
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as matchApi from '../api'
import type { MatchRun, MatchStatus } from '../api'
import {
  applyMatch,
  matchExposed,
  MATCH_LOST,
  MATCH_MODE_ENDLESS,
  MATCH_UNLOCK_REVEAL,
  newMatch,
} from '../engine'
import { useMatch3Run } from '../use-match3-run'

function runningRun(): MatchRun {
  const now = Date.now()
  return {
    id: 'endless-run',
    mode: 'endless',
    day: '2026-10-20',
    week: '2026-10-19',
    status: 'running',
    unlocks: MATCH_UNLOCK_REVEAL,
    level: 1,
    score: 0,
    started_at: now,
    updated_at: now,
    finished_at: 0,
    state: newMatch(31, MATCH_MODE_ENDLESS, MATCH_UNLOCK_REVEAL),
    server_time: now,
  }
}

// What the server answers: the run with every input after its cursor applied.
function authoritative(
  base: MatchRun,
  from: number,
  inputs: number[],
  status: MatchRun['status'] = 'running'
): MatchRun {
  const next = structuredClone(base)
  for (const word of inputs.slice(Math.max(0, base.state.inputs - from))) {
    applyMatch(next.state, word)
  }
  next.status = status
  next.score = next.state.score
  next.server_time = Date.now()
  return next
}

function httpError(status: number, retryAfter?: string) {
  return new AxiosError(
    'Request failed',
    AxiosError.ERR_BAD_REQUEST,
    undefined,
    undefined,
    {
      status,
      statusText: '',
      data: {},
      headers: retryAfter ? { 'retry-after': retryAfter } : {},
      config: {} as InternalAxiosRequestConfig,
    }
  )
}

function statusOf(run: MatchRun | null): MatchStatus {
  return { endless_run: run, daily_run: null } as MatchStatus
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-20T04:00:00Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// Picks the next exposed tile after letting the engine's minimum gap pass.
async function pickNext(result: { current: ReturnType<typeof useMatch3Run> }) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  const id = matchExposed(result.current.state)[0]
  let ok = false
  act(() => {
    ok = result.current.pick(id)
  })
  return { id, ok }
}

describe('useMatch3Run synchronization', () => {
  it('keeps every input queued while an acknowledgement is delayed and sends the rest from the new cursor', async () => {
    let resolve!: (run: MatchRun) => void
    const delayed = new Promise<MatchRun>((done) => {
      resolve = done
    })
    const initial = runningRun()
    const send = vi
      .spyOn(matchApi, 'sendMatchInputs')
      .mockReturnValueOnce(delayed)
      .mockImplementation(async (_id, from, inputs) =>
        authoritative(initial, from, inputs)
      )
    const { result } = renderHook(() => useMatch3Run('endless', vi.fn()))
    act(() => result.current.install(initial))
    await pickNext(result)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0].slice(1, 4)).toEqual([
      0,
      [expect.any(Number)],
      false,
    ])

    await pickNext(result)
    await act(async () => {
      resolve(authoritative(initial, 0, send.mock.calls[0][2]))
      await delayed
    })
    expect(result.current.state.inputs).toBe(2)
    expect(result.current.state.tray).toHaveLength(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][1]).toBe(1)
    expect(send.mock.calls[1][2]).toHaveLength(1)
    expect(result.current.connection).toBe('online')
  })

  it('does not send anything while no input is queued', async () => {
    const send = vi.spyOn(matchApi, 'sendMatchInputs')
    const { result } = renderHook(() => useMatch3Run('endless', vi.fn()))
    act(() => result.current.install(runningRun()))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(send).not.toHaveBeenCalled()
  })

  it('does not record an illegal pick and never sends it', async () => {
    const send = vi.spyOn(matchApi, 'sendMatchInputs')
    const { result } = renderHook(() => useMatch3Run('endless', vi.fn()))
    act(() => result.current.install(runningRun()))
    const exposed = matchExposed(result.current.state)
    const covered = result.current.state.tiles.find(
      (t) => !exposed.includes(t.id)
    )
    expect(covered).toBeDefined()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    let ok = true
    act(() => {
      ok = result.current.pick(covered?.id ?? -1)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })

    expect(ok).toBe(false)
    expect(result.current.state.inputs).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('recovers the authoritative run after an acknowledgement behind the local cursor', async () => {
    const initial = runningRun()
    const recovered = authoritative(initial, 0, [])
    const send = vi
      .spyOn(matchApi, 'sendMatchInputs')
      .mockImplementationOnce(async (_id, from, inputs) =>
        authoritative(initial, from, inputs)
      )
      .mockImplementationOnce(async () => recovered)
    const status = vi
      .spyOn(matchApi, 'getMatchStatus')
      .mockResolvedValue(statusOf(recovered))
    const { result } = renderHook(() => useMatch3Run('endless', vi.fn()))
    act(() => result.current.install(initial))
    await pickNext(result)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    await pickNext(result)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(send).toHaveBeenCalledTimes(2)
    expect(result.current.connection).toBe('reconnecting')
    expect(status).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(status).toHaveBeenCalledTimes(1)
    expect(result.current.state.inputs).toBe(0)
    expect(result.current.connection).toBe('online')
  })

  it('flushes queued inputs before recovering the run after the tab becomes visible again', async () => {
    const initial = runningRun()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const send = vi
      .spyOn(matchApi, 'sendMatchInputs')
      .mockImplementation(async (_id, from, inputs) =>
        authoritative(initial, from, inputs)
      )
    const status = vi
      .spyOn(matchApi, 'getMatchStatus')
      .mockImplementation(async () => statusOf(authoritative(initial, 0, [])))
    const { result } = renderHook(() => useMatch3Run('endless', vi.fn()))
    act(() => result.current.install(initial))
    await pickNext(result)

    act(() => {
      hidden.mockReturnValue(true)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(send).not.toHaveBeenCalled()

    await act(async () => {
      hidden.mockReturnValue(false)
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][2]).toHaveLength(1)
    expect(status).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(status).toHaveBeenCalledTimes(1)
  })

  it('aborts the old request and ignores its late answer when the same run is installed again', async () => {
    let resolve!: (run: MatchRun) => void
    const delayed = new Promise<MatchRun>((done) => {
      resolve = done
    })
    const send = vi.spyOn(matchApi, 'sendMatchInputs').mockReturnValue(delayed)
    const finished = vi.fn()
    const initial = runningRun()
    const { result } = renderHook(() => useMatch3Run('endless', finished))
    act(() => result.current.install(initial))
    await pickNext(result)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    act(() => result.current.install(initial))
    expect(send.mock.calls[0][4]?.aborted).toBe(true)
    await act(async () => {
      resolve({ ...initial, status: 'lost' })
      await delayed
    })

    expect(result.current.run?.status).toBe('running')
    expect(finished).not.toHaveBeenCalled()
  })
})

describe('useMatch3Run transient failures', () => {
  it('holds the same batch back for Retry-After after a 429 and then resends it', async () => {
    const initial = runningRun()
    const send = vi
      .spyOn(matchApi, 'sendMatchInputs')
      .mockRejectedValueOnce(httpError(429, '4'))
      .mockImplementation(async (_id, from, inputs) =>
        authoritative(initial, from, inputs)
      )
    const { result } = renderHook(() => useMatch3Run('endless', vi.fn()))
    act(() => result.current.install(initial))
    await pickNext(result)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(result.current.connection).toBe('reconnecting')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(send).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][1]).toBe(0)
    expect(send.mock.calls[1][2]).toEqual(send.mock.calls[0][2])
    expect(result.current.connection).toBe('online')
  })

  it('retries after a network failure without recovering the run', async () => {
    const initial = runningRun()
    const send = vi
      .spyOn(matchApi, 'sendMatchInputs')
      .mockRejectedValueOnce(new AxiosError('Network Error'))
      .mockImplementation(async (_id, from, inputs) =>
        authoritative(initial, from, inputs)
      )
    const status = vi.spyOn(matchApi, 'getMatchStatus')
    const { result } = renderHook(() => useMatch3Run('endless', vi.fn()))
    act(() => result.current.install(initial))
    await pickNext(result)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })

    expect(send).toHaveBeenCalledTimes(2)
    expect(status).not.toHaveBeenCalled()
    expect(result.current.state.inputs).toBe(1)
  })

  it('falls back to recovery when the server rejects the same batch twice', async () => {
    const initial = runningRun()
    const send = vi
      .spyOn(matchApi, 'sendMatchInputs')
      .mockRejectedValue(httpError(200))
    const status = vi
      .spyOn(matchApi, 'getMatchStatus')
      .mockResolvedValue(statusOf(authoritative(initial, 0, [])))
    const { result } = renderHook(() => useMatch3Run('endless', vi.fn()))
    act(() => result.current.install(initial))
    await pickNext(result)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })

    expect(send).toHaveBeenCalledTimes(2)
    expect(status).toHaveBeenCalledTimes(1)
    expect(result.current.state.inputs).toBe(0)
  })
})

describe('useMatch3Run lifecycle', () => {
  it('reports a lost run once when the server ends it', async () => {
    const initial = runningRun()
    const finished = vi.fn()
    vi.spyOn(matchApi, 'sendMatchInputs').mockImplementation(
      async (_id, from, inputs) => {
        const lost = authoritative(initial, from, inputs, 'lost')
        lost.state.status = MATCH_LOST
        return lost
      }
    )
    const { result } = renderHook(() => useMatch3Run('endless', finished))
    act(() => result.current.install(initial))
    await pickNext(result)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })

    expect(finished).toHaveBeenCalledTimes(1)
    expect(finished.mock.calls[0][0].status).toBe('lost')
    expect(result.current.active).toBe(false)
  })

  it('submits queued inputs together with the quit and reports completion once', async () => {
    const initial = runningRun()
    const finished = vi.fn()
    const send = vi
      .spyOn(matchApi, 'sendMatchInputs')
      .mockImplementation(async (_id, from, inputs, quit) =>
        authoritative(initial, from, inputs, quit ? 'abandoned' : 'running')
      )
    const { result } = renderHook(() => useMatch3Run('endless', finished))
    act(() => result.current.install(initial))
    await pickNext(result)

    await act(async () => {
      await result.current.quit()
      await result.current.quit()
    })

    expect(send.mock.calls[0][2]).toHaveLength(1)
    expect(send.mock.calls[0][3]).toBe(true)
    expect(finished).toHaveBeenCalledTimes(1)
    expect(result.current.run?.status).toBe('abandoned')
    expect(result.current.active).toBe(false)
  })

  it('still sends the quit after a recovery re-installs the same run', async () => {
    const initial = runningRun()
    const recovered = authoritative(initial, 0, [])
    const send = vi
      .spyOn(matchApi, 'sendMatchInputs')
      .mockImplementation(async (_id, from, inputs, quit) =>
        authoritative(initial, from, inputs, quit ? 'abandoned' : 'running')
      )
      .mockImplementationOnce(async (_id, from, inputs) =>
        authoritative(initial, from, inputs)
      )
      .mockImplementationOnce(async () => recovered)
    const status = vi
      .spyOn(matchApi, 'getMatchStatus')
      .mockResolvedValue(statusOf(recovered))
    const finished = vi.fn()
    const { result } = renderHook(() => useMatch3Run('endless', finished))
    act(() => result.current.install(initial))
    await pickNext(result)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    await pickNext(result)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    await act(async () => {
      await result.current.quit()
    })

    expect(status).toHaveBeenCalledOnce()
    expect(send.mock.calls.at(-1)?.[3]).toBe(true)
    expect(result.current.run?.status).toBe('abandoned')
    expect(finished).toHaveBeenCalledTimes(1)
  })

  it('keeps synchronizing while paused but refuses actions and freezes the clock', async () => {
    const initial = runningRun()
    const send = vi
      .spyOn(matchApi, 'sendMatchInputs')
      .mockImplementation(async (_id, from, inputs) =>
        authoritative(initial, from, inputs)
      )
    const { result } = renderHook(() => useMatch3Run('endless', vi.fn()))
    act(() => result.current.install(initial))
    await pickNext(result)
    act(() => result.current.setPaused(true))
    const frozen = result.current.tick()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    let whilePaused = true
    act(() => {
      whilePaused = result.current.pick(matchExposed(result.current.state)[0])
    })

    expect(send).toHaveBeenCalledTimes(1)
    expect(result.current.tick()).toBe(frozen)
    expect(whilePaused).toBe(false)
  })

  it('resigns a running run and installs the newly started one on restart', async () => {
    const initial = runningRun()
    const fresh = { ...runningRun(), id: 'second-run' }
    const send = vi
      .spyOn(matchApi, 'sendMatchInputs')
      .mockImplementation(async (_id, from, inputs, quit) =>
        authoritative(initial, from, inputs, quit ? 'abandoned' : 'running')
      )
    const start = vi.spyOn(matchApi, 'startMatch').mockResolvedValue(fresh)
    const { result } = renderHook(() => useMatch3Run('endless', vi.fn()))
    act(() => result.current.install(initial))

    await act(async () => {
      await result.current.restart()
    })

    expect(send.mock.calls[0][3]).toBe(true)
    expect(start).toHaveBeenCalledWith('endless')
    expect(result.current.run?.id).toBe('second-run')
    expect(result.current.active).toBe(true)
    expect(result.current.state.inputs).toBe(0)
  })

  it('rejects restart with the start error so the caller can report it', async () => {
    const initial = { ...runningRun(), status: 'lost' as const }
    vi.spyOn(matchApi, 'startMatch').mockRejectedValue(new Error('closed'))
    const { result } = renderHook(() => useMatch3Run('endless', vi.fn()))
    act(() => result.current.install(initial))

    await expect(result.current.restart()).rejects.toThrow('closed')
  })
})
