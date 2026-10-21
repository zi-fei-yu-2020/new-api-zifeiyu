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
import { useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { SettingsSwitchField } from '../components/settings-form-layout'
import type { BepusdtSettingsValues } from './bepusdt-settings-values'

export function BepusdtSettingsSection() {
  const { t } = useTranslation()
  const form = useFormContext<BepusdtSettingsValues>()
  const fields = [
    {
      name: 'BepusdtBaseURL',
      label: t('BEpusdt gateway URL'),
      type: 'url',
      placeholder: 'https://pay.example.com',
      description: t(
        'Use the public BEpusdt address. Callback URLs are generated from the server address.'
      ),
    },
    {
      name: 'BepusdtApiKey',
      label: t('BEpusdt API token'),
      type: 'password',
      placeholder: t('Leave blank to keep the existing key'),
      description: '',
    },
    {
      name: 'BepusdtUnitPrice',
      label: t('USD price per credit unit'),
      type: 'number',
      placeholder: '1',
      description: '',
    },
    {
      name: 'BepusdtMinTopUp',
      label: t('Minimum top-up (credit units)'),
      type: 'number',
      placeholder: '1',
      description: '',
    },
  ] as const
  return (
    <div className='grid min-w-0 gap-5 lg:grid-cols-2'>
      <div className='space-y-2 lg:col-span-2'>
        <h3 className='text-lg font-medium'>BEpusdt</h3>
        <p className='text-muted-foreground text-sm'>
          {t(
            'Orders are charged in USD. BEpusdt calculates the cryptocurrency amount and confirms payment before credits are added.'
          )}
        </p>
      </div>
      <SettingsSwitchField
        className='lg:col-span-2'
        controlId='bepusdt-enabled'
        checked={form.watch('BepusdtEnabled')}
        onCheckedChange={(checked) =>
          form.setValue('BepusdtEnabled', checked, { shouldDirty: true })
        }
        label={t('Enable BEpusdt payments')}
        description={t(
          'Disabled by default. Saving credentials does not enable payments. Disabling stops new orders; existing payments can still be credited.'
        )}
      />
      {fields.map((item) => (
        <FormField
          key={item.name}
          control={form.control}
          name={item.name}
          render={({ field }) => (
            <FormItem>
              <FormLabel>{item.label}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type={item.type}
                  step={item.name === 'BepusdtUnitPrice' ? 'any' : 1}
                  autoComplete={
                    item.type === 'password' ? 'new-password' : 'off'
                  }
                  placeholder={item.placeholder}
                />
              </FormControl>
              {item.description && (
                <FormDescription>{item.description}</FormDescription>
              )}
              <FormMessage />
            </FormItem>
          )}
        />
      ))}
      <FormField
        control={form.control}
        name='BepusdtCurrencies'
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t('Accepted cryptocurrencies')}</FormLabel>
            <Select
              value={field.value}
              onValueChange={(value) => value && field.onChange(value)}
              items={[
                { value: 'USDT,USDC', label: 'USDT / USDC' },
                { value: 'USDT', label: 'USDT' },
                { value: 'USDC', label: 'USDC' },
              ]}
            >
              <FormControl>
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value='USDT,USDC'>USDT / USDC</SelectItem>
                <SelectItem value='USDT'>USDT</SelectItem>
                <SelectItem value='USDC'>USDC</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  )
}
