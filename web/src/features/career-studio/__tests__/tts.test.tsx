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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useCareerStudioStore } from '@/stores/career-studio-store'

import { CareerStudio } from '..'

const user = { id: 31, username: 'grad', role: 1, group: 'campus' }
const QUESTION = '请介绍一个你主导的项目。'
const zhVoice = {
  voiceURI: 'tingting',
  name: 'Tingting',
  lang: 'zh-CN',
  default: true,
  localService: true,
} as SpeechSynthesisVoice

class FakeUtterance {
  text: string
  voice: SpeechSynthesisVoice | null = null
  lang = ''
  rate = 1
  constructor(text: string) {
    this.text = text
  }
  addEventListener() {}
}

let client: QueryClient
const synth = {
  getVoices: vi.fn(() => [zhVoice]),
  speak: vi.fn<(utterance: FakeUtterance) => void>(),
  cancel: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}
const urlDescriptors = {
  create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
  revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
}

function installBrowserVoice() {
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: synth,
  })
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
}

function restoreUrl(name: 'createObjectURL' | 'revokeObjectURL') {
  const descriptor =
    name === 'createObjectURL' ? urlDescriptors.create : urlDescriptors.revoke
  if (descriptor) Object.defineProperty(URL, name, descriptor)
  else Reflect.deleteProperty(URL, name)
}

beforeEach(() => {
  localStorage.clear()
  useCareerStudioStore.setState({
    workspaces: {},
    completedDays: {},
    preferences: {},
  })
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  useAuthStore.getState().auth.setUser(user)
  useAuthStore.setState((state) => ({
    auth: {
      ...state.auth,
      accessToken: 'session',
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
  }))
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data:
        url === '/api/user/models' ? ['coach-model', 'speech-02-turbo'] : user,
    },
  }))
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => 'blob:career-voice'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockReturnValue(undefined)
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  synth.speak.mockClear()
  synth.cancel.mockClear()
  Reflect.deleteProperty(window, 'speechSynthesis')
  restoreUrl('createObjectURL')
  restoreUrl('revokeObjectURL')
  useAuthStore.getState().auth.reset()
})

function mockRelay(speech: () => Promise<unknown>) {
  return vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/pg/audio/speech') return speech()
    return {
      data: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({ questions: [{ question: QUESTION }] }),
            },
            finish_reason: 'stop',
          },
        ],
      },
    }
  })
}

function speechCalls(post: ReturnType<typeof mockRelay>) {
  return post.mock.calls.filter((call) => call[0] === '/pg/audio/speech')
}

// The empty utterance queued in the click only unlocks the browser voice.
function spokenText() {
  return synth.speak.mock.calls.map((call) => call[0].text).join('')
}

async function openQuestion(engine: 'browser' | 'model' = 'browser') {
  if (engine === 'model') {
    useCareerStudioStore
      .getState()
      .setPreference(String(user.id), { ttsEngine: 'model' })
  }
  render(
    <QueryClientProvider client={client}>
      <CareerStudio />
    </QueryClientProvider>
  )
  await userEvent.click(screen.getByRole('tab', { name: 'Mock interview' }))
  await userEvent.type(screen.getByLabelText('Target role'), 'Backend')
  const start = screen.getByRole('button', { name: 'Start a mock interview' })
  await waitFor(() => expect(start).toBeEnabled())
  await userEvent.click(start)
  return screen.findByRole('button', { name: 'Read question aloud' })
}

