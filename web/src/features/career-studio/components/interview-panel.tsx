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

import { createInterview, reviewAnswer } from '../api'
import { useCareerWorkspace, type CareerModelState } from '../hooks/use-career'
import type { CareerTtsState } from '../hooks/use-career-tts'
import { useCoachAction } from '../hooks/use-coach-action'
import type { InterviewFeedback, InterviewQuestion } from '../types'
import { CoachRun, ListBlock } from './coach-run'
import { SpeakButton } from './speak-button'

type QuestionCardProps = {
  index: number
  question: InterviewQuestion
  role: string
  modelState: CareerModelState
  ttsState: CareerTtsState
}

function QuestionCard(props: QuestionCardProps) {
  const { t } = useTranslation()
  const action = useCoachAction(props.modelState)
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState<InterviewFeedback | null>(null)
  const id = `career-answer-${props.index}`
  return (
    <li className='space-y-2 border border-black p-3'>
      <div className='flex items-start justify-between gap-2'>
        <p className='font-medium'>
          {props.index + 1}. {props.question.question}
        </p>
        <SpeakButton
          tts={props.ttsState}
          id={`${id}-question`}
          text={props.question.question}
          label='Read question aloud'
        />
      </div>
      {(props.question.intent || props.question.tip) && (
        <p className='text-muted-foreground text-xs'>
          {[props.question.intent, props.question.tip]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      <Label htmlFor={id} className='sr-only'>
        {t('Your answer')}
      </Label>
      <Textarea
        id={id}
        rows={4}
        placeholder={t('Answer as you would in the real interview')}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
      />
      <CoachRun
        action={action}
        label={t('Review my answer')}
        disabled={!answer.trim() || !props.modelState.target}
        onRun={() =>
          void action.run({
            screen: [answer],
            request: (target, signal) =>
              reviewAnswer(
                target,
                props.role,
                props.question.question,
                answer,
                signal
              ),
            onResult: setFeedback,
          })
        }
      />
      {feedback && (
        <div className='space-y-2 bg-neutral-50 p-3 text-sm'>
          <p className='font-semibold'>
            {t('Score {{score}} / 10', { score: feedback.score })}
          </p>
          <ListBlock title={t('What worked')} items={feedback.strengths} />
          <ListBlock
            title={t('What to improve')}
            items={feedback.improvements}
          />
          {feedback.betterAnswer && (
            <div>
              <div className='flex items-center justify-between gap-2'>
                <h4 className='font-semibold'>{t('Improved answer')}</h4>
                <SpeakButton
                  tts={props.ttsState}
                  id={`${id}-better`}
                  text={feedback.betterAnswer}
                  label='Read improved answer'
                />
              </div>
              <p className='whitespace-pre-wrap'>{feedback.betterAnswer}</p>
            </div>
          )}
          {feedback.followUp && (
            <p className='text-muted-foreground'>
              {t('Likely follow-up: {{question}}', {
                question: feedback.followUp,
              })}
            </p>
          )}
        </div>
      )}
    </li>
  )
}

type InterviewPanelProps = {
  modelState: CareerModelState
  ttsState: CareerTtsState
}

export function InterviewPanel(props: InterviewPanelProps) {
  const { t } = useTranslation()
  const { workspace } = useCareerWorkspace()
  const action = useCoachAction(props.modelState)
  const [role, setRole] = useState('')
  const [jd, setJd] = useState('')
  const [questions, setQuestions] = useState<InterviewQuestion[]>([])
  const [session, setSession] = useState(0)

  return (
    <div className='space-y-4'>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-2'>
          <Label htmlFor='career-interview-role'>{t('Target role')}</Label>
          <Input
            id='career-interview-role'
            value={role}
            onChange={(event) => setRole(event.target.value)}
          />
        </div>
        <div className='space-y-2 sm:col-span-2'>
          <Label htmlFor='career-interview-jd'>
            {t('Job description (optional)')}
          </Label>
          <Textarea
            id='career-interview-jd'
            rows={3}
            value={jd}
            onChange={(event) => setJd(event.target.value)}
          />
        </div>
      </div>
      <CoachRun
        action={action}
        label={t('Start a mock interview')}
        disabled={!role.trim() || !props.modelState.target}
        onRun={() =>
          void action.run({
            screen: [role, jd],
            request: (target, signal) =>
              createInterview(
                target,
                role,
                jd,
                workspace.profile.resume,
                signal
              ),
            onResult: (next) => {
              setQuestions(next)
              setSession((value) => value + 1)
            },
          })
        }
      />
      {questions.length > 0 && (
        <ol className='space-y-3' aria-label={t('Interview questions')}>
          {questions.map((question, index) => (
            <QuestionCard
              key={`${session}-${question.question}`}
              index={index}
              question={question}
              role={role}
              modelState={props.modelState}
              ttsState={props.ttsState}
            />
          ))}
        </ol>
      )}
    </div>
  )
}
