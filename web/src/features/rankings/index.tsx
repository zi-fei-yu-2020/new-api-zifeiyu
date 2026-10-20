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
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { PublicLayout } from '@/components/layout'
import { Skeleton } from '@/components/ui/skeleton'

import {
  MarketShareSection,
  ModelsSection,
  PulseSection,
  RankingsHero,
} from './components'
import { useRankings } from './hooks/use-rankings'
import type { RankingPeriod } from './types'

const VALID_PERIODS = new Set<RankingPeriod>(['today', 'week', 'month', 'year'])

export function Rankings() {
  const { t } = useTranslation()
  const search = useSearch({ from: '/rankings/' })
  const navigate = useNavigate()

  const period: RankingPeriod = VALID_PERIODS.has(
    search.period as RankingPeriod
  )
    ? (search.period as RankingPeriod)
    : 'week'

  const rankingsQuery = useRankings(period)
  const snapshot = rankingsQuery.data?.data

  const handlePeriodChange = (next: RankingPeriod) => {
    navigate({
      to: '/rankings',
      search: (prev) => ({ ...prev, period: next }),
    })
  }

  let content
  if (rankingsQuery.isLoading) {
    content = <RankingsLoading />
  } else if (!snapshot) {
    content = (
      <RankingsError
        message={
          rankingsQuery.error instanceof Error
            ? rankingsQuery.error.message
            : t('Unable to load rankings data')
        }
      />
    )
  } else {
    content = (
      <>
        <ModelsSection
          history={snapshot.models_history}
          rows={snapshot.models}
          period={period}
        />

        <MarketShareSection
          history={snapshot.vendor_share_history}
          rows={snapshot.vendors}
          period={period}
        />

        <PulseSection
          movers={snapshot.top_movers}
          droppers={snapshot.top_droppers}
        />
      </>
    )
  }

  return (
    <PublicLayout showMainContainer={false}>
      <div className='relative'>
        <div className='relative mx-auto w-full max-w-[1280px] space-y-8 px-4 pt-24 pb-12 sm:px-6 sm:pt-28 sm:pb-16 xl:px-8'>
          <RankingsHero period={period} onPeriodChange={handlePeriodChange} />
          {content}
        </div>
      </div>
    </PublicLayout>
  )
}

function RankingsLoading() {
  return (
    <div className='space-y-6'>
      <Skeleton className='h-[420px] w-full' />
      <Skeleton className='h-[360px] w-full' />
      <Skeleton className='h-[180px] w-full' />
    </div>
  )
}

function RankingsError(props: { message: string }) {
  const { t } = useTranslation()
  return (
    <div className='bg-card border border-dashed px-6 py-12 text-center'>
      <h2 className='text-foreground text-base font-semibold'>
        {t('Unable to load rankings')}
      </h2>
      <p className='text-muted-foreground mx-auto mt-2 max-w-md text-sm'>
        {props.message}
      </p>
    </div>
  )
}
