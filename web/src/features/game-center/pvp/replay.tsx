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
import { Pause, Play, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { formatQuota } from '@/lib/format'
import { useAuthStore } from '@/stores/auth-store'

import { getPvPReplay } from './api'
import { DuelArena } from './duel-arena'
import {
  createDuelReplayCursor,
  DUEL_DURATION,
  DUEL_TICK_MS,
  newDuel,
  type DuelState,
} from './duel-engine'

const SPEEDS = [0.5, 1, 2, 4]

type Props = { matchId: string; onClose: () => void }

// The replay viewer rebuilds the duel from the recorded batches with the same
// deterministic engine, replaying them in the server's arrival order so the
// rebuilt outcome matches the settled result. A replay cursor advances ordinary
// forward playback incrementally and falls back to full replay for scrubbing.
export function DuelReplay({ matchId, onClose }: Props) {
  const { t } = useTranslation()
  const replay = useQuery({
    queryKey: ['pvp-replay', matchId],
    queryFn: ({ signal }) => getPvPReplay(matchId, signal),
    meta: { errorToast: false },
  })
  const userId = useAuthStore((state) => state.auth.user?.id)
  const [speed, setSpeed] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [tick, setTick] = useState(0)
  const state = useRef<DuelState>(newDuel(0))
  const cursor = useMemo(
    () =>
      replay.data
        ? createDuelReplayCursor(
            replay.data.seed,
            replay.data.started_at,
            replay.data.inputs
          )
        : null,
    [replay.data]
  )

  const seek = useCallback(
    (target: number) => {
      if (!cursor) return
      const next = cursor(target)
      state.current = next
      setTick(next.tick)
    },
    [cursor]
  )

  useEffect(() => {
    if (cursor) seek(0)
  }, [cursor, seek])

  useEffect(() => {
    if (!playing || !replay.data) return
    const timer = window.setInterval(() => {
      const current = state.current
      if (current.finished) {
        setPlaying(false)
        return
      }
      seek(current.tick + 1)
    }, DUEL_TICK_MS / speed)
    return () => clearInterval(timer)
  }, [playing, speed, replay.data, seek])

  if (replay.isError) {
    return (
      <div role='alert' className='border p-5'>
        <p>{t('Unable to load the PvP replay')}</p>
        <Button variant='outline' className='mt-3' onClick={onClose}>
          {t('Back')}
        </Button>
      </div>
    )
  }
  if (!replay.data) {
    return (
      <div className='border p-5'>
        <p className='text-muted-foreground text-sm'>{t('Loading...')}</p>
      </div>
    )
  }
  const mySlot =
    replay.data.players.find((p) => p.user_id === userId)?.slot ?? 1
  const world = state.current
  const you = world.players[mySlot - 1]
  const opponent = world.players[mySlot === 1 ? 1 : 0]
  const youInfo = replay.data.players[mySlot - 1]
  const opponentInfo = replay.data.players[mySlot === 1 ? 1 : 0]
  const seconds = Math.ceil((DUEL_DURATION - tick) / 10)
  return (
    <section className='bg-card border' aria-label={t('PvP duel replay')}>
      <div className='flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-5'>
        <div className='flex items-center gap-3 text-sm'>
          <span className='font-medium'>
            {t('{{name}} (blue)', { name: youInfo?.name ?? '—' })}
          </span>
          <span className='text-muted-foreground'>
            {t('vs {{name}} (red)', { name: opponentInfo?.name ?? '—' })}
          </span>
        </div>
        <div className='flex items-center gap-3 text-sm'>
          <span className='text-muted-foreground'>
            {t('Winner takes all')}: {formatQuota(replay.data.stake * 2)}
          </span>
          <Button
            variant='ghost'
            size='icon'
            aria-label={t('Close')}
            onClick={onClose}
          >
            <X className='size-4' />
          </Button>
        </div>
      </div>
      <div className='grid grid-cols-3 divide-x border-b'>
        <div className='p-3 sm:px-5'>
          <p className='text-muted-foreground text-[11px]'>{t('Your score')}</p>
          <p className='mt-1 font-mono text-xl font-medium sm:text-2xl'>
            {you?.score ?? 0}
          </p>
        </div>
        <div className='p-3 sm:px-5'>
          <p className='text-muted-foreground text-[11px]'>
            {t('Time remaining')}
          </p>
          <p className='mt-1 font-mono text-xl font-medium tabular-nums sm:text-2xl'>
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
          </p>
        </div>
        <div className='p-3 sm:px-5'>
          <p className='text-muted-foreground text-[11px]'>
            {t('Opponent score')}
          </p>
          <p className='mt-1 font-mono text-xl font-medium sm:text-2xl'>
            {opponent?.score ?? 0}
          </p>
        </div>
      </div>
      <DuelArena state={state} mySlot={mySlot} active />
      <div className='flex flex-wrap items-center gap-4 border-t px-4 py-3 sm:px-5'>
        <Button
          variant='outline'
          size='sm'
          aria-label={playing ? t('Pause') : t('Play')}
          onClick={() => setPlaying((value) => !value)}
        >
          {playing ? <Pause className='size-4' /> : <Play className='size-4' />}
        </Button>
        <div
          className='flex gap-1'
          role='group'
          aria-label={t('Playback speed')}
        >
          {SPEEDS.map((option) => (
            <Button
              key={option}
              variant={option === speed ? 'default' : 'outline'}
              size='sm'
              aria-pressed={option === speed}
              onClick={() => setSpeed(option)}
            >
              {option}×
            </Button>
          ))}
        </div>
        <div className='min-w-40 flex-1'>
          <Slider
            value={[tick]}
            onValueChange={(value) =>
              seek(Array.isArray(value) ? value[0] : value)
            }
            min={0}
            max={DUEL_DURATION}
            aria-label={t('Replay position')}
          />
        </div>
        <span className='text-muted-foreground font-mono text-xs tabular-nums'>
          {(tick / 10).toFixed(1)}s / {DUEL_DURATION / 10}s
        </span>
      </div>
    </section>
  )
}
