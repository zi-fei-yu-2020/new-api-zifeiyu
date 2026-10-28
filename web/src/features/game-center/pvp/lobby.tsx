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
import { Move, Swords, Timer, Trophy, Users, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  formatNumber,
  formatQuota,
  getEditableQuotaStep,
  parseQuotaFromDollars,
  quotaUnitsToDollars,
} from '@/lib/format'

import {
  createPvPFriendly,
  getPvPStatus,
  joinPvPFriendly,
  joinPvPQueue,
  leavePvPQueue,
  listPvPMatches,
  type PvPMatchView,
} from './api'
import { DuelArena } from './duel-arena'
import { DUEL_DURATION } from './duel-engine'
import { DuelReplay } from './replay'
import { useDuelSession } from './use-duel-session'

function opponentLabel(match: PvPMatchView, t: (key: string) => string) {
  if (!match.opponent.id) return t('Waiting for an opponent')
  return match.opponent.display_name || match.opponent.name
}

function duelOutcomeLabel(
  winnerSlot: number,
  mySlot: number,
  t: (key: string) => string
) {
  if (winnerSlot === 3) return t('Draw')
  if (winnerSlot === mySlot) return t('Victory')
  return t('Defeat')
}

function upgradeLabel(choice: number, t: (key: string) => string) {
  if (choice === 1) return t('Power')
  if (choice === 2) return t('Agility')
  return t('Multishot')
}

function matchResultLabel(result: string, t: (key: string) => string) {
  if (result === 'win') return t('Victory')
  if (result === 'lose') return t('Defeat')
  return t('Draw')
}

function matchResultClass(result: string) {
  if (result === 'win') return 'text-emerald-600'
  if (result === 'lose') return 'text-red-600'
  return 'text-muted-foreground'
}

function reportError(
  error: unknown,
  fallback: string,
  t: (key: string) => string
) {
  const message = error instanceof Error && error.message ? error.message : ''
  toast.error(message ? t(message) : t(fallback))
}

export function PvpLobby() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const status = useQuery({
    queryKey: ['pvp-status'],
    queryFn: ({ signal }) => getPvPStatus(signal),
    refetchOnWindowFocus: false,
    staleTime: 0,
    meta: { errorToast: false },
    refetchInterval: (query) => {
      const match = query.state.data?.match
      if (match && match.status === 'playing') return false
      return 3000
    },
  })
  const session = useDuelSession(() => {
    void queryClient.invalidateQueries({ queryKey: ['pvp-status'] })
    void queryClient.invalidateQueries({ queryKey: ['pvp-matches'] })
    void queryClient.invalidateQueries({ queryKey: ['user'] })
  })
  const { install } = session
  const sessionMatch = session.match
  const active = sessionMatch ?? status.data?.match ?? null
  const [dismissed, setDismissed] = useState<string | null>(null)
  useEffect(() => {
    const view = status.data?.match
    if (!view || view.id === dismissed) return
    if (sessionMatch?.id === view.id && sessionMatch.status === view.status) {
      return
    }
    install(view)
  }, [status.data, sessionMatch?.id, sessionMatch?.status, dismissed, install])
  const leaveResult = () => {
    if (active) setDismissed(active.id)
    install(null)
    void queryClient.invalidateQueries({ queryKey: ['pvp-status'] })
  }
  const ownedMatch =
    sessionMatch &&
    sessionMatch.id !== dismissed &&
    (sessionMatch.status === 'playing' || sessionMatch.status === 'finished')
      ? sessionMatch
      : null

  if (status.isError) {
    return (
      <div role='alert' className='mb-5 border p-5'>
        <p>{t('Unable to load PvP status')}</p>
        <Button
          variant='outline'
          className='mt-3'
          onClick={() => void status.refetch()}
        >
          {t('Retry')}
        </Button>
      </div>
    )
  }
  if (!status.data) {
    return (
      <div className='border p-5'>
        <p className='text-muted-foreground text-sm'>{t('Loading...')}</p>
      </div>
    )
  }
  if (!status.data.enabled) {
    return (
      <div className='border p-5'>
        <p className='text-sm'>{t('PvP duels are currently disabled')}</p>
      </div>
    )
  }
  const inDuel =
    !!ownedMatch ||
    (active?.status === 'invited' && active.id !== dismissed)
  const waiting = !inDuel && !!status.data.queue
  return (
    <div className='space-y-5'>
      {ownedMatch ? (
        <DuelStage match={ownedMatch} session={session} onExit={leaveResult} />
      ) : null}
      {!ownedMatch && active?.status === 'invited' && active.id !== dismissed ? (
        <InvitePanel match={active} />
      ) : null}
      {!ownedMatch &&
      active?.status === 'finished' &&
      active.id !== dismissed ? (
        <ResultBanner match={active} onBack={leaveResult} />
      ) : null}
      {inDuel ? null : (
        <QueuePanel queue={status.data.queue} bounds={status.data} />
      )}
      {inDuel || waiting ? null : <FriendlyPanel bounds={status.data} />}
      <HistoryPanel />
    </div>
  )
}

