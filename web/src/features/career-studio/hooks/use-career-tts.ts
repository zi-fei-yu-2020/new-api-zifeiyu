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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { toIntlLocale } from '@/i18n/languages'
import {
  getServerErrorMessage,
  isServerErrorCancelled,
} from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'
import { useCareerStudioStore } from '@/stores/career-studio-store'

import { synthesizeSpeech } from '../api'
import { screenText } from '../lib/safety'
import {
  SPEECH_MAX_CHARS,
  speechVoices,
  splitForSpeech,
  type SpeechVoice,
} from '../lib/tts'
import type { CareerModelState } from './use-career'

type CareerTtsEngine = 'browser' | 'model'

export type CareerTtsState = {
  engine: CareerTtsEngine
  setEngine: (engine: CareerTtsEngine) => void
  browserAvailable: boolean
  browserVoices: SpeechVoice[]
  speechModels: { label: string; value: string }[]
  model: string
  setModel: (model: string) => void
  /** Voices of the current engine: display text for browser voices, an i18n key for model voices. */
  voices: SpeechVoice[]
  voice: string
  setVoice: (voice: string) => void
  rate: number
  setRate: (rate: number) => void
  speakingId: string | null
  loadingId: string | null
  /** An i18n key. */
  notice: string | null
  error: string | null
  speak: (id: string, text: string) => void
  stop: () => void
}

const MIN_RATE = 0.5
const MAX_RATE = 2
const FALLBACK_NOTICE =
  'AI voice failed; reading with the browser voice instead.'
const SHORTENED_NOTICE = 'Speech text was shortened to 2000 characters.'
const NO_AUDIO = 'The voice service returned no audio.'
// 10 ms of silent WAV. Playing it inside the click unlocks the reused player,
// so WebKit still allows play() once the billed request has finished.
const SILENT_CLIP =
  'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA=='

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError'
}

function browserSpeech(): SpeechSynthesis | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return null
  }
  if (typeof SpeechSynthesisUtterance === 'undefined') return null
  return window.speechSynthesis
}

function chineseVoices(synth: SpeechSynthesis | null): SpeechSynthesisVoice[] {
  if (!synth) return []
  return synth
    .getVoices()
    .filter((voice) => voice.lang.toLowerCase().startsWith('zh'))
}

