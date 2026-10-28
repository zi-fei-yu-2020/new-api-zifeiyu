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
import { Loader2, Square } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { translateServerText } from '@/lib/server-error-message'

import type { useCoachAction } from '../hooks/use-coach-action'
import { SafetyNotice } from './safety-notice'

type CoachRunProps = {
  action: ReturnType<typeof useCoachAction>
  label: string
  disabled?: boolean
  onRun: () => void
  children?: ReactNode
}

/** Run button, stop control, safety notice and error state for one AI tool. */
export function CoachRun(props: CoachRunProps) {
  const { t } = useTranslation()
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          disabled={props.disabled || props.action.busy}
          onClick={props.onRun}
        >
          {props.action.busy && (
            <Loader2 className='animate-spin' aria-hidden='true' />
          )}
          {props.label}
        </Button>
        {props.action.busy && (
          <Button variant='outline' onClick={props.action.stop}>
            <Square aria-hidden='true' />
            {t('Stop')}
          </Button>
        )}
        {props.children}
      </div>
      <SafetyNotice level={props.action.safety} />
      {props.action.error && (
        <Alert variant='destructive' role='alert'>
          <AlertTitle>{t('The coach needs your attention')}</AlertTitle>
          <AlertDescription>
            {translateServerText(t, props.action.error)}
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

type ListBlockProps = { title: string; items: string[] }

export function ListBlock(props: ListBlockProps) {
  const items = [...new Set(props.items)]
  if (!items.length) return null
  return (
    <div className='space-y-1'>
      <h4 className='text-sm font-semibold'>{props.title}</h4>
      <ul className='list-disc space-y-1 pl-5 text-sm'>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}
