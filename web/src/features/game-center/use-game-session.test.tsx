import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import * as gameApi from './api'
import type { GameRun, GameStatus } from './api'
import { gameCursor, MAX_INPUT_BATCH, newGame, step } from './engine'
import { useGameSession } from './use-game-session'

function playableRun(): GameRun {
  const state = newGame(42)
  state.hp = 10000
  state.max_hp = 10000
  return {
    id: 'same-daily-run',
    day: '2026-10-20',
    week: '2026-10-19',
    started_at: Date.now(),
    finished_at: 0,
    status: 'running',
    score: 0,
    quota_awarded: 0,
    reward_version: 2,
    first_token_quota: 2500000,
    subsequent_token_quota: 250000,
    state,
    server_time: Date.now(),
  }
}

function checkpoint(run: GameRun, inputs: number[]): GameRun {
  const next = structuredClone(run)
  for (const value of inputs) step(next.state, value)
  next.server_time = Date.now()
  return next
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-20T04:00:00Z'))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('continues simulating and retains every input during an eight-second response delay', async () => {
  let resolve!: (run: GameRun) => void
  const delayed = new Promise<GameRun>((done) => {
    resolve = done
  })
  const send = vi.spyOn(gameApi, 'sendInputs').mockReturnValue(delayed)
  const finished = vi.fn()
  const initial = playableRun()
  const { result } = renderHook(() => useGameSession(finished))
  act(() => {
    result.current.install(initial)
    result.current.input.current.direction = 3
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000)
  })
  expect(gameCursor(result.current.state.current)).toBe(79)
  expect(result.current.connection).toBe('reconnecting')
  expect(send).toHaveBeenCalledTimes(1)
  const firstInputs = send.mock.calls[0][2]
  const acknowledged = checkpoint(initial, firstInputs)
  await act(async () => {
    resolve(acknowledged)
    await delayed
  })
  expect(gameCursor(result.current.state.current)).toBe(79)
  send.mockImplementation(async (_id, from, inputs) => {
    expect(from).toBe(firstInputs.length)
    return checkpoint(acknowledged, inputs)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(send.mock.calls[1][2].length).toBeGreaterThan(50)
  expect(gameCursor(result.current.state.current)).toBe(99)
  expect(result.current.connection).toBe('online')
  expect(finished).not.toHaveBeenCalled()
})

it('retries the original unacknowledged prefix after a timeout without freezing gameplay', async () => {
  let reject!: (error: Error) => void
  const delayed = new Promise<GameRun>((_resolve, fail) => {
    reject = fail
  })
  const initial = playableRun()
  const send = vi
    .spyOn(gameApi, 'sendInputs')
    .mockReturnValueOnce(delayed)
    .mockImplementation(async (_id, _from, inputs) =>
      checkpoint(initial, inputs)
    )
  const { result } = renderHook(() => useGameSession(vi.fn()))
  act(() => {
    result.current.install(initial)
    result.current.input.current.direction = 3
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000)
    reject(new Error('timeout'))
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(send.mock.calls[1][1]).toBe(0)
  expect(send.mock.calls[1][2]).toHaveLength(99)
  expect(gameCursor(result.current.state.current)).toBe(99)
  expect(result.current.connection).toBe('online')
})

it('ignores a late response after the same run is reinstalled and aborts the old request', async () => {
  let resolve!: (run: GameRun) => void
  const delayed = new Promise<GameRun>((done) => {
    resolve = done
  })
  const send = vi.spyOn(gameApi, 'sendInputs').mockReturnValue(delayed)
  const initial = playableRun()
  const finished = vi.fn()
  const { result } = renderHook(() => useGameSession(finished))
  act(() => result.current.install(initial))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  const restored = checkpoint(initial, Array<number>(30).fill(3))
  act(() => {
    result.current.input.current.direction = 3
  })
  act(() => result.current.install(restored))
  expect(result.current.input.current.direction).toBe(3)
  expect(send.mock.calls[0][4]?.aborted).toBe(true)
  await act(async () => {
    resolve({ ...initial, status: 'defeated' })
    await delayed
  })
  expect(result.current.run?.status).toBe('running')
  expect(gameCursor(result.current.state.current)).toBe(30)
  expect(finished).not.toHaveBeenCalled()
})

it('keeps the game clock monotonic when the system clock jumps forward', async () => {
  vi.spyOn(gameApi, 'sendInputs').mockReturnValue(new Promise(() => {}))
  const { result } = renderHook(() => useGameSession(vi.fn()))
  act(() => result.current.install(playableRun()))
  vi.setSystemTime(new Date('2026-10-20T05:00:00Z'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(gameCursor(result.current.state.current)).toBe(9)
})

it('flushes buffered inputs immediately when the network returns instead of waiting for an old timeout', async () => {
  const initial = playableRun()
  const send = vi
    .spyOn(gameApi, 'sendInputs')
    .mockReturnValueOnce(new Promise(() => {}))
    .mockImplementation(async (_id, _from, inputs) =>
      checkpoint(initial, inputs)
    )
  const { result } = renderHook(() => useGameSession(vi.fn()))
  act(() => {
    result.current.install(initial)
    result.current.input.current.direction = 3
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000)
  })
  await act(async () => {
    window.dispatchEvent(new Event('online'))
  })
  expect(send.mock.calls[0][4]?.aborted).toBe(true)
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[1][1]).toBe(0)
  expect(send.mock.calls[1][2]).toHaveLength(79)
  expect(gameCursor(result.current.display)).toBe(79)
  expect(result.current.connection).toBe('online')
})

it('bounds offline input storage and visibly reports reconnection', async () => {
  const send = vi
    .spyOn(gameApi, 'sendInputs')
    .mockReturnValue(new Promise(() => {}))
  const { result } = renderHook(() => useGameSession(vi.fn()))
  act(() => result.current.install(playableRun()))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(35000)
  })
  expect(gameCursor(result.current.state.current)).toBe(MAX_INPUT_BATCH)
  expect(result.current.connection).toBe('reconnecting')
  expect(send).toHaveBeenCalledTimes(1)
})

