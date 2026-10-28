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
import { Check, RefreshCw } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useCareerStudioStore } from '@/stores/career-studio-store'

import { planToday } from '../api'
import {
  localToday,
  useCareerWorkspace,
  type CareerModelState,
} from '../hooks/use-career'
import { useCoachAction } from '../hooks/use-coach-action'
import { applicationStats, completedStreak, ruleBasedTasks } from '../lib/stats'
import type { DailyTask } from '../types'
import { CoachRun } from './coach-run'
import { Insights, StatTiles } from './stats-view'

function taskList(titles: string[]): DailyTask[] {
  return titles.map((title, index) => ({
    id: `${Date.now()}-${index}`,
    title,
    done: false,
  }))
}

type TodayPanelProps = { modelState: CareerModelState }

export function TodayPanel(props: TodayPanelProps) {
  const { t } = useTranslation()
  const { userId, workspace, completedDays } = useCareerWorkspace()
  const setDaily = useCareerStudioStore((state) => state.setDaily)
  const toggleTask = useCareerStudioStore((state) => state.toggleTask)
  const action = useCoachAction(props.modelState)
  const today = localToday()
  const stats = useMemo(
    () => applicationStats(workspace.applications, today),
    [workspace.applications, today]
  )
  const rejected = workspace.applications.filter(
    (item) => item.status === 'rejected'
  ).length
  const daily = workspace.daily?.day === today ? workspace.daily : null
  const streak = completedStreak(completedDays, today)
  const ruleTasks = ruleBasedTasks(
    !!workspace.profile.resume.trim(),
    stats.interviewing,
    stats.thisWeek,
    rejected
  )
  const ruleKey = ruleTasks.join('|')

  useEffect(() => {
    if (!userId || daily) return
    setDaily(userId, { day: today, tasks: taskList(ruleKey.split('|')) })
  }, [daily, ruleKey, setDaily, today, userId])

  const done = daily?.tasks.filter((task) => task.done).length ?? 0

  return (
    <div className='space-y-6'>
      <section className='space-y-3' aria-labelledby='career-today-title'>
        <div className='flex flex-wrap items-end justify-between gap-2'>
          <div>
            <h2 id='career-today-title' className='text-lg font-semibold'>
              {t("Today's three tasks")}
            </h2>
            <p className='text-muted-foreground text-sm'>
              {t(
                'You do not have to solve everything. Finish these three and today counts as a win.'
              )}
            </p>
          </div>
          {streak > 0 && (
            <p className='text-sm font-medium'>
              {t('{{count}}-day streak', { count: streak })}
            </p>
          )}
        </div>
        <ul className='space-y-2'>
          {daily?.tasks.map((task) => (
            <li key={task.id}>
              <button
                type='button'
                aria-pressed={task.done}
                onClick={() => toggleTask(userId, task.id)}
                className={cn(
                  'flex w-full items-center gap-3 border border-black px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black',
                  task.done && 'bg-neutral-100 text-neutral-500 line-through'
                )}
              >
                <span
                  aria-hidden='true'
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center border-2 border-black',
                    task.done && 'bg-black text-white'
                  )}
                >
                  {task.done && <Check className='size-3.5' />}
                </span>
                {t(task.title)}
              </button>
            </li>
          ))}
        </ul>
        {daily && done === daily.tasks.length && (
          <p role='status' className='text-sm font-medium'>
            {t('All three done. Well played today.')}
          </p>
        )}
        <CoachRun
          action={action}
          label={t('Plan with AI')}
          disabled={!props.modelState.target}
          onRun={() =>
            void action.run({
              screen: [],
              request: (target, signal) =>
                planToday(
                  target,
                  workspace.profile,
                  JSON.stringify({
                    total: stats.total,
                    lastSevenDays: stats.thisWeek,
                    interviewing: stats.interviewing,
                    offers: stats.offers,
                    rejected,
                    interviewRate: stats.interviewRate,
                  }),
                  signal
                ),
              onResult: (titles) => {
                const kept = daily?.tasks.filter((task) => task.done) ?? []
                setDaily(userId, {
                  day: today,
                  tasks: [...kept, ...taskList(titles)].slice(
                    0,
                    Math.max(3, kept.length)
                  ),
                })
              },
            })
          }
        >
          <Button
            variant='ghost'
            onClick={() =>
              setDaily(userId, {
                day: today,
                tasks: [
                  ...(daily?.tasks.filter((task) => task.done) ?? []),
                  ...taskList(ruleTasks),
                ].slice(0, 3),
              })
            }
          >
            <RefreshCw aria-hidden='true' />
            {t('Reset unfinished tasks')}
          </Button>
        </CoachRun>
      </section>
      <section className='space-y-3' aria-labelledby='career-week-title'>
        <h2 id='career-week-title' className='text-lg font-semibold'>
          {t('This week')}
        </h2>
        <StatTiles stats={stats} />
        <Insights stats={stats} />
      </section>
    </div>
  )
}
