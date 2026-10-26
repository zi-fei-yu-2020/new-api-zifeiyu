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

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useCareerStudioStore } from '@/stores/career-studio-store'

import { debriefRejection } from '../api'
import { useCareerWorkspace, type CareerModelState } from '../hooks/use-career'
import { useCoachAction } from '../hooks/use-coach-action'
import type { ReviewResult } from '../types'
import { CoachRun, ListBlock } from './coach-run'

function ReviewView(props: { result: ReviewResult }) {
  const { t } = useTranslation()
  return (
    <div className='space-y-3 text-sm'>
      <p>{props.result.empathy}</p>
      <p>
        <span className='font-semibold'>{t('A fairer way to say it:')}</span>{' '}
        {props.result.reframe}
      </p>
      <ListBlock
        title={t('Within your control')}
        items={props.result.controllable}
      />
      <ListBlock
        title={t('Outside your control')}
        items={props.result.uncontrollable}
      />
      <ListBlock title={t('Next steps')} items={props.result.nextActions} />
      {props.result.lesson && (
        <p className='text-muted-foreground'>{props.result.lesson}</p>
      )}
    </div>
  )
}

type ReviewPanelProps = {
  modelState: CareerModelState
  company: string
  onCompanyChange: (company: string) => void
}

export function ReviewPanel(props: ReviewPanelProps) {
  const { t } = useTranslation()
  const { userId, workspace } = useCareerWorkspace()
  const addReview = useCareerStudioStore((state) => state.addReview)
  const action = useCoachAction(props.modelState)
  const [stage, setStage] = useState('')
  const [content, setContent] = useState('')
  const [result, setResult] = useState<ReviewResult | null>(null)

  return (
    <div className='space-y-4'>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Feeling bad is normal. Five minutes of writing turns "I am not good enough" into things you can change.'
        )}
      </p>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-2'>
          <Label htmlFor='career-review-company'>{t('Company and role')}</Label>
          <Input
            id='career-review-company'
            value={props.company}
            onChange={(event) => props.onCompanyChange(event.target.value)}
          />
        </div>
        <div className='space-y-2'>
          <Label htmlFor='career-review-stage'>{t('Stage')}</Label>
          <Input
            id='career-review-stage'
            placeholder={t('Resume screen, online test, first round...')}
            value={stage}
            onChange={(event) => setStage(event.target.value)}
          />
        </div>
      </div>
      <div className='space-y-2'>
        <Label htmlFor='career-review-content'>{t('What happened')}</Label>
        <Textarea
          id='career-review-content'
          rows={6}
          placeholder={t(
            'What were you asked, where did you get stuck, and how do you feel now?'
          )}
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
      </div>
      <CoachRun
        action={action}
        label={t('Debrief with me')}
        disabled={content.trim().length < 2 || !props.modelState.target}
        onRun={() =>
          void action.run({
            screen: [props.company, stage, content],
            request: (target, signal) =>
              debriefRejection(target, props.company, stage, content, signal),
            onResult: (next) => {
              setResult(next)
              addReview(userId, {
                id: crypto.randomUUID(),
                createdAt: new Date().toISOString(),
                stage,
                company: props.company,
                content,
                result: next,
              })
            },
          })
        }
      />
      {result && (
        <article
          className='border border-black p-4'
          aria-label={t('Debrief result')}
        >
          <ReviewView result={result} />
        </article>
      )}
      {workspace.reviews.length > 0 && (
        <section className='space-y-2' aria-labelledby='career-review-history'>
          <h2 id='career-review-history' className='text-lg font-semibold'>
            {t('Past debriefs')}
          </h2>
          {workspace.reviews.map((review) => (
            <details key={review.id} className='border border-neutral-300 p-3'>
              <summary className='cursor-pointer text-sm'>
                {[review.createdAt.slice(0, 10), review.company, review.stage]
                  .filter(Boolean)
                  .join(' · ')}
              </summary>
              <p className='text-muted-foreground my-2 text-sm whitespace-pre-wrap'>
                {review.content}
              </p>
              <ReviewView result={review.result} />
            </details>
          ))}
        </section>
      )}
    </div>
  )
}