function DuelStage({
  match,
  session,
  onExit,
}: {
  match: PvPMatchView
  session: ReturnType<typeof useDuelSession>
  onExit: () => void
}) {
  const { t } = useTranslation()
  const [confirmQuit, setConfirmQuit] = useState(false)
  const { display, input, connection } = session
  const mySlot = match.you.slot
  const me = display.players[mySlot - 1]
  const opponent = display.players[mySlot === 1 ? 1 : 0]
  const seconds = Math.max(0, Math.ceil((DUEL_DURATION - display.tick) / 10))
  const upgradeReady =
    !display.finished &&
    me.upgrades < Math.min(3, Math.floor(display.tick / 200))
  const [stick, setStick] = useState({ x: 0, y: 0 })
  const finished = match.status === 'finished'
  function moveStick(e: React.PointerEvent<HTMLDivElement>) {
    if (finished || !e.currentTarget.hasPointerCapture(e.pointerId)) return
    const rect = e.currentTarget.getBoundingClientRect()
    const dx = e.clientX - rect.left - rect.width / 2
    const dy = e.clientY - rect.top - rect.height / 2
    const length = Math.hypot(dx, dy)
    const factor = Math.min(1, 34 / Math.max(1, length))
    setStick({ x: dx * factor, y: dy * factor })
    input.current.direction =
      length < 10
        ? 0
        : ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 10) % 8) + 1
  }
  return (
    <section className='bg-card min-w-0 border' aria-label={t('PvP duel')}>
      <div className='flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-5'>
        <div className='flex items-center gap-2 text-xs font-medium'>
          <span
            className={`size-1.5 ${finished ? 'bg-foreground' : 'bg-emerald-600'}`}
          />
          {finished ? t('Duel finished') : t('Duel in progress')}
          <span className='text-muted-foreground ml-2'>
            {opponentLabel(match, t)}
          </span>
        </div>
        <span className='text-muted-foreground text-xs'>
          {t('Winner takes all')}: {formatQuota(match.stake * 2)}
        </span>
      </div>
      <div className='grid grid-cols-3 divide-x border-b'>
        <div className='p-3 sm:px-5'>
          <p className='text-muted-foreground text-[11px]'>{t('Your score')}</p>
          <p className='mt-1 font-mono text-xl font-medium sm:text-2xl'>
            {formatNumber(me.score)}
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
            {formatNumber(opponent.score)}
          </p>
        </div>
      </div>
      <div className='text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 border-b px-4 py-2 text-[11px] sm:px-5'>
        <span>
          {t('Your HP')}: {me.hp}/{me.max_hp}
        </span>
        <span>
          {t('Opponent HP')}: {opponent.hp}/{opponent.max_hp}
        </span>
        <span>{t('Damage {{value}}', { value: me.power })}</span>
        <span>{t('Targets {{count}}', { count: 1 + me.extra_targets })}</span>
      </div>
      <div className='relative overflow-hidden'>
        <DuelArena state={session.state} mySlot={mySlot} active input={input} />
        {upgradeReady && !finished ? (
          <div className='bg-background/90 absolute top-3 right-3 w-56 border p-3 shadow-sm'>
            <p className='text-xs font-semibold'>{t('Choose your upgrade')}</p>
            <div className='mt-2 grid gap-1'>
              {[1, 2, 3].map((choice) => (
                <Button
                  key={choice}
                  variant='outline'
                  size='sm'
                  className='justify-start'
                  onClick={() => {
                    input.current.upgrade = choice
                  }}
                >
                  {choice}. {upgradeLabel(choice, t)}
                </Button>
              ))}
            </div>
            <p className='text-muted-foreground mt-2 text-[10px]'>
              {t('Combat keeps running while you choose.')}
            </p>
          </div>
        ) : null}
        {finished ? (
          <div className='absolute inset-0 flex items-center justify-center bg-white/35 p-4'>
            <div className='bg-background/95 w-full max-w-[340px] border p-5 text-center shadow-sm sm:p-7'>
              <Trophy className='mx-auto mb-3 size-7 stroke-[1.4]' />
              <h2 className='text-xl font-semibold'>
                {duelOutcomeLabel(match.winner_slot, mySlot, t)}
              </h2>
              <p className='mt-2 text-sm'>
                {t('Quota change')}: {formatQuota(match.you_delta_quota ?? 0)}
              </p>
              <Button className='mt-5 h-11 w-full' onClick={onExit}>
                {t('Back to lobby')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <div
        aria-live='polite'
        className='text-muted-foreground flex min-h-11 flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs'
      >
        <span>
          {connection === 'reconnecting'
            ? t('Reconnecting. The duel clock keeps running.')
            : t('Every move is verified by the server.')}
        </span>
        {!finished ? (
          <Button
            variant='ghost'
            size='sm'
            onClick={() => setConfirmQuit(true)}
          >
            {t('Resign')}
          </Button>
        ) : null}
      </div>
      {!finished ? (
        <div className='game-touch-controls items-center justify-between gap-4 border-t p-4'>
          <div
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
              disabled={display.tick < me.dash_ready}
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
              {display.tick < me.dash_ready
                ? `${((me.dash_ready - display.tick) / 10).toFixed(1)}s`
                : t('Ready')}
            </p>
          </div>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmQuit}
        onOpenChange={(open) => {
          if (!open) setConfirmQuit(false)
        }}
        title={t('Resign this duel?')}
        desc={t(
          'Resigning forfeits the duel and your stake goes to the opponent.'
        )}
        confirmText={t('Resign')}
        destructive
        handleConfirm={() => {
          setConfirmQuit(false)
          void session.quit()
        }}
      />
    </section>
  )
}

function InvitePanel({ match }: { match: PvPMatchView }) {
  const { t } = useTranslation()
  const code = match.invite_code ?? ''
  return (
    <section className='border p-5' aria-label={t('Friendly duel invite')}>
      <div className='flex items-center justify-between text-sm font-medium'>
        <span>{t('Waiting for your friend')}</span>
        <Users className='text-muted-foreground size-4' />
      </div>
      <p className='text-muted-foreground mt-2 text-xs leading-relaxed'>
        {t(
          'Share this code. The duel starts as soon as your friend joins. Unclaimed invites are refunded after 10 minutes.'
        )}
      </p>
      <div className='mt-4 flex items-center gap-2'>
        <span className='font-mono text-2xl tracking-widest'>{code}</span>
        <CopyButton
          value={code}
          variant='outline'
          tooltip={t('Copy invite code')}
        />
      </div>
    </section>
  )
}

function ResultBanner({
  match,
  onBack,
}: {
  match: PvPMatchView
  onBack: () => void
}) {
  const { t } = useTranslation()
  const won = match.winner_slot === match.you.slot
  const draw = match.winner_slot === 3
  return (
    <section className='flex flex-wrap items-center justify-between gap-3 border p-5'>
      <div className='flex items-center gap-3'>
        {draw ? (
          <Timer className='size-5 stroke-[1.5]' />
        ) : (
          <Trophy
            className={`size-5 stroke-[1.5] ${won ? 'text-emerald-600' : 'text-muted-foreground'}`}
          />
        )}
        <div>
          <p className='text-sm font-semibold'>
            {duelOutcomeLabel(match.winner_slot, match.you.slot, t)} ·{' '}
            {opponentLabel(match, t)}
          </p>
          <p className='text-muted-foreground mt-1 text-xs'>
            {t('Quota change')}: {formatQuota(match.you_delta_quota ?? 0)}
          </p>
        </div>
      </div>
      <Button variant='outline' onClick={onBack}>
        {t('Back to lobby')}
      </Button>
    </section>
  )
}

function stakeTiers(min: number, max: number) {
  const tiers = [1, 2, 5, 10].map((factor) => min * factor)
  tiers.push(max)
  return [...new Set(tiers.filter((tier) => tier >= min && tier <= max))].sort(
    (a, b) => a - b
  )
}

function QueuePanel({
  queue,
  bounds,
}: {
  queue: { waiting: boolean; waited_ms: number; stake: number } | null
  bounds: { min_stake: number; max_stake: number }
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [stake, setStake] = useState(bounds.min_stake)
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['pvp-status'] })
  }
  const join = useMutation({
    mutationFn: () => joinPvPQueue(stake),
    onSuccess: (data) => {
      refresh()
      if (data.match) toast.success(t('Opponent found. The duel starts now.'))
    },
    onError: (error: Error) =>
      reportError(error, 'Unable to join the PvP queue', t),
  })
  const leave = useMutation({
    mutationFn: leavePvPQueue,
    onSuccess: refresh,
    onError: (error: Error) =>
      reportError(error, 'Unable to leave the PvP queue', t),
  })
  const tiers = stakeTiers(bounds.min_stake, bounds.max_stake)
  const waited = queue ? Math.floor(queue.waited_ms / 1000) : 0
  return (
    <section className='border p-5' aria-label={t('Ranked matchmaking')}>
      <div className='flex items-center justify-between text-sm font-medium'>
        <span>{t('Ranked matchmaking')}</span>
        <Swords className='text-muted-foreground size-4' />
      </div>
      {queue?.waiting ? (
        <>
          <p className='mt-4 text-sm'>
            {t('Searching for an opponent… {{seconds}}s', { seconds: waited })}
          </p>
          <p className='text-muted-foreground mt-1 text-xs'>
            {t('The balance range widens every 15 seconds. Stake: {{stake}}.', {
              stake: formatQuota(queue.stake),
            })}
          </p>
          <Button
            variant='outline'
            className='mt-4'
            disabled={leave.isPending}
            onClick={() => leave.mutate()}
          >
            {t('Cancel matchmaking')}
          </Button>
        </>
      ) : (
        <>
          <p className='text-muted-foreground mt-2 text-xs leading-relaxed'>
            {t(
              'Both players stake the same amount; the winner takes the pot. Opponents are matched by token balance.'
            )}
          </p>
          <div
            role='group'
            aria-label={t('Stake amount')}
            className='mt-4 flex flex-wrap gap-2'
          >
            {tiers.map((tier) => (
              <Button
                key={tier}
                variant={tier === stake ? 'default' : 'outline'}
                size='sm'
                aria-pressed={tier === stake}
                onClick={() => setStake(tier)}
              >
                {formatQuota(tier)}
              </Button>
            ))}
          </div>
          <p className='text-muted-foreground mt-3 text-xs'>
            {t('Winner takes all')}: {formatQuota(stake * 2)}
          </p>
          <Button
            className='mt-4'
            disabled={join.isPending}
            onClick={() => join.mutate()}
          >
            {t('Find an opponent')}
          </Button>
        </>
      )}
    </section>
  )
}

function FriendlyPanel({
  bounds,
}: {
  bounds: { min_stake: number; max_stake: number }
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [amount, setAmount] = useState(() =>
    String(quotaUnitsToDollars(bounds.min_stake))
  )
  const [code, setCode] = useState('')
  const stake = parseQuotaFromDollars(Number(amount))
  const valid =
    Number.isFinite(Number(amount)) &&
    stake >= bounds.min_stake &&
    stake <= bounds.max_stake
  const create = useMutation({
    mutationFn: () => createPvPFriendly(stake),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pvp-status'] })
    },
    onError: (error: Error) =>
      reportError(error, 'Unable to create a friendly duel', t),
  })
  const join = useMutation({
    mutationFn: () => joinPvPFriendly(code.trim()),
    onSuccess: () => {
      setCode('')
      void queryClient.invalidateQueries({ queryKey: ['pvp-status'] })
    },
    onError: (error: Error) =>
      reportError(error, 'Unable to join the friendly duel', t),
  })
  return (
    <section className='border p-5' aria-label={t('Friendly duel')}>
      <div className='flex items-center justify-between text-sm font-medium'>
        <span>{t('Friendly duel')}</span>
        <Users className='text-muted-foreground size-4' />
      </div>
      <p className='text-muted-foreground mt-2 text-xs leading-relaxed'>
        {t(
          'Play a friend with a custom stake. The stake cannot exceed either player’s balance.'
        )}
      </p>
      <div className='mt-4 grid gap-4 sm:grid-cols-2'>
        <div>
          <label
            htmlFor='pvp-friendly-stake'
            className='text-muted-foreground text-xs'
          >
            {t('Stake amount')} ({formatQuota(bounds.min_stake)} –{' '}
            {formatQuota(bounds.max_stake)})
          </label>
          <Input
            id='pvp-friendly-stake'
            type='number'
            min={0}
            step={getEditableQuotaStep()}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className='mt-1'
          />
          <Button
            className='mt-2'
            disabled={!valid || create.isPending}
            onClick={() => create.mutate()}
          >
            {t('Create duel room')}
          </Button>
        </div>
        <div>
          <label
            htmlFor='pvp-friendly-code'
            className='text-muted-foreground text-xs'
          >
            {t('Invite code')}
          </label>
          <Input
            id='pvp-friendly-code'
            value={code}
            maxLength={16}
            placeholder='a1b2c3d4'
            onChange={(e) => setCode(e.target.value)}
            className='mt-1'
          />
          <Button
            className='mt-2'
            disabled={code.trim().length < 4 || join.isPending}
            onClick={() => join.mutate()}
          >
            {t('Join duel')}
          </Button>
        </div>
      </div>
    </section>
  )
}

function HistoryPanel() {
  const { t } = useTranslation()
  const [page, setPage] = useState(1)
  const [replayId, setReplayId] = useState<string | null>(null)
  const matches = useQuery({
    queryKey: ['pvp-matches', page],
    queryFn: ({ signal }) => listPvPMatches(page, 10, signal),
    refetchOnWindowFocus: false,
    meta: { errorToast: false },
  })
  const items = matches.data?.items ?? []
  const total = matches.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / 10))
  function matchList() {
    if (matches.isError) {
      return (
        <p className='mt-4 text-sm' role='alert'>
          {t('Unable to load PvP matches')}
        </p>
      )
    }
    if (items.length === 0) {
      return (
        <p className='text-muted-foreground mt-4 text-sm'>
          {t('No duels yet. Your finished matches appear here with replays.')}
        </p>
      )
    }
    return (
      <ul className='mt-4 divide-y'>
        {items.map((item) => (
          <li
            key={item.id}
            className='flex flex-wrap items-center justify-between gap-2 py-3'
          >
            <div className='min-w-0'>
              <p className='truncate text-sm font-medium'>
                {item.opponent_name || '—'}
                <span className='text-muted-foreground ml-2 text-xs font-normal'>
                  {item.mode === 'friendly' ? t('Friendly') : t('Ranked')}
                </span>
              </p>
              <p className='text-muted-foreground mt-0.5 font-mono text-xs'>
                {formatNumber(item.my_score)} :{' '}
                {formatNumber(item.opponent_score)} · {formatQuota(item.stake)}
              </p>
            </div>
            <div className='flex items-center gap-2'>
              {item.status === 'finished' ? (
                <span
                  className={`text-xs font-medium ${matchResultClass(item.result)}`}
                >
                  {matchResultLabel(item.result, t)}
                </span>
              ) : (
                <span className='text-muted-foreground text-xs'>
                  {item.status === 'playing'
                    ? t('Duel in progress')
                    : t('Awaiting opponent')}
                </span>
              )}
              {item.status === 'finished' ? (
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => setReplayId(item.id)}
                >
                  {t('Replay')}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    )
  }
  return (
    <section className='border p-5' aria-label={t('PvP match history')}>
      <div className='flex items-center justify-between text-sm font-medium'>
        <span>{t('PvP match history')}</span>
        <span className='text-muted-foreground text-xs font-normal'>
          {formatNumber(total)} {t('duels')}
        </span>
      </div>
      {replayId ? (
        <div className='mt-4'>
          <DuelReplay matchId={replayId} onClose={() => setReplayId(null)} />
        </div>
      ) : null}
      {matchList()}
      {pages > 1 ? (
        <div className='mt-4 flex items-center justify-end gap-2'>
          <Button
            variant='outline'
            size='sm'
            disabled={page <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            {t('Previous')}
          </Button>
          <span className='text-muted-foreground font-mono text-xs'>
            {page} / {pages}
          </span>
          <Button
            variant='outline'
            size='sm'
            disabled={page >= pages}
            onClick={() => setPage((value) => Math.min(pages, value + 1))}
          >
            {t('Next')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
