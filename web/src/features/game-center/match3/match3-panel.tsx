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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatNumber } from '@/lib/format'
import { getServerErrorSources } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { Leaderboard } from '../leaderboard'
import { WeeklyRewards } from '../weekly-rewards'
import type { Match3Session } from './actions'
import {
  getMatchRankings,
  startMatch,
  type MatchMode,
  type MatchRun,
  type MatchStatus,
} from './api'
import { Match3Board } from './board'
import { Match3BossView } from './boss-view'
import {
  MATCH_COMPLETED,
  MATCH_DAILY_LEVEL_OFFSET,
  MATCH_LOST,
  MATCH_MODE_DAILY,
} from './engine'
import { Match3Overlay } from './match3-overlay'
import { match3StatusQueryOptions } from './query-options'
import { Match3SkillsBar } from './skills-bar'
import { playMatchTone } from './sound'
import { useMatch3LowMotion, useMatch3Prefs, useMatch3Store } from './store'
import { matchSkillForHotkey } from './theme'
import { Match3Tray } from './tray'
import { hasOpenDialog, isEditableTarget, useBossKey } from './use-boss-key'
import { useMatch3Local } from './use-match3-local'
import { useMatch3Run } from './use-match3-run'

type PlayMode = 'practice' | MatchMode

