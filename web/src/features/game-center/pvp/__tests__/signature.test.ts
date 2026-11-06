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
import { createHmac } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { signPvPInput } from '../api'

// The server (model/pvp.go pvpSignature) rebuilds the identical message and
// compares in constant time, so the tagged fields and separators are a
// cross-language contract.
function serverSideSignature(
  secret: string,
  matchId: string,
  slot: number,
  seq: number,
  from: number,
  quit: number,
  inputs: number[]
) {
  const message = [
    'pvp1',
    matchId,
    slot,
    seq,
    from,
    quit,
    inputs.join(','),
  ].join('|')
  return createHmac('sha256', secret).update(message).digest('hex')
}

describe('PvP input packet signature', () => {
  it('produces the HMAC-SHA256 the Go server expects for the same batch', async () => {
    const sig = await signPvPInput(
      'duel-secret',
      'match-42',
      2,
      7,
      130,
      false,
      [3, 19, 0, 127]
    )
    expect(sig).toBe(
      serverSideSignature(
        'duel-secret',
        'match-42',
        2,
        7,
        130,
        0,
        [3, 19, 0, 127]
      )
    )
  })

  it('tags the quit flag and an empty batch exactly like the server', async () => {
    const sig = await signPvPInput('s', 'm', 1, 3, 900, true, [])
    expect(sig).toBe(serverSideSignature('s', 'm', 1, 3, 900, 1, []))
  })

  it('changes when any signed field changes', async () => {
    const base = await signPvPInput('secret', 'm', 1, 1, 0, false, [1])
    const replayedSeq = await signPvPInput('secret', 'm', 1, 2, 0, false, [1])
    const tamperedInput = await signPvPInput('secret', 'm', 1, 1, 0, false, [2])
    expect(replayedSeq).not.toBe(base)
    expect(tamperedInput).not.toBe(base)
  })
})

describe('PvP input signature without WebCrypto', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('signs on plain-HTTP origins where crypto.subtle is missing', async () => {
    vi.stubGlobal('crypto', {})
    const sig = await signPvPInput('plain-http', 'm-1', 2, 5, 40, false, [1, 2])
    expect(sig).toBe(
      serverSideSignature('plain-http', 'm-1', 2, 5, 40, 0, [1, 2])
    )
  })

  it.each([
    ['short secret', 'k'],
    ['block-sized secret', 'k'.repeat(64)],
    ['secret longer than one SHA-256 block', 'long-secret-'.repeat(12)],
    ['non-ASCII secret', '密钥-secret'],
  ])('matches the server HMAC for a %s', async (_name, secret) => {
    vi.stubGlobal('crypto', undefined)
    const inputs = Array.from({ length: 300 }, (_, i) => i % 128)
    const sig = await signPvPInput(secret, 'match-long', 1, 9, 0, true, inputs)
    expect(sig).toBe(
      serverSideSignature(secret, 'match-long', 1, 9, 0, 1, inputs)
    )
  })

  it('falls back to the portable HMAC and retries the import after a rejected key', async () => {
    const importKey = vi.fn().mockRejectedValue(new Error('import failed'))
    vi.stubGlobal('crypto', { subtle: { importKey, sign: vi.fn() } })
    const first = await signPvPInput('flaky', 'm', 1, 1, 0, false, [3])
    const second = await signPvPInput('flaky', 'm', 1, 2, 1, false, [3])
    expect(first).toBe(serverSideSignature('flaky', 'm', 1, 1, 0, 0, [3]))
    expect(second).toBe(serverSideSignature('flaky', 'm', 1, 2, 1, 0, [3]))
    // The rejected promise is evicted, so each batch tries the import again.
    expect(importKey).toHaveBeenCalledTimes(2)
  })
})
