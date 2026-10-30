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
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import {
  MATCH_COST_SHUFFLE,
  MATCH_MODE_ENDLESS,
  MATCH_UNLOCK_REVEAL,
  newMatch,
} from '../engine'
import { Match3SkillsBar } from '../skills-bar'
import { Match3Tray } from '../tray'

function bar(
  overrides: Partial<ReturnType<typeof newMatch>>,
  disabled = false
) {
  const onSkill = vi.fn()
  const state = { ...newMatch(1, MATCH_MODE_ENDLESS, 7), ...overrides }
  render(
    <Match3SkillsBar
      state={state}
      getTick={() => 0}
      running={false}
      disabled={disabled}
      onSkill={onSkill}
    />
  )
  return onSkill
}

it('calls onSkill for an affordable unlocked skill', async () => {
  const onSkill = bar({ energy: 6 })

  await userEvent.click(screen.getByRole('button', { name: /^Undo/ }))

  expect(onSkill).toHaveBeenCalledWith('undo')
})

it('keeps a locked skill focusable but inert and shows its key hint', async () => {
  const onSkill = bar({ energy: 6, unlocks: MATCH_UNLOCK_REVEAL })
  const undo = screen.getByRole('button', { name: /^Undo/ })

  expect(undo).toHaveAttribute('aria-disabled', 'true')
  expect(undo).toHaveAttribute('aria-keyshortcuts', '2')
  undo.focus()
  expect(undo).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  expect(onSkill).not.toHaveBeenCalled()
})

it('disables a skill the energy cannot pay for', async () => {
  const onSkill = bar({ energy: MATCH_COST_SHUFFLE - 1 })

  await userEvent.click(screen.getByRole('button', { name: /^Shuffle/ }))

  expect(onSkill).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: /^Shuffle/ })).toHaveAttribute(
    'aria-disabled',
    'true'
  )
})

it('disables every skill while the game is frozen', () => {
  bar({ energy: 6 }, true)

  for (const name of [/^Reveal/, /^Undo/, /^Shuffle/]) {
    expect(screen.getByRole('button', { name })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  }
})

it('reports energy as a progress value out of the cap', () => {
  bar({ energy: 4 })

  expect(screen.getAllByRole('progressbar')[0]).toHaveAttribute(
    'aria-valuenow',
    '4'
  )
})

it('shows the tray as a list of seven slots with a polite count', () => {
  const state = newMatch(1, MATCH_MODE_ENDLESS, 7)
  state.tray = [state.tiles[0].id, state.tiles[1].id]
  render(<Match3Tray state={state} />)

  const list = screen.getByRole('list')
  expect(within(list).getAllByRole('listitem')).toHaveLength(7)
  expect(screen.getByRole('status')).toHaveTextContent('2/7')
  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
})