describe('Career Studio read aloud', () => {
  it('reads the question with the Chinese browser voice and sends no speech request', async () => {
    installBrowserVoice()
    const post = mockRelay(async () => ({ data: new Blob() }))

    await userEvent.click(await openQuestion())

    const spoken = synth.speak.mock.calls.map((call) => call[0])
    expect(spoken.map((utterance) => utterance.text).join('')).toBe(QUESTION)
    expect(spoken[0].voice).toBe(zhVoice)
    expect(speechCalls(post)).toHaveLength(0)
  })

  it('stops the browser voice when the playing button is pressed again', async () => {
    installBrowserVoice()
    mockRelay(async () => ({ data: new Blob() }))
    await userEvent.click(await openQuestion())
    const playing = screen.getByRole('button', { name: 'Stop reading' })
    expect(playing).toHaveAttribute('aria-pressed', 'true')
    synth.cancel.mockClear()

    await userEvent.click(playing)

    expect(synth.cancel).toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'Read question aloud' })
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('stops reading aloud when the user switches to another tab', async () => {
    installBrowserVoice()
    mockRelay(async () => ({ data: new Blob() }))
    await userEvent.click(await openQuestion())
    synth.cancel.mockClear()

    await userEvent.click(screen.getByRole('tab', { name: 'Ask the coach' }))

    expect(synth.cancel).toHaveBeenCalled()
  })

  it('posts the question once to the AI voice and plays the returned audio', async () => {
    installBrowserVoice()
    const audio = new Blob(['mp3'], { type: 'audio/mpeg' })
    const post = mockRelay(async () => ({ data: audio }))

    await userEvent.click(await openQuestion('model'))

    await waitFor(() =>
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
    )
    const calls = speechCalls(post)
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toMatchObject({
      model: 'speech-02-turbo',
      group: 'campus',
      input: QUESTION,
      voice: 'male-qn-qingse',
    })
    expect(URL.createObjectURL).toHaveBeenCalledWith(audio)
    expect(spokenText()).toBe('')
  })

  it('unlocks the audio player inside the click and plays the AI voice with the same player', async () => {
    installBrowserVoice()
    let respond: (value: { data: Blob }) => void = () => {}
    mockRelay(
      () =>
        new Promise((resolve) => {
          respond = resolve
        })
    )
    const play = vi.mocked(HTMLMediaElement.prototype.play)

    await userEvent.click(await openQuestion('model'))
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1))
    const unlocked = play.mock.contexts[0] as HTMLAudioElement
    expect(unlocked.src).toMatch(/^data:audio\/wav/)
    respond({ data: new Blob(['mp3'], { type: 'audio/mpeg' }) })

    await waitFor(() => expect(play).toHaveBeenCalledTimes(2))
    expect(play.mock.contexts[1]).toBe(unlocked)
    expect(unlocked.src).toBe('blob:career-voice')
  })

  it('falls back to the browser voice with a notice when the AI voice fails', async () => {
    installBrowserVoice()
    mockRelay(async () => {
      throw new Error('upstream unavailable')
    })

    await userEvent.click(await openQuestion('model'))

    expect(
      await screen.findByText(
        'AI voice failed; reading with the browser voice instead.'
      )
    ).toBeInTheDocument()
    expect(spokenText()).toBe(QUESTION)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('shows the server reason together with the fallback notice when the AI voice is refused', async () => {
    installBrowserVoice()
    const message = 'This voice model is not available in your current group.'
    mockRelay(async () => {
      throw Object.assign(new Error('Request failed with status code 403'), {
        isAxiosError: true,
        response: {
          status: 403,
          data: new Blob([JSON.stringify({ error: { message } })], {
            type: 'application/json',
          }),
        },
      })
    })

    await userEvent.click(await openQuestion('model'))

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(
      screen.getByText(
        'AI voice failed; reading with the browser voice instead.'
      )
    ).toBeInTheDocument()
    expect(spokenText()).toBe(QUESTION)
  })

  it('reads with the browser voice and shows why when the browser blocks AI audio playback', async () => {
    installBrowserVoice()
    mockRelay(async () => ({
      data: new Blob(['mp3'], { type: 'audio/mpeg' }),
    }))
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(
      async function (this: HTMLMediaElement) {
        if (this.src === 'blob:career-voice') {
          throw new DOMException('Playback was blocked.', 'NotAllowedError')
        }
      }
    )

    await userEvent.click(await openQuestion('model'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Playback was blocked.'
    )
    expect(spokenText()).toBe(QUESTION)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:career-voice')
  })

  it('sends nothing to the AI voice when the text to read is a crisis message', async () => {
    installBrowserVoice()
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: {
        choices: [
          {
            message: { role: 'assistant', content: '我真的不想活了' },
            finish_reason: 'stop',
          },
        ],
      },
    })
    useCareerStudioStore
      .getState()
      .setPreference(String(user.id), { ttsEngine: 'model' })
    render(
      <QueryClientProvider client={client}>
        <CareerStudio />
      </QueryClientProvider>
    )
    await userEvent.click(screen.getByRole('tab', { name: 'Ask the coach' }))
    await userEvent.type(screen.getByLabelText('Message'), '今天面试很紧张')
    const send = screen.getByRole('button', { name: 'Send' })
    await waitFor(() => expect(send).toBeEnabled())
    await userEvent.click(send)

    await userEvent.click(
      await screen.findByRole('button', { name: 'Read aloud' })
    )

    expect(
      post.mock.calls.filter((call) => call[0] === '/pg/audio/speech')
    ).toHaveLength(0)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('disables the browser engine and explains why when the browser has no voice', async () => {
    mockRelay(async () => ({ data: new Blob() }))

    const button = await openQuestion()

    expect(
      screen.getByRole('button', { name: 'Browser voice (free)' })
    ).toBeDisabled()
    expect(
      screen.getByText(
        'This browser has no built-in voice. Choose an AI voice instead.'
      )
    ).toBeInTheDocument()
    expect(button).toBeDisabled()
  })
})
