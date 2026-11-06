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
let context: AudioContext | undefined

// A short synthesized tone; the game ships no audio files. Playback only
// happens after a player gesture and silently does nothing where the browser
// has no Web Audio.
export function playMatchTone(kind: 'pick' | 'clear' | 'lose') {
  if (typeof AudioContext === 'undefined') return
  context ??= new AudioContext()
  const frequency = { pick: 440, clear: 660, lose: 180 }[kind]
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.frequency.value = frequency
  gain.gain.setValueAtTime(0.05, context.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12)
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start()
  oscillator.stop(context.currentTime + 0.12)
}
