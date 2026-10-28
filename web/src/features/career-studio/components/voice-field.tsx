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
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Combobox } from '@/components/ui/combobox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'
import { translateServerText } from '@/lib/server-error-message'

import type { CareerTtsState } from '../hooks/use-career-tts'

type VoiceFieldProps = { tts: CareerTtsState }

/** Read-aloud settings shared by every tab; choices persist per account. */
export function CareerVoiceField(props: VoiceFieldProps) {
  const { t, i18n } = useTranslation()
  const tts = props.tts
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const isModel = tts.engine === 'model'
  const hasModels = tts.speechModels.length > 0
  // Model voice labels are i18n keys; browser voice names are shown as is.
  const voiceItems = Object.fromEntries(
    tts.voices.map((voice) => [
      voice.value,
      isModel ? t(voice.label) : voice.label,
    ])
  )
  const noBrowserVoice = !isModel && tts.browserAvailable && !tts.voices.length
  const engineHelp: string[] = []
  if (!tts.browserAvailable) {
    engineHelp.push(
      t('This browser has no built-in voice. Choose an AI voice instead.')
    )
  }
  if (!hasModels) {
    engineHelp.push(t('No voice models are available in your current group.'))
  } else if (isModel) {
    engineHelp.push(t('AI voice is billed per character to your wallet.'))
  }

  return (
    <fieldset className='space-y-3'>
      <legend className='mb-2 text-sm font-medium'>{t('Voice')}</legend>
      <div className='space-y-2'>
        <Label id='career-voice-engine-label'>{t('Voice engine')}</Label>
        <ToggleGroup
          aria-labelledby='career-voice-engine-label'
          aria-describedby={
            engineHelp.length ? 'career-voice-engine-help' : undefined
          }
          variant='outline'
          value={[tts.engine]}
          onValueChange={(values) => {
            const next = values[0]
            if (next === 'browser' || next === 'model') tts.setEngine(next)
          }}
        >
          <ToggleGroupItem value='browser' disabled={!tts.browserAvailable}>
            {t('Browser voice (free)')}
          </ToggleGroupItem>
          <ToggleGroupItem value='model' disabled={!hasModels}>
            {t('AI voice (billed)')}
          </ToggleGroupItem>
        </ToggleGroup>
        {engineHelp.length > 0 && (
          <p
            id='career-voice-engine-help'
            className='text-muted-foreground text-xs'
          >
            {engineHelp.join(' ')}
          </p>
        )}
      </div>
      <div className='grid gap-3 sm:grid-cols-2'>
        {isModel && (
          <div className='space-y-2 sm:col-span-2'>
            <Label htmlFor='career-voice-model'>{t('Voice model')}</Label>
            <Combobox
              id='career-voice-model'
              aria-label={t('Voice model')}
              options={tts.speechModels}
              value={tts.model}
              onValueChange={(value) => {
                if (value) tts.setModel(value)
              }}
              disabled={!hasModels}
            />
          </div>
        )}
        <div className='space-y-2'>
          <Label htmlFor='career-voice'>{t('Choose a voice')}</Label>
          <Select
            items={voiceItems}
            value={tts.voice || null}
            disabled={!tts.voices.length}
            onValueChange={(value) => {
              if (typeof value === 'string' && value) tts.setVoice(value)
            }}
          >
            <SelectTrigger
              id='career-voice'
              className='w-full'
              aria-describedby={
                noBrowserVoice ? 'career-voice-help' : undefined
              }
            >
              <SelectValue placeholder={t('Choose a voice')} />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {tts.voices.map((voice) => (
                <SelectItem key={voice.value} value={voice.value}>
                  {voiceItems[voice.value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {noBrowserVoice && (
            <p id='career-voice-help' className='text-muted-foreground text-xs'>
              {t('No Chinese voice was found in this browser.')}
            </p>
          )}
        </div>
        <div className='space-y-2'>
          <div className='flex items-center justify-between gap-2'>
            <Label id='career-voice-speed-label'>{t('Speed')}</Label>
            <span className='text-muted-foreground text-xs tabular-nums'>
              {`${formatNumber(tts.rate, locale)}×`}
            </span>
          </div>
          <Slider
            className='py-2'
            aria-labelledby='career-voice-speed-label'
            min={0.5}
            max={2}
            step={0.1}
            value={[tts.rate]}
            onValueChange={(next) => {
              const value = Array.isArray(next) ? next[0] : next
              if (typeof value === 'number') tts.setRate(value)
            }}
          />
        </div>
      </div>
      {tts.notice && (
        <p role='status' className='text-muted-foreground text-xs'>
          {t(tts.notice)}
        </p>
      )}
      {tts.error && (
        <Alert variant='destructive' role='alert'>
          <AlertDescription>
            {translateServerText(t, tts.error)}
          </AlertDescription>
        </Alert>
      )}
    </fieldset>
  )
}
