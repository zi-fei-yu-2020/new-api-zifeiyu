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
import { HeartHandshake, Phone } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

import { CRISIS_HOTLINES, type SafetyLevel } from '../lib/safety'

type SafetyNoticeProps = { level: SafetyLevel }

export function SafetyNotice(props: SafetyNoticeProps) {
  const { t } = useTranslation()
  if (props.level === 'none') return null
  const crisis = props.level === 'crisis'
  return (
    <Alert
      variant={crisis ? 'destructive' : 'default'}
      className={crisis ? 'border-2' : undefined}
      data-testid={`career-safety-${props.level}`}
    >
      <HeartHandshake aria-hidden='true' />
      <AlertTitle>
        {crisis
          ? t('Your safety matters more than any job')
          : t('It sounds like you are carrying a lot right now')}
      </AlertTitle>
      <AlertDescription className='space-y-2'>
        <p>
          {crisis
            ? t(
                'Please pause the job search and reach out now: call one of the lines below, or tell someone you trust how you feel. If you are in immediate danger, call emergency services or go to the nearest hospital. This tool cannot replace professional help, and nothing you typed was sent to a model.'
              )
            : t(
                'Eating and sleeping matter more than one more application. If this feeling lasts two weeks or affects your sleep or appetite, talk to your university counselling centre or a support line.'
              )}
        </p>
        <ul className='space-y-1'>
          {CRISIS_HOTLINES.map((line) => (
            <li key={line.phone} className='flex items-center gap-2'>
              <Phone className='size-3.5' aria-hidden='true' />
              <a href={`tel:${line.phone}`} className='font-mono font-semibold'>
                {line.phone}
              </a>
              <span>{t(line.label)}</span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}
