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
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import * as pvpApi from '../api'
import type { PvPMatchView } from '../api'
import { advanceDuel, newDuel } from '../duel-engine'
import { useDuelSession } from '../use-duel-session'

function playableMatch(): PvPMatchView {
  const now = Date.now()
  return {
    id: 'duel-1',
    mode: 'ranked',
    status: 'playing',
    stake: 500000,
    seed: 7,
    you: {
      slot: 1,
      secret: 'duel-secret',
      cursor: 0,
      seq: 0,
      score: 0,
      hp: 100,
    },
    opponent: {
      id: 2,
      name: 'rival',
      display_name: 'Rival',
      cursor: 0,
      score: 0,
      hp: 100,
    },
    state: newDuel(7),
    winner_slot: 0,
    you_delta_quota: null,
    invite_code: null,
    created_at: now,
    started_at: now,
    finished_at: 0,
    server_time: now,
  }
}

function authoritative(
  base: PvPMatchView,
  from: number,
  inputs: number[]
): PvPMatchView {
  const next = structuredClone(base)
  const state = structuredClone(base.state ?? newDuel(base.seed))
  advanceDuel(state, from + inputs.length, inputs, [])
  next.state = state
  next.you.cursor = from + inputs.length
  next.you.seq = base.you.seq + 1
  next.server_time = Date.now()
  next.opponent.cursor = state.players[1].cursor
  return next
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-27T04:00:00Z'))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('submits strictly sequenced signed batches and adopts the authoritative state', async () => {
  const initial = playableMatch()
  const submit = vi
    .spyOn(pvpApi, 'submitPvPInput')
    .mockImplementation(async (_id, _seq, from, inputs) =>
      authoritative(initial, from, inputs)
    )
  const { result } = renderHook(() => useDuelSession(vi.fn()))
  act(() => {
    result.current.install(initial)
    result.current.input.current.direction = 3
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1300)
  })
  // One batch per 600 ms synchronization window, each strictly sequenced and
  // continuing at the previously acknowledged cursor.
  expect(submit).toHaveBeenCalledTimes(2)
  const [matchId, seq, from, inputs, quit, sig] = submit.mock.calls[0]
  expect(matchId).toBe('duel-1')
  expect(seq).toBe(1)
  expect(from).toBe(0)
  expect(quit).toBe(false)
  expect(inputs.length).toBeGreaterThan(3)
  expect(inputs.every((value: number) => value === 3)).toBe(true)
  expect(sig).toMatch(/^[0-9a-f]{64}$/)
  const second = submit.mock.calls[1]
  expect(second[1]).toBe(2)
  expect(second[2]).toBe(inputs.length)
  expect(second[5]).toMatch(/^[0-9a-f]{64}$/)
  expect(result.current.state.current.tick).toBeGreaterThanOrEqual(
    inputs.length
  )
  expect(result.current.connection).toBe('online')
})

it('recovers with the authoritative duel after a rejected packet', async () => {
  const initial = playableMatch()
  const submit = vi
    .spyOn(pvpApi, 'submitPvPInput')
    .mockRejectedValueOnce(
      new Error('PvP input rejected. Refresh the duel and retry')
    )
    .mockImplementation(async (_id, _seq, from, inputs) =>
      authoritative(initial, from, inputs)
    )
  const recovered = authoritative(initial, 0, [])
  const fetchMatch = vi
    .spyOn(pvpApi, 'getPvPMatch')
    .mockResolvedValue(recovered)
  const { result } = renderHook(() => useDuelSession(vi.fn()))
  act(() => {
    result.current.install(initial)
    result.current.input.current.direction = 3
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1300)
  })
  expect(submit).toHaveBeenCalledOnce()
  // The next synchronization re-installs the authoritative duel instead of
  // replaying the rejected sequence number.
  expect(fetchMatch).toHaveBeenCalled()
  expect(result.current.connection).toBe('online')
  // The unacknowledged stream is rebased on the server's cursor, so the next
  // batch starts from zero instead of the rejected sequence.
  expect(result.current.state.current.players[0].cursor).toBe(0)
})

it('resigns with a final quit batch', async () => {
  const initial = playableMatch()
  const finished = authoritative(initial, 0, [])
  finished.status = 'finished'
  finished.winner_slot = 2
  const onFinish = vi.fn()
  const submit = vi
    .spyOn(pvpApi, 'submitPvPInput')
    .mockImplementation(async (_id, _seq, from, inputs, quit) =>
      quit ? finished : authoritative(initial, from, inputs)
    )
  const { result } = renderHook(() => useDuelSession(onFinish))
  act(() => {
    result.current.install(initial)
    result.current.input.current.direction = 3
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700)
  })
  await act(async () => {
    await result.current.quit()
  })
  const finalCall = submit.mock.calls.at(-1)
  expect(finalCall?.[4]).toBe(true)
  expect(onFinish).toHaveBeenCalled()
  expect(result.current.match?.status).toBe('finished')
})

