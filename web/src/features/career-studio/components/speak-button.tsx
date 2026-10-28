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
import { Square, Volume2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Action } from '@/components/ai-elements/actions'
import { Spinner } from '@/components/ui/spinner'

import type { CareerTtsState } from '../hooks/use-career-tts'

type SpeakButtonProps = {
  tts: CareerTtsState
  /** Unique per readable block, so only that block shows as playing. */
  id: string
  text: string
  /** An i18n key; defaults to "Read aloud". */
  label?: string
}

/** Reads one block aloud with the chosen engine; pressing it again stops. */
export function SpeakButton(props: SpeakButtonProps) {
  const { t } = useTranslation()
  const loading = props.tts.loadingId === props.id
  const active = loading || props.tts.speakingId === props.id
  const unavailable =
    props.tts.engine === 'browser' && !props.tts.browserAvailable
  const label = active ? t('Stop reading') : t(props.label ?? 'Read aloud')
  let icon = <Volume2 aria-hidden='true' />
  if (loading) icon = <Spinner aria-hidden='true' />
  else if (active) icon = <Square aria-hidden='true' />
  return (
    <Action
      tooltip={label}
      label={label}
      aria-pressed={active}
      disabled={!active && (unavailable || !props.text.trim())}
      onClick={() => {
        if (active) props.tts.stop()
        else props.tts.speak(props.id, props.text)
      }}
    >
      {icon}
    </Action>
  )
}
