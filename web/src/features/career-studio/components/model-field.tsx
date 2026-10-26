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
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { Label } from '@/components/ui/label'

import type { CareerModelState } from '../hooks/use-career'

type ModelFieldProps = { state: CareerModelState; disabled?: boolean }

export function CareerModelField(props: ModelFieldProps) {
  const { t } = useTranslation()
  const query = props.state.modelsQuery
  let help: ReactNode = (
    <>
      <span>
        {t(
          'AI features use your own models and are billed to your wallet like the Playground.'
        )}
      </span>{' '}
      <span>{t('Your choice is remembered on this browser.')}</span>
    </>
  )
  if (query.isError) {
    help = (
      <>
        {t('Unable to load your models.')}{' '}
        <Button variant='link' onClick={() => void query.refetch()}>
          {t('Retry')}
        </Button>
      </>
    )
  } else if (!query.isFetching && !props.state.models.length) {
    help = t('No models are available in your current group.')
  }
  return (
    <div className='space-y-2'>
      <Label htmlFor='career-model'>{t('Model')}</Label>
      <Combobox
        id='career-model'
        aria-label={t('Coaching model')}
        aria-describedby='career-model-help'
        options={props.state.models}
        value={props.state.model}
        onValueChange={(value) => {
          if (value) props.state.setModel(value)
        }}
        disabled={
          props.disabled ||
          query.isFetching ||
          query.isError ||
          !props.state.models.length
        }
        placeholder={
          query.isFetching
            ? t('Loading models...')
            : t('Choose a visible model')
        }
      />
      <p id='career-model-help' className='text-muted-foreground text-xs'>
        {help}
      </p>
    </div>
  )
}
