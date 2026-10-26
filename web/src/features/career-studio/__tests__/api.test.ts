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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { checkRecruitment, matchJobDescription } from '../api'
import { MALFORMED_RESPONSE } from '../lib/structured'

const target = {
  model: 'coach-model',
  group: 'campus',
  today: '2026-10-26',
  replyLanguage: 'zh-CN',
}
const profile = {
  school: '',
  major: '',
  graduationYear: '',
  targetRoles: '',
  cities: '',
  resume: '',
}
const completion = (content: string, reason = 'stop') => ({
  data: {
    choices: [
      { message: { role: 'assistant', content }, finish_reason: reason },
    ],
  },
})

beforeEach(() => {
  useAuthStore.setState((state) => ({
    auth: {
      ...state.auth,
      accessToken: 'session',
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
  }))
})
afterEach(() => vi.restoreAllMocks())

describe('career coach relay', () => {
  it('sends the user group and model to the playground relay without streaming', async () => {
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValue(
        completion(
          JSON.stringify({ score: 72, verdict: 'Apply', matched: ['Java'] })
        )
      )
    const result = await matchJobDescription(
      target,
      profile,
      'Java, MySQL',
      'Need Java'
    )
    expect(post).toHaveBeenCalledWith(
      '/pg/chat/completions',
      expect.objectContaining({
        model: 'coach-model',
        group: 'campus',
        stream: false,
      }),
      expect.anything()
    )
    expect(result.score).toBe(72)
    expect(result.matched).toEqual(['Java'])
  })

  it('clamps an out-of-range score from the model', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(
      completion('```json\n{"score": 180, "verdict": "Strong"}\n```')
    )
    const result = await matchJobDescription(
      target,
      profile,
      'resume',
      'job description'
    )
    expect(result.score).toBe(100)
  })

  it('rejects a response that is not a JSON object', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(
      completion('Sure! Here is my analysis.')
    )
    await expect(
      matchJobDescription(target, profile, 'resume', 'job description')
    ).rejects.toThrow(MALFORMED_RESPONSE)
  })

  it('surfaces a truncated answer instead of rendering it', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(completion('{"score": 1', 'length'))
    await expect(
      matchJobDescription(target, profile, 'resume', 'job description')
    ).rejects.toThrow(/output limit/)
  })

  it('keeps strong rule hits when the model calls a scam low risk', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(
      completion(JSON.stringify({ risk: 'low', summary: 'Fine', redFlags: [] }))
    )
    const result = await checkRecruitment(target, '入职前需缴纳押金 500 元')
    expect(result.risk).toBe('high')
  })
})
