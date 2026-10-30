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

import { cn } from '@/lib/utils'

import { TileFace } from './board'
import { MATCH_TRAY_CAP, type MatchState } from './engine'
import { MATCH_TILE_THEMES } from './theme'

// The seven-slot tray. The polite live region announces the count, and
// the tile list keeps the order the engine uses (equal types stay adjacent).
export function Match3Tray(props: { state: MatchState }) {
  const { t } = useTranslation()
  const count = props.state.tray.length
  const slots = Array.from({ length: MATCH_TRAY_CAP }, (_, i) => {
    const id = props.state.tray[i]
    if (id === undefined) return { key: `empty-${i}`, type: undefined }
    return { key: `tile-${id}`, type: props.state.tiles[id].type }
  })
  return (
    <section aria-label={t('Tray')} className='match3-tray-wrap'>
      <p
        role='status'
        aria-live='polite'
        className='text-muted-foreground mb-1 font-mono text-xs tabular-nums'
      >
        {t('Tray {{count}}/{{max}}', { count, max: MATCH_TRAY_CAP })}
      </p>
      <ul
        role='list'
        className={cn('match3-tray', count >= MATCH_TRAY_CAP - 1 && 'is-full')}
      >
        {slots.map((slot) => (
          <li
            key={slot.key}
            className='match3-slot'
            data-filled={slot.type === undefined ? undefined : 'true'}
            aria-label={
              slot.type === undefined
                ? t('Empty slot')
                : t(MATCH_TILE_THEMES[slot.type]?.label ?? 'Token')
            }
          >
            {slot.type === undefined ? null : <TileFace type={slot.type} />}
          </li>
        ))}
      </ul>
    </section>
  )
}
