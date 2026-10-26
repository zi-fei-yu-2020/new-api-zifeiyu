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

import { checkRecruitment, matchJobDescription, synthesizeSpeech } from '../api'
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

describe('career speech relay', () => {
  const speech = {
    model: 'speech-02-turbo',
    group: 'campus',
    input: '你好',
    voice: 'female-shaonv',
    speed: 1,
  }
  const jsonBlob = (body: unknown) =>
    new Blob([JSON.stringify(body)], { type: 'application/json' })

  it('posts the speech request as mp3 and returns the audio blob without auth replay', async () => {
    const audio = new Blob(['ID3'], { type: 'audio/mpeg' })
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: audio })
    const result = await synthesizeSpeech(speech)
    expect(post).toHaveBeenCalledWith(
      '/pg/audio/speech',
      { ...speech, response_format: 'mp3' },
      expect.objectContaining({
        responseType: 'blob',
        skipAuthRefresh: true,
      })
    )
    expect(result).toBe(audio)
  })

  it('throws the server message when a 200 response carries a JSON error', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({
      data: jsonBlob({ error: { message: 'Insufficient balance' } }),
    })
    await expect(synthesizeSpeech(speech)).rejects.toThrow(
      'Insufficient balance'
    )
  })

  it('throws the server message when a rejected request has a Blob error body', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(
      Object.assign(new Error('Request failed with status code 403'), {
        isAxiosError: true,
        response: {
          status: 403,
          data: jsonBlob({
            error: {
              message:
                'This voice model is not available in your current group.',
            },
          }),
        },
      })
    )
    await expect(synthesizeSpeech(speech)).rejects.toThrow(
      'This voice model is not available in your current group.'
    )
  })

  it('rejects an empty audio response', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({
      data: new Blob([], { type: 'audio/mpeg' }),
    })
    await expect(synthesizeSpeech(speech)).rejects.toThrow(
      'The voice service returned no audio.'
    )
  })
})
