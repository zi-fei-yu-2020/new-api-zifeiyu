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

import { SettingsPageProvider } from '../../components/settings-page-context'
import {
  DEFAULT_BEPUSDT_SETTINGS,
  type BepusdtSettingsValues,
} from '../bepusdt-settings-values'
import { PaymentSettingsSection } from '../payment-settings-section'

export function PaymentSettingsFixture({
  enabled = false,
  bepusdt = {},
}: {
  enabled?: boolean
  bepusdt?: Partial<BepusdtSettingsValues>
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <PaymentSettingsSection
          defaultValues={{
            PayAddress: '',
            EpayId: '',
            EpayKey: '',
            Price: 1,
            MinTopUp: 1,
            CustomCallbackAddress: '',
            PayMethods: '[]',
            AmountOptions: '[]',
            AmountDiscount: '{}',
            StripeApiSecret: '',
            StripeWebhookSecret: '',
            StripePriceId: '',
            StripeUnitPrice: 1,
            StripeMinTopUp: 1,
            StripePromotionCodesEnabled: false,
            CreemApiKey: '',
            CreemWebhookSecret: '',
            CreemTestMode: false,
            CreemProducts: '[]',
          }}
          waffoDefaultValues={{
            WaffoEnabled: false,
            WaffoApiKey: '',
            WaffoPrivateKey: '',
            WaffoPublicCert: '',
            WaffoSandboxPublicCert: '',
            WaffoSandboxApiKey: '',
            WaffoSandboxPrivateKey: '',
            WaffoSandbox: false,
            WaffoMerchantId: '',
            WaffoCurrency: 'USD',
            WaffoUnitPrice: 1,
            WaffoMinTopUp: 1,
            WaffoNotifyUrl: '',
            WaffoReturnUrl: '',
            WaffoPayMethods: '[]',
          }}
          bepusdtDefaultValues={{ ...DEFAULT_BEPUSDT_SETTINGS, ...bepusdt }}
          waffoPancakeDefaultValues={{
            WaffoPancakeEnabled: enabled,
            WaffoPancakeMerchantID: 'merchant',
            WaffoPancakePrivateKey: '',
            WaffoPancakeReturnURL: '',
          }}
          waffoPancakeProvisionedStoreID='store'
          waffoPancakeProvisionedProductID='product'
          complianceDefaults={{
            confirmed: true,
            termsVersion: 'v1',
            confirmedAt: 1,
            confirmedBy: 1,
          }}
        />
      </SettingsPageProvider>
    </>
  )
}
