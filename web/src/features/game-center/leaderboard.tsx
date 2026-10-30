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
import { Crown, Trophy } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatNumber, formatQuota } from '@/lib/format'

import { getRankings } from './api'

export function Leaderboard(props: { weeklyPrizes: number[] }) {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<'day' | 'week'>('day')
  const ranks = useQuery({
    queryKey: ['game-rankings', period],
    queryFn: () => getRankings(period),
    refetchInterval: 30000,
    meta: { errorToast: false },
  })
  const myRank = ranks.data?.find((row) => row.is_me)
  let content = (
    <div className='py-8 text-center'>
      <Trophy className='text-muted-foreground/50 mx-auto mb-3 size-6' />
      <p className='text-sm'>{t('Be the first on the board')}</p>
      <p className='text-muted-foreground mt-1 text-xs'>
        {t('Finish a run to set today’s first score.')}
      </p>
    </div>
  )
  if (ranks.isPending) {
    content = (
      <p className='text-muted-foreground py-8 text-center text-sm'>
        {t('Loading...')}
      </p>
    )
  } else if (ranks.isError) {
    content = (
      <div className='py-6 text-sm'>
        <p>{t('Unable to load rankings')}</p>
        <Button variant='ghost' onClick={() => void ranks.refetch()}>
          {t('Retry')}
        </Button>
      </div>
    )
  } else if (ranks.data?.length) {
    content = (
      <ol>
        {ranks.data.map((row) => (
          <li
            key={row.rank}
            className={`flex items-center gap-3 border-b py-3.5 last:border-b-0 ${row.is_me ? 'font-semibold' : ''}`}
          >
            <span className='text-muted-foreground w-5 shrink-0 font-mono text-xs'>
              {row.rank === 1 ? (
                <Crown className='size-4 text-amber-700' />
              ) : (
                String(row.rank).padStart(2, '0')
              )}
            </span>
            <span className='min-w-0 flex-1 truncate text-xs' title={row.name}>
              {row.name}
              {row.is_me && (
                <span className='text-muted-foreground ml-1'>({t('You')})</span>
              )}
            </span>
            <div className='shrink-0 text-right'>
              <span className='font-mono text-sm tabular-nums'>
                {formatNumber(row.score)}
              </span>
              {period === 'week' && row.rank <= 3 && (
                <p className='text-muted-foreground mt-1 font-mono text-xs'>
                  {formatQuota(props.weeklyPrizes[row.rank - 1] ?? 0)}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    )
  }
  return (
    <section className='border' aria-label={t('Global leaderboard')}>
      <div className='flex items-center justify-between px-5 pt-5'>
        <h2 className='flex items-center gap-2 text-sm font-semibold'>
          <Trophy className='size-4' />
          {t('Global leaderboard')}
        </h2>
        <span className='text-muted-foreground text-[10px]'>
          {t('Top 100')}
        </span>
      </div>
      <Tabs
        value={period}
        onValueChange={(v) => setPeriod(v as 'day' | 'week')}
        className='px-5 pt-4'
      >
        <TabsList className='w-full'>
          <TabsTrigger value='day' className='flex-1'>
            {t('Today')}
          </TabsTrigger>
          <TabsTrigger value='week' className='flex-1'>
            {t('This week')}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <p className='text-muted-foreground px-5 pt-3 pb-2 text-[11px]'>
        {period === 'day'
          ? t('One attempt. Highest score wins.')
          : t('Total score from this week’s daily runs.')}
      </p>
      <div className='max-h-[355px] overflow-y-auto px-5'>{content}</div>
      <div className='bg-muted/20 mt-2 flex justify-between border-t px-5 py-3 text-xs'>
        <span className='text-muted-foreground'>{t('Your rank')}</span>
        <span className='font-mono'>{myRank ? `#${myRank.rank}` : '—'}</span>
      </div>
    </section>
  )
}
