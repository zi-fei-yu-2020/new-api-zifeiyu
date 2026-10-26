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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useCareerStudioStore } from '@/stores/career-studio-store'

import { CareerStudio } from '..'

let client: QueryClient
let groupModels: string[]
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
  useCareerStudioStore.setState({
    workspaces: {},
    completedDays: {},
    preferences: {},
  })
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  groupModels = ['coach-a', 'coach-b']
  signIn(user.id)
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: url === '/api/user/models' ? groupModels : user,
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

async function coachingModel(): Promise<HTMLElement> {
  const input = screen.getByRole('combobox', { name: 'Coaching model' })
  await waitFor(() => expect(input).toBeEnabled())
  return input
}

function savedPreferences(id: number) {
  return useCareerStudioStore.getState().preferences[String(id)]
}

describe('Career Studio preferences', () => {
  it('restores the chosen coaching model after the studio remounts', async () => {
    const view = renderStudio()
    await userEvent.click(await coachingModel())
    await userEvent.click(
      await screen.findByRole('option', { name: 'coach-b' })
    )
    expect(savedPreferences(user.id)?.coachModel).toBe('coach-b')

    view.unmount()
    renderStudio()

    expect(await coachingModel()).toHaveValue('coach-b')
  })

  it('falls back to the first model without overwriting a saved model that left the group', async () => {
    useCareerStudioStore
      .getState()
      .setPreference(String(user.id), { coachModel: 'retired-model' })

    renderStudio()

    expect(await coachingModel()).toHaveValue('coach-a')
    expect(savedPreferences(user.id)?.coachModel).toBe('retired-model')
  })

  it('does not give another account the model or voice saved by the first one', async () => {
    groupModels = ['coach-a', 'coach-b', 'speech-02-turbo']
    useCareerStudioStore.getState().setPreference(String(user.id), {
      coachModel: 'coach-b',
      ttsEngine: 'model',
      ttsModel: 'speech-02-turbo',
    })
    signIn(99)

    renderStudio()

    expect(await coachingModel()).toHaveValue('coach-a')
    expect(
      screen.getByRole('button', { name: 'AI voice (billed)' })
    ).toHaveAttribute('aria-pressed', 'false')
    expect(
      screen.queryByRole('combobox', { name: 'Voice model' })
    ).not.toBeInTheDocument()
    expect(savedPreferences(99)).toBeUndefined()
  })

  it('lists speech models only as voice models and never as coaching models', async () => {
    groupModels = ['coach-a', 'speech-02-turbo', 'tts-1']
    renderStudio()

    await userEvent.click(await coachingModel())
    expect(
      await screen.findByRole('option', { name: 'coach-a' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: 'speech-02-turbo' })
    ).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')

    await userEvent.click(
      screen.getByRole('button', { name: 'AI voice (billed)' })
    )
    await userEvent.click(
      await screen.findByRole('combobox', { name: 'Voice model' })
    )
    expect(
      await screen.findByRole('option', { name: 'speech-02-turbo' })
    ).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'tts-1' })).toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: 'coach-a' })
    ).not.toBeInTheDocument()
  })
})
