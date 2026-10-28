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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useCareerStudioStore } from '@/stores/career-studio-store'

import { CareerStudio } from '..'

let client: QueryClient
const user = { id: 31, username: 'grad', role: 1, group: 'campus' }

function signIn(id: number) {
  useAuthStore.getState().auth.setUser({ ...user, id })
  useAuthStore.setState((state) => ({
    auth: {
      ...state.auth,
      accessToken: 'session',
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
  }))
}

beforeEach(() => {
  localStorage.clear()
  useCareerStudioStore.setState({ workspaces: {}, completedDays: {} })
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  signIn(user.id)
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: url === '/api/user/models' ? ['coach-model'] : user,
    },
  }))
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
  useAuthStore.getState().auth.reset()
})

function renderStudio() {
  return render(
    <QueryClientProvider client={client}>
      <CareerStudio />
    </QueryClientProvider>
  )
}

async function openChat() {
  renderStudio()
  await userEvent.click(screen.getByRole('tab', { name: 'Ask the coach' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  )
  await screen.findByText(
    'AI features use your own models and are billed to your wallet like the Playground.'
  )
}

describe('Career Studio', () => {
  it('shows crisis support and sends nothing to the model when the user expresses suicidal thoughts', async () => {
    const post = vi.spyOn(api, 'post')
    await openChat()
    await userEvent.type(
      screen.getByLabelText('Message'),
      '找不到工作，真的不想活了'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    const notice = await screen.findByTestId('career-safety-crisis')
    expect(within(notice).getByText('12356')).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
  })

  it('replies through the relay and shows a support note for distress', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: {
        choices: [
          {
            message: { role: 'assistant', content: '先照顾好自己。' },
            finish_reason: 'stop',
          },
        ],
      },
    })
    await openChat()
    await userEvent.type(
      screen.getByLabelText('Message'),
      '连续被拒，我快崩溃了'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText('先照顾好自己。')).toBeInTheDocument()
    expect(screen.getByTestId('career-safety-distress')).toBeInTheDocument()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('keeps each account’s applications separate', async () => {
    useCareerStudioStore.getState().saveApplication(String(user.id), {
      id: 'a1',
      company: 'Acme',
      role: 'Backend',
      track: '',
      channel: '',
      status: 'applied',
      appliedOn: '2026-10-20',
      jd: '',
    })
    signIn(99)
    renderStudio()
    await userEvent.click(screen.getByRole('tab', { name: 'Applications' }))
    expect(screen.getByText('No applications yet')).toBeInTheDocument()
    expect(screen.queryByText('Acme')).not.toBeInTheDocument()
  })

  it('adds an application from the board form and rejects a missing company', async () => {
    renderStudio()
    await userEvent.click(screen.getByRole('tab', { name: 'Applications' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Add application' })
    )
    expect(await screen.findByText('Company is required')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Company'), 'Acme')
    await userEvent.type(screen.getByLabelText('Job title'), 'Backend intern')
    await userEvent.click(
      screen.getByRole('button', { name: 'Add application' })
    )

    const list = await screen.findByRole('list', { name: 'Applications' })
    expect(within(list).getByText('Acme')).toBeInTheDocument()
    expect(
      useCareerStudioStore.getState().workspaces[String(user.id)].applications
    ).toHaveLength(1)
  })
})