it('submits unsent inputs before quitting and reports completion once', async () => {
  const initial = playableRun()
  const send = vi
    .spyOn(gameApi, 'sendInputs')
    .mockImplementation(async (_id, _from, inputs, quit) => ({
      ...checkpoint(initial, inputs),
      status: quit ? 'abandoned' : 'running',
    }))
  const finished = vi.fn()
  const { result } = renderHook(() => useGameSession(finished))
  act(() => {
    result.current.install(initial)
    result.current.input.current.direction = 3
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(900)
  })
  await act(async () => {
    await result.current.quit()
    await result.current.quit()
  })
  expect(send.mock.calls[0][2]).toHaveLength(8)
  expect(send.mock.calls[0][3]).toBe(true)
  expect(finished).toHaveBeenCalledTimes(1)
})

it('flushes recorded inputs before recovering the clock after returning to the tab', async () => {
  const initial = playableRun()
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const send = vi
    .spyOn(gameApi, 'sendInputs')
    .mockImplementation(async (_id, _from, inputs) =>
      checkpoint(initial, inputs)
    )
  const refreshed = checkpoint(initial, Array<number>(35).fill(0))
  const status = vi
    .spyOn(gameApi, 'getGameStatus')
    .mockResolvedValue({ run: refreshed } as GameStatus)
  const { result } = renderHook(() => useGameSession(vi.fn()))
  act(() => {
    result.current.install(initial)
    result.current.input.current.direction = 3
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500)
  })
  act(() => {
    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  await act(async () => {
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(send.mock.calls[0][2]).toEqual(Array<number>(14).fill(3))
  expect(status).not.toHaveBeenCalled()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  expect(status).toHaveBeenCalledTimes(1)
})

it('resigns after a cursor mismatch forced recovery instead of stalling', async () => {
  const initial = playableRun()
  const behind = checkpoint(initial, [])
  const abandoned = { ...checkpoint(initial, []), status: 'abandoned' as const }
  const send = vi
    .spyOn(gameApi, 'sendInputs')
    .mockImplementation(async (_id, _from, inputs, quit) =>
      quit ? abandoned : checkpoint(initial, inputs)
    )
    .mockImplementationOnce(async (_id, _from, inputs) =>
      checkpoint(initial, inputs)
    )
    .mockImplementationOnce(async () => behind)
  const status = vi
    .spyOn(gameApi, 'getGameStatus')
    .mockResolvedValue({ run: behind } as Awaited<
      ReturnType<typeof gameApi.getGameStatus>
    >)
  const finished = vi.fn()
  const { result } = renderHook(() => useGameSession(finished))
  act(() => {
    result.current.install(initial)
    result.current.input.current.direction = 3
  })
  // The second synchronization is acknowledged behind the local cursor, which
  // drops the queue and asks for a recovery round.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4100)
  })
  expect(status).not.toHaveBeenCalled()
  await act(async () => {
    await result.current.quit()
  })
  expect(status).toHaveBeenCalledOnce()
  expect(send.mock.calls.at(-1)?.[3]).toBe(true)
  expect(result.current.run?.status).toBe('abandoned')
  expect(finished).toHaveBeenCalledTimes(1)
})
