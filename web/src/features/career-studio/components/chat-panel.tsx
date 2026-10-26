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

import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

import { chatWithCoach } from '../api'
import { useCareerWorkspace, type CareerModelState } from '../hooks/use-career'
import { useCoachAction } from '../hooks/use-coach-action'
import type { ChatEntry } from '../types'
import { CoachRun } from './coach-run'

type ChatPanelProps = { modelState: CareerModelState }

// Conversations stay in memory only; venting should not be persisted by default.
export function ChatPanel(props: ChatPanelProps) {
  const { t } = useTranslation()
  const { workspace } = useCareerWorkspace()
  const action = useCoachAction(props.modelState)
  const [messages, setMessages] = useState<ChatEntry[]>([])
  const [draft, setDraft] = useState('')

  function send() {
    const content = draft.trim()
    if (!content || action.busy) return
    const history: ChatEntry[] = [
      ...messages,
      { id: crypto.randomUUID(), role: 'user', content },
    ]
    void action.run({
      screen: [content],
      request: (target, signal) =>
        chatWithCoach(
          target,
          workspace.profile,
          history.map((item) => ({ role: item.role, content: item.content })),
          signal
        ),
      onResult: (reply) => {
        setMessages([
          ...history,
          { id: crypto.randomUUID(), role: 'assistant', content: reply },
        ])
        setDraft('')
      },
    })
  }

  return (
    <div className='space-y-3'>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Resumes, interviews, choosing offers, further study or work, or just letting off steam. This chat is not saved.'
        )}
      </p>
      <div
        className='h-[50vh] space-y-2 overflow-y-auto border border-black p-3'
        role='log'
        aria-live='polite'
        aria-label={t('Conversation')}
      >
        {messages.length === 0 && (
          <p className='text-muted-foreground text-sm'>
            {t('Hi, I am your job-search buddy. How are you doing today?')}
          </p>
        )}
        {messages.map((message) => (
          <p
            key={message.id}
            className={cn(
              'max-w-[85%] px-3 py-2 text-sm whitespace-pre-wrap',
              message.role === 'user'
                ? 'ml-auto bg-black text-white'
                : 'bg-neutral-100'
            )}
          >
            {message.content}
          </p>
        ))}
      </div>
      <Label htmlFor='career-chat-input' className='sr-only'>
        {t('Message')}
      </Label>
      <Textarea
        id='career-chat-input'
        rows={2}
        value={draft}
        placeholder={t('Type a message (Ctrl+Enter to send)')}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            send()
          }
        }}
      />
      <CoachRun
        action={action}
        label={t('Send')}
        disabled={!draft.trim() || !props.modelState.target}
        onRun={send}
      />
    </div>
  )
}
