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
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { describe, expect, it } from 'vitest'

import { planMatchAction } from '../actions'
import { transientRetryDelay } from '../api'
import {
  decodeMatchInput,
  matchExposed,
  MATCH_MODE_ENDLESS,
  MATCH_OP_PICK,
  MATCH_OP_REVEAL,
  MATCH_UNLOCK_REVEAL,
  newMatch,
} from '../engine'

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

describe('planMatchAction', () => {
  it('records an exposed pick with the elapsed ticks as its delta', () => {
    const state = newMatch(1, MATCH_MODE_ENDLESS, 0)
    const id = matchExposed(state)[0]

    const plan = planMatchAction(state, MATCH_OP_PICK, id, 750)

    expect(plan?.next.tray).toEqual([id])
    expect(decodeMatchInput(plan?.word ?? -1)).toEqual({
      op: 1,
      arg: id,
      dt: 7,
    })
    expect(plan?.spentMs).toBe(700)
    expect(state.tray).toEqual([])
  })

  it('caps an idle gap just past the combo window and spends all the elapsed time', () => {
    const state = newMatch(1, MATCH_MODE_ENDLESS, 0)
    const id = matchExposed(state)[0]

    const plan = planMatchAction(state, MATCH_OP_PICK, id, 60_000)

    expect(decodeMatchInput(plan?.word ?? -1).dt).toBe(51)
    expect(plan?.spentMs).toBe(60_000)
  })

  it('refuses a covered tile, a locked skill and a second action inside the minimum gap', () => {
    const state = newMatch(1, MATCH_MODE_ENDLESS, 0)
    const exposedIds = matchExposed(state)
    const covered = state.tiles.find((t) => !exposedIds.includes(t.id))
    expect(covered).toBeDefined()

    expect(
      planMatchAction(state, MATCH_OP_PICK, covered?.id ?? -1, 500)
    ).toBeNull()
    expect(planMatchAction(state, MATCH_OP_REVEAL, 0, 500)).toBeNull()

    const unlocked = newMatch(1, MATCH_MODE_ENDLESS, MATCH_UNLOCK_REVEAL)
    const first = planMatchAction(unlocked, MATCH_OP_REVEAL, 0, 500)
    expect(first).not.toBeNull()
    expect(
      planMatchAction(first?.next ?? state, MATCH_OP_REVEAL, 0, 100)
    ).toBeNull()
  })

  it('refuses a tile id outside the argument range', () => {
    const state = newMatch(1, MATCH_MODE_ENDLESS, 0)

    expect(planMatchAction(state, MATCH_OP_PICK, 128, 500)).toBeNull()
    expect(planMatchAction(state, MATCH_OP_PICK, -1, 500)).toBeNull()
  })
})

describe('transientRetryDelay', () => {
  it('retries a network failure at once and a gateway error after a second', () => {
    expect(transientRetryDelay(new AxiosError('Network Error'))).toBe(0)
    expect(transientRetryDelay(httpError(503))).toBe(1000)
  })

  it('honours Retry-After on a 429 up to ten seconds', () => {
    expect(transientRetryDelay(httpError(429, '4'))).toBe(4000)
    expect(transientRetryDelay(httpError(429, '99'))).toBe(10_000)
    expect(transientRetryDelay(httpError(429))).toBe(2000)
  })

  it('treats a rejected batch and a non-HTTP error as not transient', () => {
    expect(transientRetryDelay(httpError(200))).toBeNull()
    expect(transientRetryDelay(httpError(400))).toBeNull()
    expect(transientRetryDelay(new Error('boom'))).toBeNull()
  })
})
