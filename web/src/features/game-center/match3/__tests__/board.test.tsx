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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import { Match3Board } from '../board'
import { matchExposed, MATCH_MODE_ENDLESS, newMatch } from '../engine'

const state = newMatch(1, MATCH_MODE_ENDLESS, 7)
const exposed = matchExposed(state)
const covered = state.tiles.find((tile) => !exposed.includes(tile.id)) ?? {
  id: -1,
  x: 0,
  y: 0,
  z: 0,
}

function tileButton(id: number) {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-tile-id="${id}"]`
  )
  if (!button) throw new Error(`tile ${id} is not rendered`)
  return button
}

it('marks covered tiles aria-disabled and leaves exposed tiles enabled', () => {
  render(<Match3Board state={state} onPick={() => true} />)

  expect(tileButton(covered.id)).toHaveAttribute('aria-disabled', 'true')
  expect(tileButton(covered.id)).toHaveAccessibleName(/covered/)
  for (const id of exposed) {
    expect(tileButton(id)).not.toHaveAttribute('aria-disabled')
    expect(tileButton(id)).toHaveAccessibleName(/available/)
  }
})

it('keeps a single tab stop that sits on an exposed tile', () => {
  render(<Match3Board state={state} onPick={() => true} />)

  const stops = screen
    .getAllByRole('button')
    .filter((button) => button.tabIndex === 0)
  expect(stops).toHaveLength(1)
  expect(exposed).toContain(Number(stops[0].dataset.tileId))
})

it('picks the focused tile with Enter and with Space', async () => {
  const user = userEvent.setup()
  const onPick = vi.fn(() => true)
  render(<Match3Board state={state} onPick={onPick} />)

  tileButton(exposed[0]).focus()
  await user.keyboard('{Enter}')
  tileButton(exposed[1]).focus()
  await user.keyboard(' ')

  expect(onPick).toHaveBeenNthCalledWith(1, exposed[0])
  expect(onPick).toHaveBeenNthCalledWith(2, exposed[1])
})

it('does not pick a covered tile when it is activated', async () => {
  const user = userEvent.setup()
  const onPick = vi.fn(() => true)
  render(<Match3Board state={state} onPick={onPick} />)

  await user.click(tileButton(covered.id))

  expect(onPick).not.toHaveBeenCalled()
})

it('moves focus to an exposed tile on the right when ArrowRight is pressed', async () => {
  const user = userEvent.setup()
  render(<Match3Board state={state} onPick={() => true} />)
  const tiles = exposed.map((id) => state.tiles[id])
  const from = tiles.find((tile) => tiles.some((other) => other.x > tile.x))
  if (!from) throw new Error('fixture has no tile with a right neighbour')

  tileButton(from.id).focus()
  await user.keyboard('{ArrowRight}')

  const focused = document.activeElement as HTMLElement
  const target = state.tiles[Number(focused.dataset.tileId)]
  expect(exposed).toContain(target.id)
  expect(target.x).toBeGreaterThan(from.x)
  expect(focused.tabIndex).toBe(0)
  expect(tileButton(from.id).tabIndex).toBe(-1)
})

it('never lands arrow focus on a covered tile', async () => {
  const user = userEvent.setup()
  render(<Match3Board state={state} onPick={() => true} />)

  tileButton(exposed[0]).focus()
  await user.keyboard('{ArrowRight}{ArrowDown}{ArrowLeft}{ArrowUp}')

  expect(document.activeElement).not.toHaveAttribute('aria-disabled')
})

it('flags suggested tiles in their accessible name', () => {
  render(
    <Match3Board state={{ ...state, hint: [exposed[0]] }} onPick={() => true} />
  )

  expect(tileButton(exposed[0])).toHaveAccessibleName(/suggested/)
  expect(tileButton(exposed[1])).not.toHaveAccessibleName(/suggested/)
})
