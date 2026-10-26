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
import { beforeEach, describe, expect, it } from 'vitest'

import { useCareerStudioStore } from '@/stores/career-studio-store'

import {
  SPEECH_MAX_CHARS,
  isSpeechModel,
  speechVoices,
  splitForSpeech,
} from '../lib/tts'

describe('speech model detection', () => {
  it.each([
    ['tts-1', true],
    ['speech-02-turbo', true],
    ['FunAudioLLM/CosyVoice2-0.5B', true],
    ['gpt-4o-mini-tts', true],
    ['gpt-4o-mini', false],
    ['deepseek-chat', false],
  ])('classifies %s as speech=%s', (name, expected) => {
    expect(isSpeechModel(name)).toBe(expected)
  })
})

describe('speech voices', () => {
  it('offers MiniMax voices for a speech-* model', () => {
    expect(speechVoices('speech-02-turbo').map((v) => v.value)).toEqual([
      'male-qn-qingse',
      'female-shaonv',
      'female-yujie',
      'presenter_male',
    ])
  })

  it('offers OpenAI voice names for tts and Volcengine models', () => {
    expect(speechVoices('tts-1')[0]).toEqual({ value: 'alloy', label: 'Alloy' })
    expect(speechVoices('volcengine-tts-bigtts')).toHaveLength(6)
  })

  it('prefixes CosyVoice voices with the model name', () => {
    expect(
      speechVoices('FunAudioLLM/CosyVoice2-0.5B').map((v) => v.value)
    ).toEqual([
      'FunAudioLLM/CosyVoice2-0.5B:alex',
      'FunAudioLLM/CosyVoice2-0.5B:anna',
    ])
  })
})

describe('speech splitting', () => {
  it('splits Chinese and English sentences and drops empty pieces', () => {
    expect(splitForSpeech('你好。今天面试吗？ Good luck. Bye!\n\n')).toEqual([
      '你好。',
      '今天面试吗？',
      'Good luck.',
      'Bye!',
    ])
  })

  it('cuts a sentence without punctuation into short utterances', () => {
    const chunks = splitForSpeech('字'.repeat(400))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe('字'.repeat(400))
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThan(200)
  })

  it('keeps decimals inside one sentence', () => {
    expect(splitForSpeech('薪资 1.5 万')).toEqual(['薪资 1.5 万'])
  })

  it('matches the server input limit', () => {
    expect(SPEECH_MAX_CHARS).toBe(2000)
  })
})

describe('career preferences', () => {
  beforeEach(() => {
    localStorage.clear()
    useCareerStudioStore.setState({
      workspaces: {},
      completedDays: {},
      preferences: {},
    })
  })

  it('merges a patch into one user without touching another user', () => {
    const store = useCareerStudioStore.getState()
    store.setPreference('1', { coachModel: 'gpt-4o-mini' })
    store.setPreference('1', { ttsEngine: 'model' })
    store.setPreference('2', { ttsRate: 1.5 })
    expect(useCareerStudioStore.getState().preferences).toEqual({
      '1': { coachModel: 'gpt-4o-mini', ttsEngine: 'model' },
      '2': { ttsRate: 1.5 },
    })
  })

  it('persists preferences to storage under the existing version', () => {
    useCareerStudioStore.getState().setPreference('1', { ttsVoice: 'alloy' })
    const stored = JSON.parse(localStorage.getItem('career-studio') ?? '{}')
    expect(stored.version).toBe(1)
    expect(stored.state.preferences).toEqual({ '1': { ttsVoice: 'alloy' } })
  })

  it('keeps preferences when the workspace is cleared', () => {
    const store = useCareerStudioStore.getState()
    store.setPreference('1', { coachModel: 'gpt-4o-mini' })
    store.saveProfile('1', {
      school: 'A',
      major: '',
      graduationYear: '',
      targetRoles: '',
      cities: '',
      resume: '',
    })
    store.clearWorkspace('1')
    const state = useCareerStudioStore.getState()
    expect(state.workspaces['1']).toBeUndefined()
    expect(state.preferences['1']).toEqual({ coachModel: 'gpt-4o-mini' })
  })

  it('restores storage written before preferences existed', async () => {
    localStorage.setItem(
      'career-studio',
      JSON.stringify({
        state: { workspaces: { '1': { applications: [] } }, completedDays: {} },
        version: 1,
      })
    )
    await useCareerStudioStore.persist.rehydrate()
    const state = useCareerStudioStore.getState()
    expect(state.preferences).toEqual({})
    expect(state.workspaces['1']).toEqual({ applications: [] })
  })
})
