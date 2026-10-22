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
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { getBepusdtPaymentStatus } from '../api'
import { BepusdtCheckoutDialog } from './dialogs/bepusdt-checkout-dialog'

export function BepusdtPaymentStatus({
  orderID,
  onPaid,
  checkoutURL,
  checkoutOpen = false,
  onCheckoutOpenChange,
}: {
  orderID?: string
  onPaid: () => Promise<void>
  checkoutURL?: string
  checkoutOpen?: boolean
  onCheckoutOpenChange?: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const userID = useAuthStore((state) => state.auth.user?.id)
  const notified = useRef<string | null>(null)
  const query = useQuery({
    queryKey: ['bepusdt-payment', userID, orderID],
    queryFn: async () =>
      requireServerSuccess(await getBepusdtPaymentStatus(orderID ?? '')).data,
    enabled: !!orderID && !!userID,
    retry: false,
    refetchInterval: (current) =>
      current.state.data?.status === 'pending' ? 3000 : false,
  })
  useEffect(() => {
    if (
      orderID &&
      query.data?.status === 'success' &&
      notified.current !== orderID
    ) {
      notified.current = orderID
      void onPaid()
    }
  }, [orderID, query.data?.status, onPaid])
  if (!orderID) return null
  let message = t('Waiting for BEpusdt payment confirmation.')
  if (query.data?.status === 'success') {
    message = t('BEpusdt payment credited. Your balance has been updated.')
  }
  if (query.data?.status === 'expired' || query.data?.status === 'failed') {
    message = t(
      'BEpusdt order expired. If you already paid, refresh later or contact the administrator.'
    )
  }
  if (query.isError) message = t('Unable to load BEpusdt payment status.')
  return (
    <>
      <Alert>
        <AlertDescription className='flex flex-wrap items-center justify-between gap-2'>
          <span>{message}</span>
          {query.data?.status !== 'success' && (
            <div className='flex flex-wrap gap-2'>
              {checkoutURL &&
                onCheckoutOpenChange &&
                query.data?.status !== 'expired' &&
                query.data?.status !== 'failed' && (
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => onCheckoutOpenChange(true)}
                  >
                    {t('Continue payment')}
                  </Button>
                )}
              <Button
                size='sm'
                variant='outline'
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              >
                {t('Refresh')}
              </Button>
            </div>
          )}
        </AlertDescription>
      </Alert>
      {checkoutURL && onCheckoutOpenChange && (
        <BepusdtCheckoutDialog
          key={orderID}
          open={checkoutOpen}
          onOpenChange={onCheckoutOpenChange}
          orderID={orderID}
          paymentURL={checkoutURL}
          status={query.data?.status}
          message={message}
          refreshing={query.isFetching}
          onRefresh={() => void query.refetch()}
        />
      )}
    </>
  )
}
