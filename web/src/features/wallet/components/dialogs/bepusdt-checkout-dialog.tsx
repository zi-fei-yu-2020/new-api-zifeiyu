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
import { CheckCircle2, ExternalLink } from 'lucide-react'
/* eslint-disable react/iframe-missing-sandbox -- The cross-origin checkout needs its own origin for API access. Same-origin checkout URLs are never embedded; top-level navigation remains sandboxed. */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'

interface BepusdtCheckoutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orderID: string
  paymentURL: string
  status?: string
  message: string
  refreshing: boolean
  onRefresh: () => void
}

export function BepusdtCheckoutDialog(props: BepusdtCheckoutDialogProps) {
  const { t } = useTranslation()
  const frame = useRef<HTMLIFrameElement>(null)
  const [returned, setReturned] = useState(false)
  const canEmbed = new URL(props.paymentURL).origin !== window.location.origin
  const finished =
    props.status === 'success' ||
    props.status === 'expired' ||
    props.status === 'failed'

  const handleFrameLoad = () => {
    try {
      const location = frame.current?.contentWindow?.location
      if (!location) return
      const url = new URL(location.href)
      if (
        url.origin === window.location.origin &&
        url.pathname === '/wallet' &&
        url.searchParams.get('bepusdt_order') === props.orderID
      ) {
        setReturned(true)
        props.onRefresh()
      }
    } catch {
      // The external checkout is cross-origin until it returns to this wallet.
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('BEpusdt checkout')}
      description={t(
        'Choose a currency and network to pay. Your balance updates after payment is confirmed.'
      )}
      contentClassName='max-sm:w-[calc(100vw-1rem)] sm:max-w-3xl'
      footerClassName='flex flex-wrap items-center sm:justify-between'
      footer={
        <>
          {!finished && (
            <Button
              variant='outline'
              role='link'
              render={
                <a
                  href={props.paymentURL}
                  target='_blank'
                  rel='noopener noreferrer'
                />
              }
              nativeButton={false}
            >
              <ExternalLink className='size-4' />
              {t('Open in new tab')}
            </Button>
          )}
          <div className='flex gap-2'>
            {!finished && (
              <Button
                variant='outline'
                disabled={props.refreshing}
                onClick={props.onRefresh}
              >
                {t('Refresh')}
              </Button>
            )}
            <Button onClick={() => props.onOpenChange(false)}>
              {t('Close')}
            </Button>
          </div>
        </>
      }
    >
      <div className='flex min-w-0 flex-col gap-3'>
        {finished || returned || !canEmbed ? (
          <div className='flex min-h-48 flex-col items-center justify-center gap-3 px-4 text-center'>
            {props.status === 'success' && (
              <CheckCircle2 className='text-success size-10' />
            )}
            <p role='status'>{props.message}</p>
          </div>
        ) : (
          <>
            <p className='text-muted-foreground text-sm' role='status'>
              {props.message}
            </p>
            <iframe
              ref={frame}
              src={props.paymentURL}
              title={t('BEpusdt checkout')}
              className='bg-background h-[min(65dvh,640px)] w-full border-0'
              sandbox='allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox'
              allow='clipboard-write'
              referrerPolicy='strict-origin-when-cross-origin'
              onLoad={handleFrameLoad}
            />
          </>
        )}
      </div>
    </Dialog>
  )
}
