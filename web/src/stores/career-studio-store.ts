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
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type {
  CareerApplication,
  CareerProfile,
  CareerWorkspace,
  DailyPlan,
  ReviewEntry,
} from '@/features/career-studio/types'

const EMPTY_CAREER_PROFILE: CareerProfile = {
  school: '',
  major: '',
  graduationYear: '',
  targetRoles: '',
  cities: '',
  resume: '',
}

export function emptyCareerWorkspace(): CareerWorkspace {
  return {
    profile: { ...EMPTY_CAREER_PROFILE },
    applications: [],
    daily: null,
    reviews: [],
  }
}

type CareerStudioState = {
  // Keyed by user id so accounts sharing a browser never see each other's data.
  workspaces: Record<string, CareerWorkspace>
  completedDays: Record<string, string[]>
  saveProfile: (userId: string, profile: CareerProfile) => void
  saveApplication: (userId: string, application: CareerApplication) => void
  removeApplication: (userId: string, id: string) => void
  setDaily: (userId: string, daily: DailyPlan) => void
  toggleTask: (userId: string, taskId: string) => void
  addReview: (userId: string, review: ReviewEntry) => void
  clearWorkspace: (userId: string) => void
}

function update(
  state: CareerStudioState,
  userId: string,
  change: (workspace: CareerWorkspace) => Partial<CareerWorkspace>
): Pick<CareerStudioState, 'workspaces'> {
  const current = state.workspaces[userId] ?? emptyCareerWorkspace()
  return {
    workspaces: {
      ...state.workspaces,
      [userId]: { ...current, ...change(current) },
    },
  }
}

export const useCareerStudioStore = create<CareerStudioState>()(
  persist(
    (set) => ({
      workspaces: {},
      completedDays: {},
      saveProfile: (userId, profile) =>
        set((state) => update(state, userId, () => ({ profile }))),
      saveApplication: (userId, application) =>
        set((state) =>
          update(state, userId, (workspace) => {
            const exists = workspace.applications.some(
              (item) => item.id === application.id
            )
            return {
              applications: exists
                ? workspace.applications.map((item) =>
                    item.id === application.id ? application : item
                  )
                : [application, ...workspace.applications],
            }
          })
        ),
      removeApplication: (userId, id) =>
        set((state) =>
          update(state, userId, (workspace) => ({
            applications: workspace.applications.filter(
              (item) => item.id !== id
            ),
          }))
        ),
      setDaily: (userId, daily) =>
        set((state) => update(state, userId, () => ({ daily }))),
      toggleTask: (userId, taskId) =>
        set((state) => {
          const workspace = state.workspaces[userId]
          if (!workspace?.daily) return state
          const tasks = workspace.daily.tasks.map((task) =>
            task.id === taskId ? { ...task, done: !task.done } : task
          )
          const day = workspace.daily.day
          const days = new Set(state.completedDays[userId] ?? [])
          if (tasks.some((task) => task.done)) days.add(day)
          else days.delete(day)
          return {
            ...update(state, userId, () => ({ daily: { day, tasks } })),
            completedDays: { ...state.completedDays, [userId]: [...days] },
          }
        }),
      addReview: (userId, review) =>
        set((state) =>
          update(state, userId, (workspace) => ({
            reviews: [review, ...workspace.reviews].slice(0, 50),
          }))
        ),
      clearWorkspace: (userId) =>
        set((state) => {
          const workspaces = { ...state.workspaces }
          const completedDays = { ...state.completedDays }
          delete workspaces[userId]
          delete completedDays[userId]
          return { workspaces, completedDays }
        }),
    }),
    {
      name: 'career-studio',
      version: 1,
      partialize: (state) => ({
        workspaces: state.workspaces,
        completedDays: state.completedDays,
      }),
    }
  )
)
