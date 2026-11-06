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
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { Match3BossView } from '../boss-view'
import { useBossKey } from '../use-boss-key'

function Harness(props: { enabled?: boolean }) {
  const boss = useBossKey({ enabled: props.enabled ?? true })
  const [text, setText] = useState('')
  return (
    <div>
      <button type='button'>Game button</button>
      <input
        aria-label='Notes'
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p>{boss.hidden ? 'hidden' : 'shown'}</p>
      <Match3BossView open={boss.hidden} onClose={boss.restore} />
    </div>
  )
}

afterEach(() => vi.restoreAllMocks())

it('hides the game behind the documentation page on Backquote and shows it again', async () => {
  const user = userEvent.setup()
  render(<Harness />)

  await user.keyboard('`')
  expect(screen.getByText('hidden')).toBeInTheDocument()
  expect(
    await screen.findByRole('dialog', { name: 'Chat completions' })
  ).toBeVisible()

  await user.keyboard('`')
  expect(screen.getByText('shown')).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('toggles with Alt+B too', async () => {
  const user = userEvent.setup()
  render(<Harness />)

  await user.keyboard('{Alt>}b{/Alt}')

  expect(screen.getByText('hidden')).toBeInTheDocument()
})

it('restores focus to the control that had it before hiding', async () => {
  const user = userEvent.setup()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0)
    return 0
  })
  render(<Harness />)
  const button = screen.getByRole('button', { name: 'Game button' })
  button.focus()

  await user.keyboard('`')
  await screen.findByRole('dialog')
  await user.keyboard('`')

  await act(async () => undefined)
  expect(button).toHaveFocus()
})

it('closes with Escape and returns to the game', async () => {
  const user = userEvent.setup()
  render(<Harness />)

  await user.keyboard('`')
  await screen.findByRole('dialog')
  await user.keyboard('{Escape}')

  expect(screen.getByText('shown')).toBeInTheDocument()
})

it('ignores the key while typing in a field', async () => {
  const user = userEvent.setup()
  render(<Harness />)

  await user.type(screen.getByRole('textbox', { name: 'Notes' }), '`')

  expect(screen.getByText('shown')).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('`')
})

it('ignores the key while another dialog is open', async () => {
  const user = userEvent.setup()
  render(
    <>
      <div role='dialog' aria-modal='true' aria-label='Other dialog' />
      <Harness />
    </>
  )

  await user.keyboard('`')

  expect(screen.getByText('shown')).toBeInTheDocument()
})

it('does nothing while the tab is not visible', async () => {
  const user = userEvent.setup()
  render(<Harness enabled={false} />)

  await user.keyboard('`')

  expect(screen.getByText('shown')).toBeInTheDocument()
})

it('drops a hidden state when the tab stops being visible', async () => {
  const user = userEvent.setup()
  const { rerender } = render(<Harness />)
  await user.keyboard('`')
  expect(screen.getByText('hidden')).toBeInTheDocument()

  rerender(<Harness enabled={false} />)

  expect(screen.getByText('shown')).toBeInTheDocument()
})
