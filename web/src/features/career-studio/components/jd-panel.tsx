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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

import { matchJobDescription } from '../api'
import { useCareerWorkspace, type CareerModelState } from '../hooks/use-career'
import { useCoachAction } from '../hooks/use-coach-action'
import type { JdMatchResult } from '../types'
import { CoachRun, ListBlock } from './coach-run'

type JdPanelProps = {
  modelState: CareerModelState
  jd: string
  onJdChange: (jd: string) => void
}

export function JdPanel(props: JdPanelProps) {
  const { t } = useTranslation()
  const { workspace } = useCareerWorkspace()
  const action = useCoachAction(props.modelState)
  const [result, setResult] = useState<JdMatchResult | null>(null)
  const resume = workspace.profile.resume.trim()

  return (
    <div className='space-y-4'>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Only your existing experience is rephrased. Numbers you need to supply are marked with 【】.'
        )}
      </p>
      <div className='space-y-2'>
        <Label htmlFor='career-jd'>{t('Job description')}</Label>
        <Textarea
          id='career-jd'
          rows={8}
          value={props.jd}
          onChange={(event) => props.onJdChange(event.target.value)}
        />
      </div>
      {!resume && (
        <p className='text-sm' role='note'>
          {t('Add your resume in the profile tab first.')}
        </p>
      )}
      <CoachRun
        action={action}
        label={t('Analyse match')}
        disabled={
          !resume || props.jd.trim().length < 10 || !props.modelState.target
        }
        onRun={() =>
          void action.run({
            screen: [props.jd],
            request: (target, signal) =>
              matchJobDescription(
                target,
                workspace.profile,
                resume,
                props.jd,
                signal
              ),
            onResult: setResult,
          })
        }
      />
      {result && (
        <article
          className='space-y-4 border border-black p-4'
          aria-label={t('Match result')}
        >
          <p className='text-4xl font-semibold tabular-nums'>
            {result.score}
            <span className='text-muted-foreground text-sm'> / 100</span>
          </p>
          <p>{result.verdict}</p>
          <ListBlock title={t('Already matched')} items={result.matched} />
          {result.gaps.length > 0 && (
            <div className='space-y-2'>
              <h4 className='text-sm font-semibold'>
                {t('Gaps and how to close them')}
              </h4>
              {result.gaps.map((gap) => (
                <div
                  key={gap.item}
                  className='border-l-2 border-black pl-3 text-sm'
                >
                  <p className='font-medium'>{gap.item}</p>
                  <p className='text-muted-foreground'>{gap.advice}</p>
                </div>
              ))}
            </div>
          )}
          {result.rewrites.length > 0 && (
            <div className='space-y-2'>
              <h4 className='text-sm font-semibold'>
                {t('Suggested rewrites')}
              </h4>
              {result.rewrites.map((rewrite) => (
                <div
                  key={rewrite.before}
                  className='grid gap-2 text-sm md:grid-cols-2'
                >
                  <p className='bg-neutral-100 p-2 whitespace-pre-wrap'>
                    {rewrite.before}
                  </p>
                  <div className='flex items-start gap-1 border border-black p-2'>
                    <p className='flex-1 whitespace-pre-wrap'>
                      {rewrite.after}
                    </p>
                    <CopyButton value={rewrite.after} size='icon' />
                  </div>
                </div>
              ))}
            </div>
          )}
          {result.selfIntro && (
            <div className='space-y-1'>
              <div className='flex items-center gap-1'>
                <h4 className='text-sm font-semibold'>
                  {t('One-minute self-introduction')}
                </h4>
                <CopyButton value={result.selfIntro} size='icon' />
              </div>
              <p className='text-sm whitespace-pre-wrap'>{result.selfIntro}</p>
            </div>
          )}
          <ListBlock
            title={t('Likely interview questions')}
            items={result.likelyQuestions}
          />
        </article>
      )}
    </div>
  )
}