/** Read-aloud state shared by every tab; AI voice is billed like the coach. */
export function useCareerTts(modelState: CareerModelState): CareerTtsState {
  const { i18n } = useTranslation()
  const userId = String(useAuthStore((state) => state.auth.user?.id ?? ''))
  // The coach target is null when the group has only speech models, so the
  // group is read from the user directly.
  const group = useAuthStore((state) => state.auth.user?.group ?? '')
  const saved = useCareerStudioStore((state) => state.preferences[userId])
  const setPreference = useCareerStudioStore((state) => state.setPreference)
  const synth = browserSpeech()
  const browserAvailable = synth !== null
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>(() =>
    chineseVoices(synth)
  )
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Each speak() takes a new generation; callbacks of a stopped utterance or
  // request see a stale generation and do nothing.
  const generation = useRef(0)
  const request = useRef<AbortController | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const audioUrl = useRef<string | null>(null)
  const audioEnded = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!synth) return
    const refresh = () => setSystemVoices(chineseVoices(synth))
    refresh()
    synth.addEventListener('voiceschanged', refresh)
    return () => synth.removeEventListener('voiceschanged', refresh)
  }, [synth])

  // Unmounting stops playback; only refs are touched, so no stale state.
  useEffect(
    () => () => {
      generation.current += 1
      request.current?.abort()
      audio.current?.pause()
      if (audioUrl.current) URL.revokeObjectURL(audioUrl.current)
      browserSpeech()?.cancel()
    },
    []
  )

  const speechModels = modelState.speechModels
  const engine: CareerTtsEngine =
    saved?.ttsEngine === 'model' && speechModels.length ? 'model' : 'browser'
  const model =
    speechModels.find((item) => item.value === saved?.ttsModel)?.value ??
    speechModels[0]?.value ??
    ''
  const modelVoices = model ? speechVoices(model) : []
  const modelVoice =
    modelVoices.find((item) => item.value === saved?.ttsVoice)?.value ??
    modelVoices[0]?.value ??
    ''
  const browserVoices = systemVoices.map((voice) => ({
    value: voice.voiceURI,
    label: `${voice.name} (${voice.lang})`,
  }))
  const browserVoice =
    browserVoices.find((item) => item.value === saved?.browserVoiceURI)
      ?.value ??
    browserVoices[0]?.value ??
    ''
  const savedRate = saved?.ttsRate
  const rate =
    typeof savedRate === 'number' && Number.isFinite(savedRate)
      ? Math.min(MAX_RATE, Math.max(MIN_RATE, savedRate))
      : 1

  // The player is kept and reused: only an element that already played inside
  // a click may play again later on WebKit.
  function releaseAudio() {
    const player = audio.current
    if (player && audioEnded.current) {
      player.removeEventListener('ended', audioEnded.current)
    }
    audioEnded.current = null
    player?.pause()
    if (audioUrl.current) URL.revokeObjectURL(audioUrl.current)
    audioUrl.current = null
  }

  // Runs synchronously in the click so WebKit lets the player, and the browser
  // voice used as fallback, start after the request finishes.
  function unlockPlayback() {
    const player = audio.current ?? new Audio()
    audio.current = player
    player.src = SILENT_CLIP
    player.play().catch(() => {})
    const engineSynth = browserSpeech()
    if (engineSynth) engineSynth.speak(new SpeechSynthesisUtterance(''))
  }

  function stop() {
    generation.current += 1
    request.current?.abort()
    request.current = null
    releaseAudio()
    browserSpeech()?.cancel()
    setSpeakingId(null)
    setLoadingId(null)
  }

  function speakWithBrowser(id: string, text: string, current: number) {
    const engineSynth = browserSpeech()
    const chunks = splitForSpeech(text)
    if (!engineSynth || !chunks.length) {
      setSpeakingId(null)
      return
    }
    const voice = systemVoices.find((item) => item.voiceURI === browserVoice)
    const lang =
      voice?.lang ?? toIntlLocale(i18n.resolvedLanguage || i18n.language)
    const finish = () => {
      if (generation.current === current) setSpeakingId(null)
    }
    setSpeakingId(id)
    chunks.forEach((chunk, index) => {
      const utterance = new SpeechSynthesisUtterance(chunk)
      if (voice) utterance.voice = voice
      if (lang) utterance.lang = lang
      utterance.rate = rate
      utterance.addEventListener('error', finish)
      if (index === chunks.length - 1) {
        utterance.addEventListener('end', finish)
      }
      engineSynth.speak(utterance)
    })
  }

  // The cause stays visible: low balance or a revoked session is something
  // the user must act on, and the browser voice does not fix it.
  function fallBack(
    id: string,
    text: string,
    current: number,
    cause: unknown,
    showError = true
  ) {
    if (showError) setError(getServerErrorMessage(cause, NO_AUDIO))
    if (!browserAvailable) {
      setSpeakingId(null)
      return
    }
    setNotice(FALLBACK_NOTICE)
    speakWithBrowser(id, text, current)
  }

  async function speakWithModel(id: string, text: string, current: number) {
    // A crisis stops here: nothing leaves the browser and nothing is billed.
    if (screenText(text) === 'crisis') return
    const runes = [...text.trim()]
    if (!runes.length) return
    if (runes.length > SPEECH_MAX_CHARS) setNotice(SHORTENED_NOTICE)
    const input = runes.slice(0, SPEECH_MAX_CHARS).join('')
    const controller = new AbortController()
    request.current = controller
    setLoadingId(id)
    let blob: Blob
    try {
      blob = await synthesizeSpeech(
        { model, group, input, voice: modelVoice, speed: rate },
        controller.signal
      )
    } catch (cause) {
      if (controller.signal.aborted || isServerErrorCancelled(cause)) return
      if (generation.current !== current) return
      request.current = null
      setLoadingId(null)
      modelState.refreshBalance()
      fallBack(id, text, current, cause)
      return
    }
    if (generation.current !== current) return
    request.current = null
    setLoadingId(null)
    modelState.refreshBalance()
    const url = URL.createObjectURL(blob)
    const player = audio.current ?? new Audio()
    audio.current = player
    audioUrl.current = url
    const finish = () => {
      if (generation.current !== current) return
      releaseAudio()
      setSpeakingId(null)
    }
    audioEnded.current = finish
    player.addEventListener('ended', finish)
    player.src = url
    setSpeakingId(id)
    try {
      await player.play()
    } catch (cause) {
      if (generation.current !== current) return
      releaseAudio()
      fallBack(id, text, current, cause, !isAbortError(cause))
    }
  }

  function speak(id: string, text: string) {
    stop()
    const current = generation.current
    setNotice(null)
    setError(null)
    if (engine === 'model' && model && modelVoice) {
      unlockPlayback()
      void speakWithModel(id, text, current)
      return
    }
    speakWithBrowser(id, text, current)
  }

  return {
    engine,
    setEngine: (value) => setPreference(userId, { ttsEngine: value }),
    browserAvailable,
    browserVoices,
    speechModels,
    model,
    setModel: (value) => setPreference(userId, { ttsModel: value }),
    voices: engine === 'model' ? modelVoices : browserVoices,
    voice: engine === 'model' ? modelVoice : browserVoice,
    setVoice: (value) =>
      setPreference(
        userId,
        engine === 'model' ? { ttsVoice: value } : { browserVoiceURI: value }
      ),
    rate,
    setRate: (value) =>
      setPreference(userId, {
        ttsRate: Math.min(MAX_RATE, Math.max(MIN_RATE, value)),
      }),
    speakingId,
    loadingId,
    notice,
    error,
    speak,
    stop,
  }
}
