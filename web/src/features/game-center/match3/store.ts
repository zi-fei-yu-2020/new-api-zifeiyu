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
import { z } from 'zod'
import { create } from 'zustand'
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from 'zustand/middleware'

import { useMediaQuery } from '@/hooks/use-media-query'

import {
  applyMatch,
  isMatchDone,
  MATCH_MAX_INPUTS,
  MATCH_MODE_ENDLESS,
  MATCH_UNLOCK_REVEAL,
  MATCH_UNLOCK_SHUFFLE,
  MATCH_UNLOCK_UNDO,
  newMatch,
  type MatchState,
} from './engine'

// Exports: useMatch3Store (zustand, persisted under 'match3-local'),
// useMatch3Prefs(userId), useMatch3LowMotion(userId), restoreMatchSave(saved),
// plus the Match3Save / Match3UserPrefs / LowMotionPreference types.
//
// The saved practice game is client-trusted: it is only ever replayed through
// the local engine, is never sent to the server and never feeds ranks or
// rewards. A save that fails the shape check or the replay degrades to a new
// game.

export type LowMotionPreference = 'auto' | 'on' | 'off'
export type Match3Save = {
  seed: number
  mode: number
  unlocks: number
  inputs: number[]
}
export type Match3UserPrefs = {
  best: number
  lowMotion: LowMotionPreference
  muted: boolean
  saved: Match3Save | null
}

const allUnlocks =
  MATCH_UNLOCK_REVEAL | MATCH_UNLOCK_UNDO | MATCH_UNLOCK_SHUFFLE
const maxInputWord = (1 << 18) - 1

const saveSchema = z.object({
  seed: z.number().int().min(0).max(0xffffffff),
  mode: z.literal(MATCH_MODE_ENDLESS),
  unlocks: z.number().int().min(0).max(allUnlocks),
  inputs: z
    .array(z.number().int().min(0).max(maxInputWord))
    .max(MATCH_MAX_INPUTS),
})
const prefsSchema = z.object({
  best: z.number().int().min(0).max(1000).catch(0),
  lowMotion: z.enum(['auto', 'on', 'off']).catch('auto'),
  muted: z.boolean().catch(true),
  saved: saveSchema.nullable().catch(null),
})

export const DEFAULT_MATCH3_PREFS: Match3UserPrefs = {
  best: 0,
  lowMotion: 'auto',
  muted: true,
  saved: null,
}

// Storage can be blocked or full; the in-memory state stays usable.
const safeStorage: StateStorage = {
  getItem: (key) => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem: (key, value) => {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* In-memory state remains usable. */
    }
  },
  removeItem: (key) => {
    try {
      localStorage.removeItem(key)
    } catch {
      /* Storage can be unavailable. */
    }
  },
}

type Match3Store = {
  byUser: Record<string, Match3UserPrefs>
  recordBest: (userId: number, levels: number) => void
  setLowMotion: (userId: number, value: LowMotionPreference) => void
  setMuted: (userId: number, value: boolean) => void
  setSaved: (userId: number, saved: Match3Save | null) => void
}

export const useMatch3Store = create<Match3Store>()(
  persist(
    (set) => {
      const update = (userId: number, patch: Partial<Match3UserPrefs>) =>
        set((state) => {
          const key = String(userId)
          const current = state.byUser[key] ?? DEFAULT_MATCH3_PREFS
          return {
            byUser: { ...state.byUser, [key]: { ...current, ...patch } },
          }
        })
      return {
        byUser: {},
        recordBest: (userId, levels) =>
          set((state) => {
            const key = String(userId)
            const current = state.byUser[key] ?? DEFAULT_MATCH3_PREFS
            if (levels <= current.best) return state
            return {
              byUser: { ...state.byUser, [key]: { ...current, best: levels } },
            }
          }),
        setLowMotion: (userId, lowMotion) => update(userId, { lowMotion }),
        setMuted: (userId, muted) => update(userId, { muted }),
        setSaved: (userId, saved) => update(userId, { saved }),
      }
    },
    {
      name: 'match3-local',
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({ byUser: state.byUser }),
      // Only version 1 exists; an unknown version is discarded rather than guessed.
      migrate: () => ({ byUser: {} }),
      merge: (persisted, current) => {
        const raw = (persisted as { byUser?: unknown } | null)?.byUser
        const byUser: Record<string, Match3UserPrefs> = {}
        if (typeof raw === 'object' && raw !== null) {
          for (const [key, value] of Object.entries(raw)) {
            const parsed = prefsSchema.safeParse(value)
            if (/^[1-9]\d*$/.test(key) && parsed.success) {
              byUser[key] = parsed.data
            }
          }
        }
        return { ...current, byUser }
      },
    }
  )
)

export function useMatch3Prefs(userId: number | undefined) {
  return useMatch3Store((state) =>
    userId === undefined
      ? DEFAULT_MATCH3_PREFS
      : (state.byUser[String(userId)] ?? DEFAULT_MATCH3_PREFS)
  )
}

// 'auto' follows the operating system; 'on' and 'off' override it.
export function useMatch3LowMotion(userId: number | undefined) {
  const prefs = useMatch3Prefs(userId)
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  if (prefs.lowMotion === 'auto') return reduced
  return prefs.lowMotion === 'on'
}

// Rebuilds a practice game by replaying the saved inputs through the engine.
// A malformed save, a replay step the engine refuses, an action that was only
// a rejected no-op (the game never records those), or a finished run all
// yield null so the caller starts fresh.
export function restoreMatchSave(
  saved: unknown
): { state: MatchState; inputs: number[] } | null {
  const parsed = saveSchema.safeParse(saved)
  if (!parsed.success) return null
  const state = newMatch(
    parsed.data.seed,
    parsed.data.mode,
    parsed.data.unlocks
  )
  for (const input of parsed.data.inputs) {
    if (!applyMatch(state, input)) return null
  }
  if (state.rejected !== 0 || isMatchDone(state)) return null
  return { state, inputs: parsed.data.inputs }
}
