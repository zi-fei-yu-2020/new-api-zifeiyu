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
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

import { DuelArena } from '../duel-arena'
import { newDuel } from '../duel-engine'

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

function renderArena() {
  const input = { current: { direction: 0, dash: false, upgrade: 0 } }
  const state = { current: newDuel(7) }
  render(
    <>
      <DuelArena state={state} mySlot={1} active input={input} />
      <button type='button'>Native action</button>
      <a href='#details'>Linked action</a>
      <div role='button' tabIndex={0}>
        Custom action
      </div>
      <details>
        <summary>More details</summary>
      </details>
    </>
  )
  return input
}

it('leaves Space and arrow keys available to interactive elements', () => {
  const input = renderArena()
  const controls = [
    screen.getByRole('button', { name: 'Native action' }),
    screen.getByRole('link', { name: 'Linked action' }),
    screen.getByRole('button', { name: 'Custom action' }),
    screen.getByText('More details'),
  ]

  for (const control of controls) {
    for (const key of [' ', 'ArrowUp', 'ArrowLeft']) {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      })
      fireEvent(control, event)
      expect(event.defaultPrevented).toBe(false)
      expect(input.current).toEqual({ direction: 0, dash: false, upgrade: 0 })
    }
  }
})

it('captures movement and dash keys when the arena itself has focus', () => {
  const input = renderArena()
  const canvas = screen.getByLabelText(
    'Duel arena. Move with WASD or arrow keys; press Space to dash.'
  )
  const movement = new KeyboardEvent('keydown', {
    key: 'ArrowRight',
    bubbles: true,
    cancelable: true,
  })
  fireEvent(canvas, movement)
  expect(movement.defaultPrevented).toBe(true)
  expect(input.current.direction).toBe(3)

  const dash = new KeyboardEvent('keydown', {
    key: ' ',
    bubbles: true,
    cancelable: true,
  })
  fireEvent(canvas, dash)
  expect(dash.defaultPrevented).toBe(true)
  expect(input.current.dash).toBe(true)
})
