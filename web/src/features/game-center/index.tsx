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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { PublicLayout } from '@/components/layout/components/public-layout'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { DailyChallenge } from './daily-challenge'
import { PvpLobby } from './pvp/lobby'
import { pvpStatusQueryOptions } from './query-options'

import './game-center.css'

type GameTab = 'daily' | 'pvp'

export function GameCenter() {
  const { t } = useTranslation()
  const pvpStatus = useQuery(pvpStatusQueryOptions)
  const [picked, setPicked] = useState<GameTab | null>(null)
  // A live or pending duel pins the PvP tab until the player chooses another
  // one, so a reload does not leave them on a tab that is not running it.
  const duelStatus = pvpStatus.data?.match?.status
  const duelLive = duelStatus === 'playing' || duelStatus === 'invited'
  let tab: GameTab = 'daily'
  if (picked) tab = picked
  else if (duelLive) tab = 'pvp'
  return (
    <PublicLayout showMainContainer={false}>
      <main className='game-center mx-auto max-w-[1320px] px-4 pt-24 pb-12 sm:px-6 lg:px-8'>
        <Tabs
          value={tab}
          onValueChange={(value) => setPicked(value as GameTab)}
        >
          <TabsList
            variant='line'
            aria-label={t('Game modes')}
            className='mb-5'
          >
            <TabsTrigger value='daily'>{t('Daily challenge')}</TabsTrigger>
            <TabsTrigger value='pvp'>{t('PvP duels')}</TabsTrigger>
          </TabsList>
          {/* Both panels stay mounted: unmounting a panel would stop the run or
              duel session and with it the inputs the server is waiting for. */}
          <TabsContent value='daily' keepMounted>
            <DailyChallenge visible={tab === 'daily'} />
          </TabsContent>
          <TabsContent value='pvp' keepMounted>
            <PvpLobby visible={tab === 'pvp'} />
          </TabsContent>
        </Tabs>
      </main>
    </PublicLayout>
  )
}
