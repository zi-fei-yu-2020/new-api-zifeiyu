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

import { Arena } from '../arena'
import { newGame } from '../engine'

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

function renderArena() {
  const input = { current: { direction: 0, dash: false, upgrade: 0 } }
  render(
    <>
      <Arena state={{ current: newGame(7) }} input={input} active />
      <button type='button'>End run</button>
    </>
  )
  return input
}

function press(target: Window | Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  fireEvent(target, event)
  return event
}

it('leaves Space and Enter to a focused button but keeps steering live', () => {
  const input = renderArena()
  const button = screen.getByRole('button', { name: 'End run' })

  for (const key of [' ', 'Enter']) {
    const event = press(button, { key })
    expect(event.defaultPrevented).toBe(false)
  }
  expect(input.current.dash).toBe(false)

  const steer = press(button, { key: 'ArrowRight' })
  expect(steer.defaultPrevented).toBe(true)
  expect(input.current.direction).toBe(3)
})

it('drops held keys on blur and ignores modifier combos', () => {
  const input = renderArena()
  press(window, { key: 'd' })
  expect(input.current.direction).toBe(3)
  fireEvent.blur(window)
  expect(input.current.direction).toBe(0)

  press(window, { key: 's' })
  const combo = press(window, { key: '2', metaKey: true })
  expect(combo.defaultPrevented).toBe(false)
  expect(input.current.upgrade).toBe(0)
  expect(input.current.direction).toBe(0)
})
