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
import { HugeiconsIcon } from '@hugeicons/react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from '@/components/ui/progress'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

import type { MatchSkill } from './actions'
import {
  MATCH_COMBO_WINDOW_TICKS,
  MATCH_ENERGY_CAP,
  type MatchState,
} from './engine'
import { MATCH_SKILLS } from './theme'

// Energy, the combo timer and the three skills. The 1/2/3 hotkeys are bound
// by the panel (they depend on visibility and open dialogs); this bar only
// shows them.
export function Match3SkillsBar(props: {
  state: MatchState
  // The session's game clock in 100ms ticks (state.clock plus the time since
  // the last input). The bar polls it only while running, so a paused or
  // hidden game does not re-render.
  getTick: () => number
  running: boolean
  disabled: boolean
  onSkill: (kind: MatchSkill) => void
}) {
  const { t } = useTranslation()
  const state = props.state
  const [tick, setTick] = useState(() => props.getTick())
  const getTick = useRef(props.getTick)
  getTick.current = props.getTick
  const running = props.running
  useEffect(() => {
    setTick(getTick.current())
    if (!running) return
    const timer = window.setInterval(() => setTick(getTick.current()), 200)
    return () => window.clearInterval(timer)
  }, [running, state.last_clear])
  const comboLeft = Math.max(
    0,
    MATCH_COMBO_WINDOW_TICKS - (tick - state.last_clear)
  )
  const comboActive = state.combo > 0 && comboLeft > 0
  return (
    <TooltipProvider>
      <div className='match3-skills'>
        <div className='grid grid-cols-2 gap-4'>
          <Progress value={state.energy} max={MATCH_ENERGY_CAP}>
            <ProgressLabel>{t('Energy')}</ProgressLabel>
            <ProgressValue>
              {() => `${state.energy}/${MATCH_ENERGY_CAP}`}
            </ProgressValue>
          </Progress>
          <Progress
            value={comboActive ? comboLeft : 0}
            max={MATCH_COMBO_WINDOW_TICKS}
          >
            <ProgressLabel>
              {t('Combo x{{count}}', { count: comboActive ? state.combo : 0 })}
            </ProgressLabel>
            <ProgressValue>
              {() => `${(comboLeft / 10).toFixed(1)}s`}
            </ProgressValue>
          </Progress>
        </div>
        <div role='group' aria-label={t('Skills')} className='flex gap-2'>
          {MATCH_SKILLS.map((skill) => {
            const locked = (state.unlocks & skill.unlock) === 0
            const poor = state.energy < skill.cost
            const unavailable = locked || poor || props.disabled
            let reason = t(skill.hint)
            if (locked) reason = t('Locked: reach a higher level to unlock')
            else if (poor) {
              reason = t('Needs {{cost}} energy', { cost: skill.cost })
            }
            return (
              <Tooltip key={skill.kind}>
                <TooltipTrigger
                  render={
                    <Button
                      variant='outline'
                      className='h-11 flex-1 gap-2'
                      disabled={unavailable}
                      focusableWhenDisabled
                      aria-keyshortcuts={skill.hotkey}
                      aria-label={`${t(skill.label)} (${skill.cost})`}
                      onClick={() => props.onSkill(skill.kind)}
                    />
                  }
                >
                  <HugeiconsIcon
                    icon={skill.icon}
                    strokeWidth={1.8}
                    aria-hidden='true'
                    className='size-4'
                  />
                  <span>{t(skill.label)}</span>
                  <span className='text-muted-foreground font-mono text-xs'>
                    {skill.cost}
                  </span>
                  <Kbd aria-hidden='true'>{skill.hotkey}</Kbd>
                </TooltipTrigger>
                <TooltipContent>{reason}</TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </div>
    </TooltipProvider>
  )
}
