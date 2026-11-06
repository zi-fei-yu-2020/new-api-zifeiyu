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
import { Button } from '@/components/ui/button'
import { formatNumber } from '@/lib/format'

// Covers the board with a title, the score and at most one action: starting
// a run, or the result of a finished one.
export function Match3Overlay(props: {
  title: string
  body: string
  score?: number
  actionLabel?: string
  actionDisabled?: boolean
  onAction?: () => void
}) {
  return (
    <div className='absolute inset-0 z-[20] flex items-center justify-center bg-white/55 p-4 dark:bg-black/45'>
      <div className='bg-background/95 w-full max-w-[340px] border p-5 text-center shadow-sm sm:p-7'>
        <h2 className='text-xl font-semibold'>{props.title}</h2>
        <p className='text-muted-foreground mt-2 text-sm leading-relaxed'>
          {props.body}
        </p>
        {props.score === undefined ? null : (
          <p className='mt-4 font-mono text-3xl font-medium'>
            {formatNumber(props.score)}
          </p>
        )}
        {props.actionLabel && props.onAction ? (
          <Button
            className='mt-5 h-11 w-full'
            disabled={props.actionDisabled}
            onClick={props.onAction}
          >
            {props.actionLabel}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
