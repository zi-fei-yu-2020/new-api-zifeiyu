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
import { useTranslation } from 'react-i18next'

import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'

import type { ApplicationStats, ConversionRow } from '../lib/stats'

type StatsProps = { stats: ApplicationStats }

export function StatTiles(props: StatsProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const tiles = [
    {
      label: t('Applications'),
      value: formatNumber(props.stats.total, locale),
    },
    {
      label: t('Last 7 days'),
      value: formatNumber(props.stats.thisWeek, locale),
    },
    {
      label: t('Interviewing'),
      value: formatNumber(props.stats.interviewing, locale),
    },
    { label: t('Offers'), value: formatNumber(props.stats.offers, locale) },
    {
      label: t('Interview rate'),
      value: `${formatNumber(props.stats.interviewRate, locale)}%`,
    },
  ]
  return (
    <dl className='grid grid-cols-2 gap-2 sm:grid-cols-5'>
      {tiles.map((tile) => (
        <div key={tile.label} className='border border-black px-3 py-2'>
          <dt className='text-muted-foreground text-xs'>{tile.label}</dt>
          <dd className='text-xl font-semibold tabular-nums'>{tile.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Insights(props: StatsProps) {
  const { t } = useTranslation()
  if (!props.stats.insights.length) return null
  return (
    <ul className='space-y-2' aria-label={t('Coach insights')}>
      {props.stats.insights.map((insight) => (
        <li
          key={insight.key + JSON.stringify(insight.values ?? {})}
          className='border-l-2 border-black bg-neutral-50 px-3 py-2 text-sm'
        >
          {t(insight.key, insight.values)}
        </li>
      ))}
    </ul>
  )
}

type ConversionTableProps = { title: string; rows: ConversionRow[] }

export function ConversionTable(props: ConversionTableProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  if (!props.rows.length) return null
  return (
    <table className='w-full border-collapse text-sm'>
      <caption className='py-1 text-left font-semibold'>{props.title}</caption>
      <thead>
        <tr className='border-b border-black text-left'>
          <th className='py-1 pr-2 font-medium'>{props.title}</th>
          <th className='py-1 pr-2 font-medium'>{t('Applications')}</th>
          <th className='py-1 pr-2 font-medium'>{t('Interviews')}</th>
          <th className='py-1 font-medium'>{t('Interview rate')}</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <tr key={row.name} className='border-b border-neutral-200'>
            <td className='py-1 pr-2'>{row.name || t('Uncategorized')}</td>
            <td className='py-1 pr-2 tabular-nums'>
              {formatNumber(row.total, locale)}
            </td>
            <td className='py-1 pr-2 tabular-nums'>
              {formatNumber(row.interviews, locale)}
            </td>
            <td className='py-1 tabular-nums'>
              {formatNumber(row.rate, locale)}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
