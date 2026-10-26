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
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { getUserModels } from '@/features/playground/api'
import { toIntlLocale } from '@/i18n/languages'
import { getSelf } from '@/lib/api'
import dayjs from '@/lib/dayjs'
import { useAuthStore } from '@/stores/auth-store'
import {
  emptyCareerWorkspace,
  useCareerStudioStore,
} from '@/stores/career-studio-store'

import type { CareerModel } from '../api'
import { isSpeechModel } from '../lib/tts'

export function useCareerWorkspace() {
  const userId = String(useAuthStore((state) => state.auth.user?.id ?? ''))
  const workspace = useCareerStudioStore((state) => state.workspaces[userId])
  const completedDays = useCareerStudioStore(
    (state) => state.completedDays[userId]
  )
  return {
    userId,
    workspace: workspace ?? emptyCareerWorkspace(),
    completedDays: completedDays ?? [],
  }
}

export function localToday(): string {
  return dayjs().format('YYYY-MM-DD')
}

/** Model choice shared by every AI tab; charges go to the user's own group. */
export function useCareerModel() {
  const { i18n } = useTranslation()
  const user = useAuthStore((state) => state.auth.user)
  const group = user?.group ?? ''
  const userId = String(user?.id ?? '')
  const saved = useCareerStudioStore(
    (state) => state.preferences[userId]?.coachModel
  )
  const setPreference = useCareerStudioStore((state) => state.setPreference)
  const modelsQuery = useQuery({
    queryKey: ['career-studio-models', user?.id, group],
    queryFn: () => getUserModels(group),
    enabled: !!user?.id && !!group,
    meta: { errorToast: false },
  })
  const allModels = modelsQuery.data ?? []
  const models = allModels.filter((item) => !isSpeechModel(item.value))
  const speechModels = allModels.filter((item) => isSpeechModel(item.value))
  // A saved model missing from the current group is ignored, not overwritten:
  // only an explicit choice is stored.
  const model =
    models.find((item) => item.value === saved)?.value ?? models[0]?.value ?? ''
  const target: CareerModel | null =
    model && group
      ? {
          model,
          group,
          today: localToday(),
          replyLanguage:
            toIntlLocale(i18n.resolvedLanguage || i18n.language) ?? 'zh-CN',
        }
      : null

  function refreshBalance() {
    const userId = user?.id
    void getSelf()
      .then((response) => {
        const auth = useAuthStore.getState().auth
        if (
          response.success &&
          response.data?.id === userId &&
          auth.user?.id === userId
        ) {
          auth.setUser(response.data)
        }
      })
      .catch(() => {
        /* A failed balance refresh must not discard the coaching result. */
      })
  }

  return {
    modelsQuery,
    models,
    model,
    setModel: (value: string) => setPreference(userId, { coachModel: value }),
    target,
    refreshBalance,
    speechModels,
  }
}

export type CareerModelState = ReturnType<typeof useCareerModel>
