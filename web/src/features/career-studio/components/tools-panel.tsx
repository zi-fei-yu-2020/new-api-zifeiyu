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

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'

import { checkRecruitment } from '../api'
import type { CareerModelState } from '../hooks/use-career'
import { useCoachAction } from '../hooks/use-coach-action'
import { POLICY_CARDS } from '../lib/policies'
import {
  RUNWAY_EXPENSES,
  calculateRunway,
  type RunwayExpenseKey,
  type RunwayResult,
} from '../lib/runway'
import { ruleBasedScamCheck } from '../lib/scam'
import type { ScamCheckResult } from '../types'
import { CoachRun, ListBlock } from './coach-run'

const DEFAULT_EXPENSES: Record<RunwayExpenseKey, number> = {
  rent: 2000,
  food: 1500,
  transport: 200,
  subscriptions: 100,
  leisure: 300,
  shopping: 300,
  other: 200,
}

function RunwaySection() {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [savings, setSavings] = useState('10000')
  const [income, setIncome] = useState('0')
  const [expenses, setExpenses] = useState<Record<RunwayExpenseKey, string>>(
    () =>
      Object.fromEntries(
        Object.entries(DEFAULT_EXPENSES).map(([key, value]) => [
          key,
          String(value),
        ])
      ) as Record<RunwayExpenseKey, string>
  )
  const [result, setResult] = useState<RunwayResult | null>(null)
  const months = (value: number | null) =>
    value === null ? '∞' : formatNumber(value, locale)

  return (
    <section className='space-y-3' aria-labelledby='career-runway-title'>
      <h2 id='career-runway-title' className='text-lg font-semibold'>
        {t('Money runway')}
      </h2>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Knowing how long you can last removes half the anxiety. Calculated in your browser and never sent anywhere.'
        )}
      </p>
      <div className='grid gap-3 sm:grid-cols-3'>
        <div className='space-y-1'>
          <Label htmlFor='career-runway-savings'>
            {t('Available savings')}
          </Label>
          <Input
            id='career-runway-savings'
            type='number'
            min={0}
            value={savings}
            onChange={(event) => setSavings(event.target.value)}
          />
        </div>
        <div className='space-y-1'>
          <Label htmlFor='career-runway-income'>{t('Monthly income')}</Label>
          <Input
            id='career-runway-income'
            type='number'
            min={0}
            value={income}
            onChange={(event) => setIncome(event.target.value)}
          />
        </div>
        {RUNWAY_EXPENSES.map((item) => (
          <div key={item.key} className='space-y-1'>
            <Label htmlFor={`career-runway-${item.key}`}>{t(item.label)}</Label>
            <Input
              id={`career-runway-${item.key}`}
              type='number'
              min={0}
              value={expenses[item.key]}
              onChange={(event) =>
                setExpenses((current) => ({
                  ...current,
                  [item.key]: event.target.value,
                }))
              }
            />
          </div>
        ))}
      </div>
      <Button
        onClick={() =>
          setResult(
            calculateRunway(
              Number(savings),
              Number(income),
              Object.fromEntries(
                Object.entries(expenses).map(([key, value]) => [
                  key,
                  Number(value),
                ])
              ) as Record<RunwayExpenseKey, number>
            )
          )
        }
      >
        {t('Calculate')}
      </Button>
      {result && (
        <div className='space-y-2 border border-black p-4' role='status'>
          <p className='text-3xl font-semibold tabular-nums'>
            {t('{{months}} months', { months: months(result.months) })}
          </p>
          <p>{t(result.message.key, result.message.values)}</p>
          <p className='text-muted-foreground text-sm'>
            {t('Net monthly spend {{amount}}', {
              amount: formatNumber(result.monthlyBurn, locale),
            })}
          </p>
          {result.monthlySavings > 0 && (
            <p className='text-sm'>
              {t(
                'Trimming flexible spending could save about {{amount}} a month and extend the runway to {{months}} months.',
                {
                  amount: formatNumber(result.monthlySavings, locale),
                  months: months(result.monthsAfterCuts),
                }
              )}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function ScamSection(props: { modelState: CareerModelState }) {
  const { t } = useTranslation()
  const action = useCoachAction(props.modelState)
  const [text, setText] = useState('')
  const [result, setResult] = useState<ScamCheckResult | null>(null)
  const riskLabel = {
    high: t('High risk'),
    medium: t('Suspicious'),
    low: t('Lower risk'),
  }
  return (
    <section className='space-y-3' aria-labelledby='career-scam-title'>
      <h2 id='career-scam-title' className='text-lg font-semibold'>
        {t('Recruitment scam check')}
      </h2>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Paste a job post, what the recruiter said, or the agreement you are asked to sign. Legitimate employers never charge you before you start.'
        )}
      </p>
      <Label htmlFor='career-scam-text' className='sr-only'>
        {t('Recruitment text')}
      </Label>
      <Textarea
        id='career-scam-text'
        rows={5}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <CoachRun
        action={action}
        label={t('Deep check with AI')}
        disabled={text.trim().length < 5 || !props.modelState.target}
        onRun={() =>
          void action.run({
            screen: [text],
            request: (target, signal) => checkRecruitment(target, text, signal),
            onResult: setResult,
          })
        }
      >
        <Button
          variant='outline'
          disabled={text.trim().length < 5}
          onClick={() => setResult(ruleBasedScamCheck(text))}
        >
          {t('Quick check (free)')}
        </Button>
      </CoachRun>
      {result && (
        <div
          className='space-y-2 border-2 border-black p-4'
          role='status'
          data-risk={result.risk}
        >
          <p className='text-lg font-semibold'>{riskLabel[result.risk]}</p>
          <p>{t(result.summary)}</p>
          <ListBlock
            title={t('Red flags')}
            items={result.redFlags.map((flag) => t(flag))}
          />
          <p className='text-sm'>{t(result.advice)}</p>
          <p className='text-muted-foreground text-xs'>
            {t(
              'If you have been defrauded, call 110 or the 96110 anti-fraud line.'
            )}
          </p>
        </div>
      )}
    </section>
  )
}

function PolicySection() {
  const { t } = useTranslation()
  return (
    <section className='space-y-3' aria-labelledby='career-policy-title'>
      <h2 id='career-policy-title' className='text-lg font-semibold'>
        {t('Policy guide')}
      </h2>
      <Accordion className='border border-black px-3'>
        {POLICY_CARDS.map((card) => (
          <AccordionItem key={card.id} value={card.id}>
            <AccordionTrigger>{t(card.title)}</AccordionTrigger>
            <AccordionContent className='space-y-2'>
              <ul className='list-disc space-y-1 pl-5 text-sm'>
                {card.points.map((point) => (
                  <li key={point}>{t(point)}</li>
                ))}
              </ul>
              <p className='text-sm font-medium'>{t(card.action)}</p>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
      <p className='text-muted-foreground text-xs'>
        {t(
          'General guidance only. Local rules and amounts differ; confirm with your local human resources bureau or university career office.'
        )}
      </p>
    </section>
  )
}

type ToolsPanelProps = { modelState: CareerModelState }

export function ToolsPanel(props: ToolsPanelProps) {
  return (
    <div className='space-y-8'>
      <RunwaySection />
      <ScamSection modelState={props.modelState} />
      <PolicySection />
    </div>
  )
}
