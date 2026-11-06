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

import { Dialog } from '@/components/dialog'
import { cn } from '@/lib/utils'

const NAVIGATION = [
  'Overview',
  'Authentication',
  'Chat completions',
  'Embeddings',
  'Rate limits',
  'Errors',
]

const REQUEST_DIFF = [
  { sign: ' ', code: '{' },
  { sign: ' ', code: '  "model": "gpt-4o-mini",' },
  { sign: '-', code: '  "max_tokens": 256,' },
  { sign: '+', code: '  "max_completion_tokens": 512,' },
  { sign: ' ', code: '  "stream": false' },
  { sign: ' ', code: '}' },
]
const DIFF_TONES: Record<string, string> = {
  '+': 'bg-emerald-500/15',
  '-': 'bg-rose-500/15',
}

// A plain API reference page that covers the whole viewport. It is a modal
// dialog, so focus is trapped, the game behind it is hidden from assistive
// technology only while it is open, and Escape closes it.
export function Match3BossView(props: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={t('Chat completions')}
      description={t(
        'Creates a model response for the given chat conversation. Requests are authenticated with a bearer token.'
      )}
      showCloseButton={false}
      contentClassName='top-0 left-0 h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0 sm:max-w-none'
      bodyClassName='mx-auto max-w-4xl'
    >
      <div className='flex gap-8'>
        <nav
          aria-label={t('Reference sections')}
          className='hidden w-44 shrink-0 sm:block'
        >
          <ul className='space-y-2 text-sm'>
            {NAVIGATION.map((item) => (
              <li key={item} className='text-muted-foreground'>
                {t(item)}
              </li>
            ))}
          </ul>
        </nav>
        <div className='min-w-0 flex-1'>
          <pre className='bg-muted overflow-x-auto p-3 font-mono text-xs'>
            POST /v1/chat/completions
          </pre>
          <h2 className='mt-6 text-lg font-semibold'>{t('Request body')}</h2>
          <table className='mt-3 w-full text-left text-sm'>
            <thead>
              <tr className='border-b'>
                <th className='py-2 pr-4 font-medium'>{t('Field')}</th>
                <th className='py-2 pr-4 font-medium'>{t('Type')}</th>
                <th className='py-2 font-medium'>{t('Description')}</th>
              </tr>
            </thead>
            <tbody>
              <tr className='border-b'>
                <td className='py-2 pr-4 font-mono text-xs'>model</td>
                <td className='py-2 pr-4 font-mono text-xs'>string</td>
                <td className='text-muted-foreground py-2'>
                  {t('The model that generates the response.')}
                </td>
              </tr>
              <tr className='border-b'>
                <td className='py-2 pr-4 font-mono text-xs'>messages</td>
                <td className='py-2 pr-4 font-mono text-xs'>array</td>
                <td className='text-muted-foreground py-2'>
                  {t('The conversation so far, oldest message first.')}
                </td>
              </tr>
              <tr>
                <td className='py-2 pr-4 font-mono text-xs'>stream</td>
                <td className='py-2 pr-4 font-mono text-xs'>boolean</td>
                <td className='text-muted-foreground py-2'>
                  {t('Whether to stream the response as server-sent events.')}
                </td>
              </tr>
            </tbody>
          </table>
          <h2 className='mt-6 text-lg font-semibold'>
            {t('Changes in this version')}
          </h2>
          <pre className='bg-muted mt-3 overflow-x-auto p-3 font-mono text-xs leading-6'>
            {REQUEST_DIFF.map((line) => (
              <div key={line.code} className={cn(DIFF_TONES[line.sign])}>
                {line.sign} {line.code}
              </div>
            ))}
          </pre>
        </div>
      </div>
    </Dialog>
  )
}