it('keeps quit requested when recovery installs the same match while quit awaits', async () => {
  const initial = playableMatch()
  const recovered = authoritative(initial, 0, [])
  let resolveRecovery!: (match: PvPMatchView) => void
  vi.spyOn(pvpApi, 'getPvPMatch').mockImplementation(
    () =>
      new Promise<PvPMatchView>((resolve) => {
        resolveRecovery = resolve
      })
  )
  const finished = authoritative(initial, 0, [])
  finished.status = 'finished'
  finished.winner_slot = 2
  const submit = vi
    .spyOn(pvpApi, 'submitPvPInput')
    .mockRejectedValueOnce(new Error('Rejected packet'))
    .mockImplementation(async (_id, _seq, from, inputs, quit) =>
      quit ? finished : authoritative(initial, from, inputs)
    )
  const { result } = renderHook(() => useDuelSession(vi.fn()))
  act(() => {
    result.current.install(initial)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200)
  })
  expect(pvpApi.getPvPMatch).toHaveBeenCalledOnce()

  let quitting!: Promise<void>
  act(() => {
    quitting = result.current.quit()
  })
  await act(async () => {
    resolveRecovery(recovered)
    await quitting
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600)
  })

  // quit() began while the recovery GET was awaiting. Its same-match install
  // must not clear the quit flag before the following input submission.
  expect(submit.mock.calls.at(-1)?.[4]).toBe(true)
  expect(result.current.match?.status).toBe('finished')
})

it('catches up with neutral batches after falling behind the server clock', async () => {
  const initial = playableMatch()
  // The duel started a minute ago, so the cursor is ~600 ticks behind while
  // the server has already advanced far past every unsubmitted tick.
  initial.started_at = Date.now() - 60_000
  const submit = vi
    .spyOn(pvpApi, 'submitPvPInput')
    .mockImplementation(async (_id, _seq, from, inputs) =>
      authoritative(initial, from, inputs)
    )
  const { result } = renderHook(() => useDuelSession(vi.fn()))
  act(() => {
    result.current.install(initial)
    result.current.input.current.direction = 3
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1300)
  })
  expect(submit).toHaveBeenCalled()
  const [matchId, seq, from, inputs] = submit.mock.calls[0]
  expect(matchId).toBe('duel-1')
  expect(seq).toBe(1)
  expect(from).toBe(0)
  expect(inputs.length).toBe(300)
  expect(inputs.every((value: number) => value === 0)).toBe(true)
  // The neutral catch-up batches close the gap instead of stalling forever.
  expect(submit.mock.calls[1][2]).toBe(300)
})

function transientError(status: number, retryAfter?: string) {
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

it('counts down to the future start and neither simulates nor submits before it', async () => {
  const initial = playableMatch()
  initial.started_at = initial.server_time + 4000
  const submit = vi
    .spyOn(pvpApi, 'submitPvPInput')
    .mockImplementation(async (_id, _seq, from, inputs) =>
      authoritative(initial, from, inputs)
    )
  const { result } = renderHook(() => useDuelSession(vi.fn()))
  act(() => {
    result.current.install(initial)
    result.current.input.current.direction = 3
  })
  expect(result.current.countdown).toBe(4)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(submit).not.toHaveBeenCalled()
  expect(result.current.state.current.tick).toBe(0)
  expect(result.current.countdown).toBe(1)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(result.current.countdown).toBe(0)
  expect(submit).toHaveBeenCalled()
  expect(submit.mock.calls[0][2]).toBe(0)
})

it('keeps queued inputs and resends the same sequence after a 429', async () => {
  const initial = playableMatch()
  const fetchMatch = vi.spyOn(pvpApi, 'getPvPMatch')
  const submit = vi
    .spyOn(pvpApi, 'submitPvPInput')
    .mockRejectedValueOnce(transientError(429, '1'))
    .mockImplementation(async (_id, _seq, from, inputs) =>
      authoritative(initial, from, inputs)
    )
  const { result } = renderHook(() => useDuelSession(vi.fn()))
  act(() => {
    result.current.install(initial)
    result.current.input.current.direction = 3
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700)
  })
  expect(submit).toHaveBeenCalledTimes(1)
  expect(result.current.connection).toBe('reconnecting')
  // Retry-After holds the next attempt back instead of hammering the limiter.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600)
  })
  expect(submit).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600)
  })
  expect(submit).toHaveBeenCalledTimes(2)
  const [first, retry] = submit.mock.calls
  expect(retry[1]).toBe(first[1])
  expect(retry[2]).toBe(0)
  expect(retry[3].length).toBeGreaterThanOrEqual(first[3].length)
  expect(retry[3].slice(0, first[3].length)).toEqual(first[3])
  expect(fetchMatch).not.toHaveBeenCalled()
  expect(result.current.state.current.players[0].cursor).toBeGreaterThanOrEqual(
    first[3].length
  )
})

it('sends the resignation with the fresh sequence after a rejected packet forced recovery', async () => {
  const initial = playableMatch()
  const recovered = authoritative(initial, 0, [])
  recovered.you.seq = 5
  const finished = structuredClone(recovered)
  finished.status = 'finished'
  finished.winner_slot = 2
  vi.spyOn(pvpApi, 'getPvPMatch').mockResolvedValue(recovered)
  const submit = vi
    .spyOn(pvpApi, 'submitPvPInput')
    .mockImplementation(async (_id, seq, _from, _inputs, quit) => {
      if (seq !== 6) throw new Error('PvP input rejected')
      return quit ? finished : recovered
    })
  const onFinish = vi.fn()
  const { result } = renderHook(() => useDuelSession(onFinish))
  act(() => {
    result.current.install(initial)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700)
  })
  expect(submit).toHaveBeenCalledOnce()
  // Install re-seeded the sequence at 5 but the failed packet used 1; the
  // resign must refetch first and then go out as seq 6 instead of looping.
  await act(async () => {
    await result.current.quit()
  })
  const last = submit.mock.calls.at(-1)
  expect(last?.[1]).toBe(6)
  expect(last?.[4]).toBe(true)
  expect(result.current.match?.status).toBe('finished')
  expect(onFinish).toHaveBeenCalled()
})
