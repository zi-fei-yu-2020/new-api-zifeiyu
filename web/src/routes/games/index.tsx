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
import { createFileRoute, redirect } from '@tanstack/react-router'

import { GameCenter } from '@/features/game-center'
import {
  gameStatusQueryOptions,
  pvpStatusQueryOptions,
} from '@/features/game-center/query-options'
import { resolveAuthentication } from '@/lib/auth-session'
import { isWorkbenchEnabledForGuard } from '@/lib/nav-modules'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/games/')({
  beforeLoad: async ({ context, location }) => {
    await resolveAuthentication()
    const { auth } = useAuthStore.getState()
    if (!auth.user || !auth.accessToken) {
      throw redirect({ to: '/sign-in', search: { redirect: location.href } })
    }
    if (!(await isWorkbenchEnabledForGuard(context.queryClient, '/games'))) {
      let state
      try {
        state = await context.queryClient.fetchQuery(gameStatusQueryOptions)
      } catch {
        return
      }
      if (state.run?.status === 'running') return
      // A duel in progress (or an open invite holding a stake) must stay
      // reachable too, otherwise the player cannot control or cancel it.
      try {
        const pvp = await context.queryClient.fetchQuery(pvpStatusQueryOptions)
        if (
          pvp.match?.status === 'playing' ||
          pvp.match?.status === 'invited'
        ) {
          return
        }
      } catch {
        return
      }
      throw redirect({ to: '/dashboard' })
    }
  },
  component: GameCenter,
})
