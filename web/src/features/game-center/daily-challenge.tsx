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
import {
  ArrowUpRight,
  Crosshair,
  Gamepad2,
  Move,
  Timer,
  Trophy,
  Zap,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { getSelf } from '@/lib/api'
import { formatNumber, formatQuota } from '@/lib/format'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { getGameRewards, getGameStatus, startGame } from './api'
import { Arena } from './arena'
import { gameDuration, upgradePending } from './engine'
import { Leaderboard } from './leaderboard'
import { UpgradePanel } from './upgrade-panel'
import { useGameSession } from './use-game-session'
import { WeeklyRewards } from './weekly-rewards'

// The daily challenge view, extracted verbatim from the former Game Center
// page body so the PvP tab can live beside it without behavior changes.
function countdown(milliseconds: number) {
  const s = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${Math.floor(s / 3600)
    .toString()
    .padStart(2, '0')}:${Math.floor((s / 60) % 60)
    .toString()
    .padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`
}

export function DailyChallenge() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const status = useQuery({
    queryKey: ['game-status'],
    queryFn: ({ signal }) => getGameStatus(signal),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 0,
  })
  const rewards = useQuery({
    queryKey: ['game-rewards'],
    queryFn: getGameRewards,
    staleTime: 0,
    refetchInterval: 5000,
    refetchOnWindowFocus: 'always',
    meta: { errorToast: false },
  })
  const budgets = rewards.data?.budgets ?? status.data?.budgets
  const weeklyPrizes = [
    budgets?.weekly_first_quota ??
      Math.floor((budgets?.weekly_pool ?? 0) * 0.3),
    budgets?.weekly_second_quota ??
      Math.floor((budgets?.weekly_pool ?? 0) * 0.2),
    budgets?.weekly_third_quota ??
      Math.floor((budgets?.weekly_pool ?? 0) * 0.15),
  ]
  const session = useGameSession(() => {
    void queryClient.invalidateQueries({ queryKey: ['game-status'] })
    void queryClient.invalidateQueries({ queryKey: ['game-rankings'] })
    void queryClient.invalidateQueries({ queryKey: ['user'] })
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    void queryClient.invalidateQueries({ queryKey: ['game-rewards'] })
  })
  const { run, display, input, install } = session
  const { data: statusData, refetch: refetchStatus } = status
  const [confirm, setConfirm] = useState<'start' | 'quit' | null>(null)
  const [clock, setClock] = useState(Date.now())
  const joystick = useRef<HTMLDivElement>(null)
  const arenaPanel = useRef<HTMLElement>(null)
  const [stick, setStick] = useState({ x: 0, y: 0 })
  const active = run?.status === 'running'
  useEffect(() => {
    if (active && window.matchMedia('(max-width: 639px)').matches) {
      arenaPanel.current?.scrollIntoView({ block: 'start' })
    }
  }, [active])
  const finished = !!run && !active
  const userId = useAuthStore((state) => state.auth.user?.id)
  const balance = useQuery({
    queryKey: ['game-balance', userId, run?.id],
    queryFn: async () => requireServerSuccess(await getSelf()).data,
    enabled: finished && !!userId,
    retry: 1,
    staleTime: 0,
  })
  useEffect(() => {
    const auth = useAuthStore.getState().auth
    if (
      balance.data?.id === userId &&
      auth.user?.id === userId &&
      balance.data
    ) {
      auth.setUser(balance.data)
    }
  }, [balance.data, userId])
  const available =
    !!(rewards.data?.enabled ?? status.data?.settings.enabled) &&
    !!budgets?.can_start &&
    !run
  const start = useMutation({
    mutationFn: startGame,
    onSuccess: (next) => {
      session.install(next)
      setConfirm(null)
    },
    onError: (error: Error) => {
      if (
        error.message === 'The daily reward budget cannot cover another run'
      ) {
        toast.error(t('The daily reward budget cannot cover another run'))
        return
      }
      if (error.message === 'The daily challenge is currently closed') {
        toast.error(t('The daily challenge is currently closed'))
        return
      }
      toast.error(t('Unable to start the daily challenge. Please try again'))
    },
  })
  useEffect(() => {
    if (statusData) install(statusData.run)
  }, [statusData, install])
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const serverClock = status.data
    ? status.data.server_time + (clock - status.dataUpdatedAt)
    : clock
  const resetIn = status.data ? status.data.resets_at - serverClock : 0
  useEffect(() => {
    if (statusData && resetIn <= 0 && !active) void refetchStatus()
  }, [resetIn, active, statusData, refetchStatus])
  const seconds = Math.max(
    0,
    Math.ceil((gameDuration(display) - display.tick) / 10)
  )
  const canUpgrade =
    active &&
    (display.version >= 2
      ? upgradePending(display)
      : display.upgrades < Math.min(5, Math.floor(display.tick / 300)))
  let upgradeRules = t(
    'Choose an upgrade every 30 seconds with 1, 2 or 3. Stronger enemies arrive as time passes. Refreshing does not pause or reset your run.'
  )
  if (display.version >= 2) {
    upgradeRules = t(
      'At 20, 40 and 60 seconds, combat pauses for an upgrade. Choose with 1, 2 or 3 within 10 seconds; Repair is selected automatically. Leaving or refreshing does not reset your run.'
    )
  }
  if (display.version >= 3) {
    upgradeRules = t(
      'Upgrade at 20, 40 and 60 seconds: damage +2, move and fire rate +25% of base, or one extra target. Combat pauses for up to 10 seconds; Multishot is selected automatically.'
    )
  }
  let runTitle = t('One chance. Your best run.')
  if (finished) runTitle = t('Well played')
  if (run?.status === 'survived') runTitle = t('Challenge complete')
  if (run?.status === 'abandoned') runTitle = t('Run ended')
  let startLabel = t('Start today’s challenge')
  if (!(rewards.data?.enabled ?? status.data?.settings.enabled)) {
    startLabel = t('Challenge closed')
  }
  if (budgets && !budgets.can_start) {
    startLabel = t('Daily reward budget exhausted')
  }
  if (status.isPending) startLabel = t('Loading...')
  const firstReward = budgets?.first_token_quota ?? 0
  const additionalReward = budgets?.subsequent_token_quota ?? 0
  const runFirstReward = run?.first_token_quota ?? firstReward
  const runAdditionalReward = run?.subsequent_token_quota ?? additionalReward
  const hasDifferentRunRewards =
    !!run &&
    (runFirstReward !== firstReward || runAdditionalReward !== additionalReward)
  const pickupCount = run?.state.picked_tokens ?? 0
  const estimatedReward =
    pickupCount > 0
      ? runFirstReward + (pickupCount - 1) * runAdditionalReward
      : 0
  let connectionLabel = t('Same arena. Same rules. Everyone starts equal.')
  if (active) {
    connectionLabel = t('{{count}} tokens · Reward {{reward}}', {
      count: formatNumber(pickupCount),
      reward: formatQuota(estimatedReward),
    })
  }
  if (session.connection === 'reconnecting') {
    connectionLabel = t('Reconnecting. The challenge clock keeps running.')
  }
  function moveStick(e: React.PointerEvent<HTMLDivElement>) {
    if (
      !active ||
      canUpgrade ||
      !e.currentTarget.hasPointerCapture(e.pointerId)
    ) {
      return
    }
    const rect = e.currentTarget.getBoundingClientRect(),
      dx = e.clientX - rect.left - rect.width / 2,
      dy = e.clientY - rect.top - rect.height / 2
    const length = Math.hypot(dx, dy),
      factor = Math.min(1, 34 / Math.max(1, length))
    setStick({ x: dx * factor, y: dy * factor })
    input.current.direction =
      length < 10
        ? 0
        : ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 10) % 8) + 1
  }
  return (
    <>
      <header className='mb-7 flex flex-wrap items-end justify-between gap-5'>
        <div>
          <div className='text-muted-foreground mb-3 flex items-center gap-2 text-xs font-medium tracking-widest'>
            <Gamepad2 className='size-4' />
            {t('Game Center')}
            <span className='text-border mx-1'>/</span>
            <span className='font-mono'>{status.data?.day ?? '—'}</span>
          </div>
          <h1 className='text-3xl font-semibold tracking-tight sm:text-[38px]'>
            {t('Token Survivor')}
          </h1>
          <p className='text-muted-foreground mt-2 text-sm sm:text-base'>
            {t(
              display.version < 2
                ? 'Survive 180 seconds. Make your mark on the global leaderboard.'
                : 'Survive 90 seconds. Three upgrades. A tougher final wave.'
            )}
          </p>
        </div>
        <div className='flex items-center gap-5 border-l pl-5 text-sm'>
          <div>
            <p className='text-muted-foreground text-xs'>
              {t('Next daily challenge')}
            </p>
            <p className='mt-1 font-mono text-xl tabular-nums'>
              {countdown(resetIn)}
            </p>
          </div>
          <span className='text-muted-foreground self-end pb-1 text-xs'>
            UTC+8
          </span>
        </div>
      </header>
      {status.isError ? (
        <div role='alert' className='mb-5 border p-5'>
          <p>{t('Unable to load the daily challenge')}</p>
          <Button
            variant='outline'
            onClick={() => void status.refetch()}
            className='mt-3'
          >
            {t('Retry')}
          </Button>
        </div>
      ) : null}
      <div className='grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]'>
        <section
          ref={arenaPanel}
          className='bg-card min-w-0 scroll-mt-20 border'
          aria-label={t('Daily challenge')}
        >
          <div className='flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-5'>
            <div className='flex items-center gap-2 text-xs font-medium'>
              <span
                className={`size-1.5 ${active ? 'bg-emerald-600' : 'bg-foreground'}`}
              />
              {active ? t('Challenge in progress') : t('Daily challenge')}
              <span className='text-muted-foreground ml-2'>
                {t('One run per day')}
              </span>
            </div>
            <span className='text-muted-foreground font-mono text-xs'>
              01 / 01
            </span>
          </div>
          <div className='grid grid-cols-3 divide-x border-b'>
            <div className='p-3 sm:px-5'>
              <p className='text-muted-foreground text-[11px]'>{t('Score')}</p>
              <p className='mt-1 font-mono text-xl font-medium sm:text-2xl'>
                {formatNumber(display.score)}
              </p>
            </div>
            <div className='p-3 sm:px-5'>
              <p className='text-muted-foreground text-[11px]'>
                {t('Time remaining')}
              </p>
              <p className='mt-1 font-mono text-xl font-medium tabular-nums sm:text-2xl'>
                {Math.floor(seconds / 60)}:
                {String(seconds % 60).padStart(2, '0')}
              </p>
            </div>
            <div className='p-3 sm:px-5'>
              <p className='text-muted-foreground text-[11px]'>
                {t('Integrity')}
              </p>
              <div className='mt-2 flex items-center gap-2'>
                <span className='font-mono text-lg'>{display.hp}</span>
                <div className='bg-muted h-1.5 flex-1'>
                  <div
                    className='bg-foreground h-full'
                    style={{
                      width: `${(100 * display.hp) / display.max_hp}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
          {display.version >= 3 && (
            <div
              aria-label={t('Combat upgrades')}
              className='text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 border-b px-4 py-2 text-[11px] sm:px-5'
            >
              <span>{t('Damage {{value}}', { value: display.power })}</span>
              <span>
                {t('Move/fire {{value}}%', {
                  value: 100 + 25 * (display.haste ?? 0),
                })}
              </span>
              <span>
                {t('Targets {{count}}', {
                  count: 1 + (display.extra_targets ?? 0),
                })}
              </span>
            </div>
          )}
          <div className='relative overflow-hidden'>
            <Arena
              state={session.state}
              input={input}
              active={!!run}
              controlsDisabled={!!canUpgrade}
            />
            {!active && (
              <div className='absolute inset-0 flex items-center justify-center bg-white/35 p-4'>
                <div className='bg-background/95 w-full max-w-[340px] border p-5 text-center shadow-sm sm:p-7'>
                  {finished ? (
                    <Trophy className='mx-auto mb-3 size-7 stroke-[1.4]' />
                  ) : (
                    <Crosshair className='mx-auto mb-3 size-8 stroke-[1.4]' />
                  )}
                  <h2 className='text-xl font-semibold'>{runTitle}</h2>
                  <p className='text-muted-foreground mt-2 text-sm leading-relaxed'>
                    {finished
                      ? t(
                          'Your daily attempt has been used. Come back after the reset.'
                        )
                      : t(
                          'Move, dodge, collect. Your weapon fires automatically.'
                        )}
                  </p>
                  {finished ? (
                    <>
                      <p className='mt-4 font-mono text-3xl font-medium'>
                        {formatNumber(run.score)}
                        <span className='text-muted-foreground ml-2 font-sans text-xs font-normal'>
                          {t('points')}
                        </span>
                      </p>
                      <p className='mt-2 text-sm'>
                        {t('Quota awarded')}: {formatQuota(run.quota_awarded)}
                      </p>
                    </>
                  ) : (
                    <Button
                      className='mt-5 h-11 w-full'
                      disabled={
                        !available || status.isPending || start.isPending
                      }
                      onClick={() => setConfirm('start')}
                    >
                      {startLabel}
                      <ArrowUpRight className='ml-2 size-4' />
                    </Button>
                  )}
                </div>
              </div>
            )}
            {canUpgrade && (
              <UpgradePanel
                state={display}
                onChoose={(choice) => {
                  input.current.upgrade = choice
                }}
              />
            )}
          </div>
          <div
            aria-live='polite'
            className='text-muted-foreground flex min-h-11 flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs'
          >
            <span>{connectionLabel}</span>
            {active ? (
              <Button
                variant='ghost'
                size='sm'
                onClick={() => setConfirm('quit')}
              >
                {t('End run')}
              </Button>
            ) : (
              <span className='font-mono'>{gameDuration(display) / 10}s</span>
            )}
          </div>
          {active && (
            <div className='game-touch-controls items-center justify-between gap-4 border-t p-4'>
              <div
                ref={joystick}
                role='group'
                aria-label={t('Touch movement control')}
                className='bg-muted/40 relative size-24 touch-none rounded-full border select-none'
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId)
                  moveStick(e)
                }}
                onPointerMove={moveStick}
                onPointerUp={(e) => {
                  e.currentTarget.releasePointerCapture(e.pointerId)
                  input.current.direction = 0
                  setStick({ x: 0, y: 0 })
                }}
                onPointerCancel={() => {
                  input.current.direction = 0
                  setStick({ x: 0, y: 0 })
                }}
              >
                <Move className='text-muted-foreground/40 absolute top-1/2 left-1/2 size-5 -translate-1/2' />
                <span
                  className='bg-background pointer-events-none absolute top-1/2 left-1/2 size-9 rounded-full border shadow-sm'
                  style={{
                    transform: `translate(calc(-50% + ${stick.x}px),calc(-50% + ${stick.y}px))`,
                  }}
                />
              </div>
              <div className='text-center'>
                <Button
                  className='h-14 min-w-24 touch-manipulation'
                  disabled={!!canUpgrade || display.tick < display.dash_ready}
                  onPointerDown={() => {
                    input.current.dash = true
                  }}
                  onClick={() => {
                    input.current.dash = true
                  }}
                >
                  <Zap className='mr-2 size-4' />
                  {t('Dash')}
                </Button>
                <p className='text-muted-foreground mt-2 font-mono text-xs'>
                  {display.tick < display.dash_ready
                    ? `${((display.dash_ready - display.tick) / 10).toFixed(1)}s`
                    : t('Ready')}
                </p>
              </div>
            </div>
          )}
          <section
            className='grid border-t px-4 sm:grid-cols-3 sm:px-5'
            aria-label={t('How to play')}
          >
            <article className='py-6 sm:pr-6'>
              <Move className='mb-3 size-5 stroke-[1.5]' />
              <h3 className='text-sm font-semibold'>{t('Move with intent')}</h3>
              <p className='text-muted-foreground mt-2 text-xs leading-6'>
                {t(
                  'WASD or arrow keys to move. Space to dash. On mobile, use the joystick and dash button.'
                )}
              </p>
            </article>
            <article className='border-t py-6 sm:border-t-0 sm:border-l sm:px-6'>
              <Timer className='mb-3 size-5 stroke-[1.5]' />
              <h3 className='text-sm font-semibold'>
                {t('Every second counts')}
              </h3>
              <p className='text-muted-foreground mt-2 text-xs leading-6'>
                {upgradeRules}
              </p>
            </article>
            <article className='border-t py-6 sm:border-t-0 sm:border-l sm:pl-6'>
              <Trophy className='mb-3 size-5 stroke-[1.5]' />
              <h3 className='text-sm font-semibold'>{t('Climb together')}</h3>
              <p className='text-muted-foreground mt-2 text-xs leading-6'>
                {t(
                  'Daily reset at 00:00 UTC+8. Weekly prizes settle after Monday 00:05. Only first, second and third place receive weekly rewards. Ties go to the earliest finish.'
                )}
              </p>
            </article>
          </section>
        </section>
        <aside className='space-y-5'>
          <section className='border p-5'>
            <div className='flex items-center justify-between text-sm font-medium'>
              <span>{t('Pickup rewards')}</span>
              <Zap className='text-muted-foreground size-4' />
            </div>
            <p className='mt-4 font-mono text-3xl font-medium tracking-tight'>
              {formatQuota(firstReward)}
            </p>
            <p className='text-muted-foreground mt-1 text-xs'>
              {t('First collected token')}
            </p>
            <div className='mt-4 flex items-center justify-between text-sm'>
              <span>{t('Each additional token')}</span>
              <strong className='font-mono'>
                {formatQuota(additionalReward)}
              </strong>
            </div>
            <p className='text-muted-foreground mt-3 text-xs leading-relaxed'>
              {t(
                'Rewards are based on tokens collected, not token points. Your reward is credited when the run ends, including early exit.'
              )}
            </p>
            {hasDifferentRunRewards && (
              <p className='text-muted-foreground mt-3 border-t pt-3 text-xs leading-relaxed'>
                {t(
                  'This run keeps its starting rules: {{first}} for the first token, then {{additional}} each. The amounts above apply to new runs.',
                  {
                    first: formatQuota(runFirstReward),
                    additional: formatQuota(runAdditionalReward),
                  }
                )}
              </p>
            )}
            {run && (
              <div className='mt-4 border-t pt-3 text-sm'>
                {t('Tokens collected')}: {formatNumber(pickupCount)}
              </div>
            )}
          </section>
          <WeeklyRewards
            prizes={weeklyPrizes}
            total={budgets?.weekly_pool ?? 0}
            enabled={budgets?.weekly_rewards_enabled}
            unavailable={rewards.isError}
            retry={() => void rewards.refetch()}
          />
          <Leaderboard weeklyPrizes={weeklyPrizes} />
        </aside>
      </div>
      <ConfirmDialog
        open={confirm === 'start'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
        title={t('Start your daily run?')}
        desc={t(
          'Starting uses today’s only attempt. Survive 90 seconds, with up to three 10-second upgrade pauses. Leaving or refreshing does not reset your run.'
        )}
        confirmText={t('Start challenge')}
        isLoading={start.isPending}
        handleConfirm={() => start.mutate()}
      />
      <ConfirmDialog
        open={confirm === 'quit'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
        title={t('End this run?')}
        desc={t(
          run?.reward_version === 2
            ? 'Ending uses your daily attempt. Collected tokens are still rewarded, but this run will not be ranked.'
            : 'This uses your daily attempt. An abandoned run receives no quota and is not ranked.'
        )}
        confirmText={t('End run')}
        destructive
        handleConfirm={() => {
          void session.quit()
          setConfirm(null)
        }}
      />
    </>
  )
}