// The tile game tab. The three sessions (practice, daily, ranked endless) are
// always mounted so a running server run keeps syncing while another mode or
// tab is on screen; only the selected one is drawn and takes keyboard input.
export function Match3Panel(props: { visible?: boolean }) {
  const visible = props.visible ?? true
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const status = useQuery(match3StatusQueryOptions)
  const userId = useAuthStore((state) => state.auth.user?.id)
  const prefs = useMatch3Prefs(userId)
  const lowMotion = useMatch3LowMotion(userId)
  const [picked, setPicked] = useState<PlayMode | null>(null)
  const [confirm, setConfirm] = useState<'start' | 'quit' | null>(null)

  const onFinish = () => {
    void queryClient.invalidateQueries({ queryKey: ['match3-status'] })
    void queryClient.invalidateQueries({ queryKey: ['match3-rankings'] })
  }
  const local = useMatch3Local(userId)
  const daily = useMatch3Run('daily', onFinish)
  const endless = useMatch3Run('endless', onFinish)

  let mode: PlayMode = 'practice'
  if (picked) mode = picked
  else if (status.data?.endless_run?.status === 'running') mode = 'endless'
  else if (status.data?.daily_run?.status === 'running') mode = 'daily'
  const serverSession = mode === 'daily' ? daily : endless
  const session: Match3Session = mode === 'practice' ? local : serverSession
  const run = mode === 'practice' ? undefined : serverSession.run
  const state = session.state

  // Adopt the run the server reports; a refetch of the run already on screen
  // must not rewind it.
  const statusData = status.data
  const installDaily = daily.install
  const installEndless = endless.install
  const dailyId = daily.run?.id
  const endlessId = endless.run?.id
  useEffect(() => {
    const next = statusData?.daily_run
    if (next && next.id !== dailyId) installDaily(next)
  }, [statusData, dailyId, installDaily])
  useEffect(() => {
    const next = statusData?.endless_run
    if (next && next.id !== endlessId) installEndless(next)
  }, [statusData, endlessId, installEndless])

  const bossKey = useBossKey({ enabled: visible })
  const frozen = bossKey.hidden || !visible
  const sessions = useRef([local, daily, endless])
  sessions.current = [local, daily, endless]
  useEffect(() => {
    for (const each of sessions.current) each.setPaused(frozen)
  }, [frozen])

  const latest = useRef({ session, usable: false })
  latest.current = {
    session,
    usable: visible && !bossKey.hidden && confirm === null,
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const kind = matchSkillForHotkey(event.key)
      if (!kind || event.repeat || event.altKey || event.ctrlKey) return
      if (event.metaKey || !latest.current.usable) return
      if (isEditableTarget(event.target) || hasOpenDialog()) return
      event.preventDefault()
      latest.current.session.skill(kind)
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])

  const muted = prefs.muted
  // Tones follow the player's own moves: switching mode or adopting another run
  // only reseeds the baseline.
  const sessionKey = `${mode}:${run?.id ?? ''}`
  const previous = useRef({
    key: sessionKey,
    cleared: state.cleared,
    status: state.status,
  })
  useEffect(() => {
    const before = previous.current
    previous.current = {
      key: sessionKey,
      cleared: state.cleared,
      status: state.status,
    }
    if (before.key !== sessionKey || muted || !visible) return
    if (state.status === MATCH_LOST && before.status !== MATCH_LOST) {
      playMatchTone('lose')
    } else if (state.cleared > before.cleared) {
      playMatchTone('clear')
    }
  }, [sessionKey, state.cleared, state.status, muted, visible])

  const start = useMutation({
    mutationFn: () => startMatch(mode === 'daily' ? 'daily' : 'endless'),
    onSuccess: (next: MatchRun) => {
      serverSession.install(next)
      queryClient.setQueryData<MatchStatus>(['match3-status'], (current) => {
        if (!current) return current
        if (next.mode === 'daily') return { ...current, daily_run: next }
        return { ...current, endless_run: next }
      })
      setConfirm(null)
    },
    onError: (error: Error) => {
      const sources = getServerErrorSources(error)
      const has = (message: string) =>
        sources.some(
          (source) =>
            source.message_key === message || source.message === message
        )
      setConfirm(null)
      if (has('The tile game is currently closed')) {
        toast.error(t('The tile game is currently closed'))
        return
      }
      if (has('No daily tile game attempt is left today')) {
        toast.error(t('No daily tile game attempt is left today'))
        return
      }
      toast.error(t('Unable to start the tile game. Please try again'))
    },
  })

  const closed = status.data ? !status.data.settings.enabled : false
  const weeklyPrizes = status.data?.weekly_prizes ?? [0, 0, 0]
  const connectionLabel =
    session.connection === 'reconnecting'
      ? t('Reconnecting. Your moves are kept and will be sent again.')
      : t('Pick uncovered tiles. Three of a kind clear from the tray.')
  const dailyMode = state.mode === MATCH_MODE_DAILY
  const levelNumber = dailyMode
    ? state.level - MATCH_DAILY_LEVEL_OFFSET
    : state.level
  const levelTotal = dailyMode
    ? state.level_cap - MATCH_DAILY_LEVEL_OFFSET
    : state.level_cap

  let overlay = null
  if (mode !== 'practice' && run === null) {
    overlay = (
      <Match3Overlay
        title={mode === 'daily' ? t('Daily tile run') : t('Ranked endless run')}
        body={
          closed
            ? t('The tile game is currently closed')
            : t('Clear every tile before the tray fills up.')
        }
        actionLabel={t('Start run')}
        actionDisabled={closed || status.isPending || start.isPending}
        onAction={() => setConfirm('start')}
      />
    )
  } else if (!session.active) {
    let title = t('Run ended')
    if (state.status === MATCH_COMPLETED) title = t('All levels cleared')
    if (state.status === MATCH_LOST) title = t('The tray is full')
    const finishedDaily = mode === 'daily'
    overlay = (
      <Match3Overlay
        title={title}
        body={
          finishedDaily
            ? t('Your daily attempt has been used. Come back after the reset.')
            : t('Your score has been recorded.')
        }
        score={state.score}
        actionLabel={finishedDaily ? undefined : t('Play again')}
        actionDisabled={start.isPending}
        onAction={
          mode === 'practice'
            ? () => void local.restart()
            : () => setConfirm('start')
        }
      />
    )
  }

  return (
    <div className='match3' data-low-motion={lowMotion ? 'true' : 'false'}>
      <header className='mb-5 flex flex-wrap items-end justify-between gap-4'>
        <div>
          <h1 className='text-3xl font-semibold tracking-tight sm:text-[38px]'>
            {t('Tile Match')}
          </h1>
          <p className='text-muted-foreground mt-2 text-sm sm:text-base'>
            {t('Stack, pick and clear. Seven slots, no mistakes.')}
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <Badge variant='outline'>
            {t('Rank {{rank}}', { rank: status.data?.profile.rank ?? 0 })}
          </Badge>
          <Badge variant='secondary'>
            {t('Best level {{level}}', {
              level: Math.max(status.data?.profile.best_level ?? 0, prefs.best),
            })}
          </Badge>
        </div>
      </header>
      {status.isError ? (
        <div role='alert' className='mb-5 border p-5'>
          <p>{t('Unable to load the tile game')}</p>
          <Button
            variant='outline'
            className='mt-3'
            onClick={() => void status.refetch()}
          >
            {t('Retry')}
          </Button>
        </div>
      ) : null}
      <ToggleGroup
        value={[mode]}
        onValueChange={(values) => {
          const next = values.find((value) => value !== mode)
          if (next) setPicked(next as PlayMode)
        }}
        aria-label={t('Game mode')}
        variant='outline'
        className='mb-5'
      >
        <ToggleGroupItem value='practice'>{t('Practice')}</ToggleGroupItem>
        <ToggleGroupItem value='daily'>{t('Daily')}</ToggleGroupItem>
        <ToggleGroupItem value='endless'>{t('Ranked endless')}</ToggleGroupItem>
      </ToggleGroup>
      <div className='grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]'>
        <section
          className='bg-card min-w-0 border'
          aria-label={t('Tile Match')}
        >
          <div className='grid grid-cols-3 divide-x border-b'>
            <div className='p-3 sm:px-5'>
              <p className='text-muted-foreground text-[11px]'>{t('Score')}</p>
              <p className='mt-1 font-mono text-xl font-medium sm:text-2xl'>
                {formatNumber(state.score)}
              </p>
            </div>
            <div className='p-3 sm:px-5'>
              <p className='text-muted-foreground text-[11px]'>{t('Level')}</p>
              <p className='mt-1 font-mono text-xl font-medium sm:text-2xl'>
                {levelNumber}/{levelTotal}
              </p>
            </div>
            <div className='p-3 sm:px-5'>
              <p className='text-muted-foreground text-[11px]'>
                {t('Best combo')}
              </p>
              <p className='mt-1 font-mono text-xl font-medium sm:text-2xl'>
                {state.best_combo}
              </p>
            </div>
          </div>
          <div className='relative p-3 sm:p-5'>
            <div inert={overlay !== null}>
              <Match3Board state={state} onPick={session.pick} />
            </div>
            {overlay}
          </div>
          <div className='space-y-3 border-t p-3 sm:p-5'>
            <Match3Tray state={state} />
            <Match3SkillsBar
              state={state}
              getTick={session.tick}
              running={session.active && !frozen}
              disabled={!session.active || frozen}
              onSkill={session.skill}
            />
          </div>
          <div
            aria-live='polite'
            className='text-muted-foreground flex min-h-11 flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs'
          >
            <span>{connectionLabel}</span>
            <span className='flex items-center gap-1'>
              <Button variant='ghost' size='sm' onClick={bossKey.hide}>
                {t('Hide page')}
                <Kbd aria-hidden='true'>`</Kbd>
              </Button>
              {session.active ? (
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => setConfirm('quit')}
                >
                  {t('End run')}
                </Button>
              ) : null}
            </span>
          </div>
          <p className='text-muted-foreground border-t px-4 py-3 text-xs leading-6 sm:px-5'>
            {t(
              'Tab to the board, move with the arrow keys, pick with Enter or Space. Skills are on 1, 2 and 3.'
            )}
          </p>
        </section>
        <aside className='space-y-5'>
          <section className='border p-5' aria-label={t('Display and sound')}>
            <div className='flex items-center justify-between gap-4'>
              <Label htmlFor='match3-low-motion'>{t('Reduce motion')}</Label>
              <Switch
                id='match3-low-motion'
                checked={lowMotion}
                disabled={userId === undefined}
                onCheckedChange={(checked) => {
                  if (userId === undefined) return
                  useMatch3Store
                    .getState()
                    .setLowMotion(userId, checked ? 'on' : 'off')
                }}
              />
            </div>
            <div className='mt-4 flex items-center justify-between gap-4'>
              <Label htmlFor='match3-muted'>{t('Mute sound')}</Label>
              <Switch
                id='match3-muted'
                checked={muted}
                disabled={userId === undefined}
                onCheckedChange={(checked) => {
                  if (userId === undefined) return
                  useMatch3Store.getState().setMuted(userId, checked)
                }}
              />
            </div>
          </section>
          <WeeklyRewards
            prizes={weeklyPrizes}
            total={status.data?.weekly_total ?? 0}
            enabled={status.data?.weekly_rewards_enabled}
            unavailable={status.isError}
            retry={() => void status.refetch()}
          />
          <Leaderboard
            weeklyPrizes={weeklyPrizes}
            queryKey='match3-rankings'
            dayLevelOffset={MATCH_DAILY_LEVEL_OFFSET}
            fetchRankings={(period: 'day' | 'week') =>
              getMatchRankings(period === 'day' ? 'daily' : 'endless')
            }
            dayHint={t('Daily tile run. Highest score wins.')}
            weekHint={t('Ranked endless. Best run this week.')}
          />
        </aside>
      </div>
      <ConfirmDialog
        open={confirm === 'start'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
        title={t('Start a tile run?')}
        desc={
          mode === 'daily'
            ? t(
                'Starting uses today’s only daily attempt. Leaving or refreshing does not reset your run.'
              )
            : t(
                'Your score counts toward this week’s ranking. Leaving or refreshing does not reset your run.'
              )
        }
        confirmText={t('Start run')}
        isLoading={start.isPending}
        handleConfirm={() => start.mutate()}
      />
      <ConfirmDialog
        open={confirm === 'quit'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
        title={t('End this run?')}
        desc={
          mode === 'practice'
            ? t('Your practice game will be discarded.')
            : t('The run ends now and keeps the score you have.')
        }
        confirmText={t('End run')}
        destructive
        handleConfirm={() => {
          void session.quit()
          setConfirm(null)
        }}
      />
      <Match3BossView open={bossKey.hidden} onClose={bossKey.restore} />
    </div>
  )
}
