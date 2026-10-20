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
import { useQuery } from '@tanstack/react-query'
import { Construction } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { PublicLayout } from '@/components/layout'
import { RichContent } from '@/components/rich-content'
import { Skeleton } from '@/components/ui/skeleton'
import { isHttpUrl, isLikelyHtml } from '@/lib/content-format'
import { requireServerSuccess } from '@/lib/server-error-message'

import { getAboutContent } from './api'

function EmptyAboutState() {
  const { t } = useTranslation()
  const currentYear = new Date().getFullYear()

  return (
    <div className='flex items-center justify-center'>
      <div className='w-full text-start'>
        <div className='border-border border-b pb-8'>
          <div className='border-border bg-muted flex size-12 items-center justify-center border'>
            <Construction className='text-muted-foreground size-6' />
          </div>
          <h2 className='mt-6 text-xl leading-tight font-semibold tracking-tight sm:text-2xl'>
            {t('No About Content Set')}
          </h2>
          <p className='text-muted-foreground mt-4 max-w-xl text-sm leading-relaxed'>
            {t(
              'The administrator has not configured any about content yet. You can set it in the settings page, supporting HTML or URL.'
            )}
          </p>
        </div>
        <div className='space-y-4 pt-8 text-sm'>
          <p>
            {t('New API Project Repository:')}{' '}
            <a
              href='https://github.com/QuantumNous/new-api'
              target='_blank'
              rel='noopener noreferrer'
              className='text-foreground decoration-foreground/30 hover:decoration-foreground underline underline-offset-4'
            >
              {t('https://github.com/QuantumNous/new-api')}
            </a>
          </p>
          <p className='text-muted-foreground'>
            <a
              href='https://github.com/QuantumNous/new-api'
              target='_blank'
              rel='noopener noreferrer'
              className='text-foreground decoration-foreground/30 hover:decoration-foreground underline underline-offset-4'
            >
              {t('NewAPI')}
            </a>{' '}
            © {currentYear}{' '}
            <a
              href='https://github.com/QuantumNous'
              target='_blank'
              rel='noopener noreferrer'
              className='text-foreground decoration-foreground/30 hover:decoration-foreground underline underline-offset-4'
            >
              {t('QuantumNous')}
            </a>{' '}
            {t('| Based on')}{' '}
            <a
              href='https://github.com/songquanpeng/one-api'
              target='_blank'
              rel='noopener noreferrer'
              className='text-foreground decoration-foreground/30 hover:decoration-foreground underline underline-offset-4'
            >
              {t('One API')}
            </a>{' '}
            © 2023{' '}
            <a
              href='https://github.com/songquanpeng'
              target='_blank'
              rel='noopener noreferrer'
              className='text-foreground decoration-foreground/30 hover:decoration-foreground underline underline-offset-4'
            >
              {t('JustSong')}
            </a>
          </p>
          <p className='text-muted-foreground'>
            {t('This project must be used in compliance with the')}{' '}
            <a
              href='https://github.com/QuantumNous/new-api/blob/main/LICENSE'
              target='_blank'
              rel='noopener noreferrer'
              className='text-foreground decoration-foreground/30 hover:decoration-foreground underline underline-offset-4'
            >
              {t('AGPL v3.0 License')}
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  )
}

export function About() {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery({
    queryKey: ['about-content'],
    queryFn: async () => requireServerSuccess(await getAboutContent()),
  })

  const rawContent = data?.data?.trim() ?? ''
  const hasContent = rawContent.length > 0
  const isUrl = hasContent && isHttpUrl(rawContent)
  const contentIsHtml = hasContent && isLikelyHtml(rawContent)

  return (
    <PublicLayout>
      <div className='mx-auto max-w-4xl min-w-0 space-y-6'>
        <header className='border-border border-b pb-5'>
          <h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
            {t('About')}
          </h1>
        </header>
        <section className='border-border bg-card text-card-foreground min-w-0 overflow-hidden rounded-lg border p-5 sm:p-8'>
          {isLoading ? (
            <div className='space-y-4'>
              <Skeleton className='h-8 w-[45%]' />
              <Skeleton className='h-4 w-full' />
              <Skeleton className='h-4 w-[90%]' />
              <Skeleton className='h-4 w-[80%]' />
            </div>
          ) : !hasContent ? (
            <EmptyAboutState />
          ) : isUrl ? (
            <iframe
              src={rawContent}
              className='h-[calc(100dvh-14rem)] min-h-80 w-full border-0'
              title={t('About')}
              sandbox='allow-forms allow-popups allow-popups-to-escape-sandbox allow-scripts'
            />
          ) : (
            <RichContent
              mode={contentIsHtml ? 'html' : 'markdown'}
              htmlVariant='article'
              content={rawContent}
              className='prose-neutral max-w-none'
            />
          )}
        </section>
      </div>
    </PublicLayout>
  )
}
