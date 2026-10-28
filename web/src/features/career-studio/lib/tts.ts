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
// Same rule as the server's /pg/audio/speech model check, so the voice list
// never offers a model the server would reject.
const SPEECH_MODEL_PATTERN = /tts|speech|cosyvoice/i

/** The server rejects longer speech input; it is the billing multiplier. */
export const SPEECH_MAX_CHARS = 2000

// Chrome stops a single utterance after about 15 seconds, so sentences longer
// than this are cut further.
const MAX_UTTERANCE_CHARS = 160

export type SpeechVoice = { value: string; label: string }

const MINIMAX_VOICES: SpeechVoice[] = [
  { value: 'male-qn-qingse', label: 'Qingse (male)' },
  { value: 'female-shaonv', label: 'Shaonv (female)' },
  { value: 'female-yujie', label: 'Yujie (female)' },
  { value: 'presenter_male', label: 'Presenter (male)' },
]

// Volcengine maps these OpenAI voice names to Chinese voices.
const OPENAI_VOICES: SpeechVoice[] = [
  { value: 'alloy', label: 'Alloy' },
  { value: 'echo', label: 'Echo' },
  { value: 'fable', label: 'Fable' },
  { value: 'onyx', label: 'Onyx' },
  { value: 'nova', label: 'Nova' },
  { value: 'shimmer', label: 'Shimmer' },
]

export function isSpeechModel(name: string): boolean {
  return SPEECH_MODEL_PATTERN.test(name)
}

/** Voices for a speech model; each label is an English i18n key. */
export function speechVoices(model: string): SpeechVoice[] {
  const name = model.toLowerCase()
  if (name.includes('cosyvoice')) {
    return [
      { value: `${model}:alex`, label: 'Alex' },
      { value: `${model}:anna`, label: 'Anna' },
    ]
  }
  if (name.split('/').pop()?.startsWith('speech')) return MINIMAX_VOICES
  return OPENAI_VOICES
}

/** Split text into short utterances at sentence ends and line breaks. */
export function splitForSpeech(text: string): string[] {
  const chunks: string[] = []
  const sentences = text.split(/(?<=[。！？!?；;\n])|(?<=\.)(?=\s|$)/)
  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    for (let start = 0; start < trimmed.length; start += MAX_UTTERANCE_CHARS) {
      const chunk = trimmed.slice(start, start + MAX_UTTERANCE_CHARS).trim()
      if (chunk) chunks.push(chunk)
    }
  }
  return chunks
}
