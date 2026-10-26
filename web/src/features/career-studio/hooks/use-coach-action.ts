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
import { useEffect, useRef, useState } from 'react'

import {
  getServerErrorMessage,
  isServerErrorCancelled,
} from '@/lib/server-error-message'

import type { CareerModel } from '../api'
import { screenText, type SafetyLevel } from '../lib/safety'
import type { CareerModelState } from './use-career'

type RunOptions<T> = {
  /** Free text written by the user; screened before any request is sent. */
  screen: string[]
  request: (target: CareerModel, signal: AbortSignal) => Promise<T>
  onResult: (result: T) => void
}

export function useCoachAction(modelState: CareerModelState) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [safety, setSafety] = useState<SafetyLevel>('none')
  const active = useRef<AbortController | null>(null)

  useEffect(() => () => active.current?.abort(), [])

  async function run<T>(options: RunOptions<T>): Promise<void> {
    if (active.current) return
    const level = screenText(options.screen.join('\n'))
    setSafety(level)
    setError(null)
    // A crisis stops here: no model call, no charge, nothing leaves the browser.
    if (level === 'crisis') return
    const target = modelState.target
    if (!target) {
      setError('Choose a model and provide content first.')
      return
    }
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    try {
      const result = await options.request(target, controller.signal)
      if (!controller.signal.aborted) options.onResult(result)
    } catch (cause) {
      if (!controller.signal.aborted && !isServerErrorCancelled(cause)) {
        setError(
          getServerErrorMessage(
            cause,
            'The coach could not finish. Try again or choose another model.'
          )
        )
      }
    } finally {
      if (active.current === controller) {
        active.current = null
        setBusy(false)
      }
      if (!controller.signal.aborted) modelState.refreshBalance()
    }
  }

  function stop() {
    active.current?.abort()
    active.current = null
    setBusy(false)
  }

  return { busy, error, safety, run, stop, setError }
}
