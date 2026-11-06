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
import {
  AiBrain01Icon,
  AiChipIcon,
  Coins01Icon,
  CloudIcon,
  CodeIcon,
  DatabaseIcon,
  FlashIcon,
  GpuIcon,
  Key01Icon,
  ServerStack01Icon,
  ShuffleIcon,
  UndoIcon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'

import type { MatchSkill } from './actions'
import {
  MATCH_COST_REVEAL,
  MATCH_COST_SHUFFLE,
  MATCH_COST_UNDO,
  MATCH_UNLOCK_REVEAL,
  MATCH_UNLOCK_SHUFFLE,
  MATCH_UNLOCK_UNDO,
} from './engine'

// One theme per tile type (the engine uses at most 10). The label is an
// English i18n key that callers render with t(); it is also the accessible
// name, so a tile never relies on its color alone.
export const MATCH_TILE_THEMES: {
  label: string
  icon: IconSvgElement
  className: string
}[] = [
  {
    label: 'Token',
    icon: Coins01Icon,
    className: 'text-sky-700 dark:text-sky-300',
  },
  {
    label: 'Model',
    icon: AiBrain01Icon,
    className: 'text-emerald-700 dark:text-emerald-300',
  },
  {
    label: 'GPU',
    icon: GpuIcon,
    className: 'text-amber-700 dark:text-amber-300',
  },
  {
    label: 'Chip',
    icon: AiChipIcon,
    className: 'text-rose-700 dark:text-rose-300',
  },
  {
    label: 'Cloud',
    icon: CloudIcon,
    className: 'text-violet-700 dark:text-violet-300',
  },
  {
    label: 'Bolt',
    icon: FlashIcon,
    className: 'text-cyan-700 dark:text-cyan-300',
  },
  {
    label: 'Server',
    icon: ServerStack01Icon,
    className: 'text-orange-700 dark:text-orange-300',
  },
  {
    label: 'Database',
    icon: DatabaseIcon,
    className: 'text-lime-700 dark:text-lime-300',
  },
  {
    label: 'API key',
    icon: Key01Icon,
    className: 'text-fuchsia-700 dark:text-fuchsia-300',
  },
  {
    label: 'Code',
    icon: CodeIcon,
    className: 'text-slate-700 dark:text-slate-300',
  },
]

export const MATCH_SKILLS: {
  kind: MatchSkill
  hotkey: string
  label: string
  hint: string
  icon: IconSvgElement
  cost: number
  unlock: number
}[] = [
  {
    kind: 'reveal',
    hotkey: '1',
    label: 'Reveal',
    hint: 'Highlights up to three tiles worth picking next',
    icon: AiBrain01Icon,
    cost: MATCH_COST_REVEAL,
    unlock: MATCH_UNLOCK_REVEAL,
  },
  {
    kind: 'undo',
    hotkey: '2',
    label: 'Undo',
    hint: 'Returns the last tray tile to the board',
    icon: UndoIcon,
    cost: MATCH_COST_UNDO,
    unlock: MATCH_UNLOCK_UNDO,
  },
  {
    kind: 'shuffle',
    hotkey: '3',
    label: 'Shuffle',
    hint: 'Redeals the tile types left on the board',
    icon: ShuffleIcon,
    cost: MATCH_COST_SHUFFLE,
    unlock: MATCH_UNLOCK_SHUFFLE,
  },
]

export function matchSkillForHotkey(key: string): MatchSkill | undefined {
  return MATCH_SKILLS.find((skill) => skill.hotkey === key)?.kind
}
