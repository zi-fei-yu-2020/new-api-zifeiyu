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
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useForm, type Resolver } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  getGameSettings,
  saveSettings,
  type GameSettings,
} from '@/features/game-center/api'
import { getCurrencyLabel } from '@/lib/currency'
import {
  formatQuota,
  getEditableQuotaStep,
  parseQuotaFromDollars,
  quotaUnitsToDollars,
} from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'

import {
  SettingsForm,
  SettingsSwitchField,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'

const amountSchema = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? Number.NaN : value,
  z.coerce.number().min(0)
)
const schema = z
  .object({
    enabled: z.boolean(),
    rewardsEnabled: z.boolean(),
    first: amountSchema,
    additional: amountSchema,
    dailyBudget: amountSchema,
    weeklyFirst: amountSchema,
    weeklySecond: amountSchema,
    weeklyThird: amountSchema,
    pvpEnabled: z.boolean(),
    pvpMin: amountSchema,
    pvpMax: amountSchema,
  })
  .refine(
    (values) =>
      parseQuotaFromDollars(Number(values.pvpMin)) <=
      parseQuotaFromDollars(Number(values.pvpMax)),
    { path: ['pvpMax'] }
  )
type Values = z.infer<typeof schema>
export function GameSettingsSection() {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['game-settings'],
    queryFn: getGameSettings,
  })
  if (query.isPending) return <Skeleton className='h-80 w-full' />
  if (query.isError || !query.data) {
    return (
      <div role='alert'>
        <p>{t('Unable to load game settings')}</p>
        <Button onClick={() => void query.refetch()}>{t('Retry')}</Button>
      </div>
    )
  }
  return <GameSettingsForm settings={query.data} />
}
function GameSettingsForm({ settings }: { settings: GameSettings }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [saving, setSaving] = useState(false)
  const defaults = useMemo(
    () => ({
      enabled: settings.enabled,
      rewardsEnabled: settings.rewards_enabled,
      first: quotaUnitsToDollars(settings.first_token_quota),
      additional: quotaUnitsToDollars(settings.subsequent_token_quota),
      dailyBudget: quotaUnitsToDollars(settings.daily_budget),
      weeklyFirst: quotaUnitsToDollars(
        settings.weekly_first_quota ?? Math.floor(settings.weekly_budget * 0.3)
      ),
      weeklySecond: quotaUnitsToDollars(
        settings.weekly_second_quota ?? Math.floor(settings.weekly_budget * 0.2)
      ),
      weeklyThird: quotaUnitsToDollars(
        settings.weekly_third_quota ?? Math.floor(settings.weekly_budget * 0.15)
      ),
      pvpEnabled: settings.pvp_enabled ?? true,
      pvpMin: quotaUnitsToDollars(settings.pvp_min_stake ?? 0),
      pvpMax: quotaUnitsToDollars(settings.pvp_max_stake ?? 0),
    }),
    [settings]
  )
  const form = useForm<Values>({
    resolver: zodResolver(schema) as Resolver<Values>,
    defaultValues: defaults,
  })
  useEffect(() => {
    form.reset(defaults)
  }, [defaults, form])
  const first = form.watch('first'),
    additional = form.watch('additional')
  const maximum =
    parseQuotaFromDollars(Number(first)) +
    128 * parseQuotaFromDollars(Number(additional))
  const weeklyTotal =
    parseQuotaFromDollars(Number(form.watch('weeklyFirst'))) +
    parseQuotaFromDollars(Number(form.watch('weeklySecond'))) +
    parseQuotaFromDollars(Number(form.watch('weeklyThird')))
  async function submit(values: Values) {
    setSaving(true)
    try {
      await saveSettings({
        ...settings,
        enabled: values.enabled,
        rewards_enabled: values.rewardsEnabled,
        reward_version: 2,
        daily_quota: 0,
        first_token_quota: parseQuotaFromDollars(values.first),
        subsequent_token_quota: parseQuotaFromDollars(values.additional),
        daily_budget: parseQuotaFromDollars(values.dailyBudget),
        weekly_reward_version: 2,
        weekly_first_quota: parseQuotaFromDollars(values.weeklyFirst),
        weekly_second_quota: parseQuotaFromDollars(values.weeklySecond),
        weekly_third_quota: parseQuotaFromDollars(values.weeklyThird),
        weekly_budget:
          parseQuotaFromDollars(values.weeklyFirst) +
          parseQuotaFromDollars(values.weeklySecond) +
          parseQuotaFromDollars(values.weeklyThird),
        pvp_enabled: values.pvpEnabled,
        pvp_min_stake: parseQuotaFromDollars(values.pvpMin),
        pvp_max_stake: parseQuotaFromDollars(values.pvpMax),
      })
      form.reset(values)
      toast.success(t('Saved successfully'))
    } catch (error) {
      handleServerError(error)
    } finally {
      setSaving(false)
      await Promise.all([
        client.invalidateQueries({ queryKey: ['game-settings'] }),
        client.invalidateQueries({ queryKey: ['game-rewards'] }),
        client.invalidateQueries({ queryKey: ['game-status'] }),
        client.invalidateQueries({ queryKey: ['status'] }),
        client.invalidateQueries({ queryKey: ['system-options'] }),
      ])
    }
  }
  return (
    <SettingsSection title={t('Game Center')}>
      <SettingsForm onSubmit={form.handleSubmit(submit)}>
        <SettingsPageFormActions
          onSave={form.handleSubmit(submit)}
          isSaving={saving}
          isSaveDisabled={!form.formState.isDirty}
        />
        <FieldGroup>
          <FieldDescription>
            {t(
              'Configure game availability and rewards. Navigation visibility is configured in Header navigation and Sidebar modules.'
            )}
          </FieldDescription>
          <div className='divide-y'>
            <SettingsSwitchField
              controlId='feature-games'
              label={t('Game Center')}
              checked={form.watch('enabled')}
              onCheckedChange={(v) =>
                form.setValue('enabled', v, { shouldDirty: true })
              }
              description={t(
                'Closing Game Center prevents new runs. Existing runs can finish and settle.'
              )}
            />
          </div>
          <div className='border-t pt-4'>
            <SettingsSwitchField
              controlId='game-rewards'
              label={t('Enable quota rewards')}
              checked={form.watch('rewardsEnabled')}
              onCheckedChange={(v) =>
                form.setValue('rewardsEnabled', v, { shouldDirty: true })
              }
            />
          </div>
          <div className='grid gap-5 sm:grid-cols-2'>
            <Field>
              <FieldLabel htmlFor='reward-first'>
                {t('First collected token')} ({getCurrencyLabel()})
              </FieldLabel>
              <Input
                id='reward-first'
                type='number'
                min={0}
                step={getEditableQuotaStep()}
                {...form.register('first')}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor='reward-additional'>
                {t('Each additional token')} ({getCurrencyLabel()})
              </FieldLabel>
              <Input
                id='reward-additional'
                type='number'
                min={0}
                step={getEditableQuotaStep()}
                {...form.register('additional')}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor='reward-daily-budget'>
                {t('Total daily reward budget')} ({getCurrencyLabel()})
              </FieldLabel>
              <Input
                id='reward-daily-budget'
                type='number'
                min={0}
                step={getEditableQuotaStep()}
                {...form.register('dailyBudget')}
              />
              <FieldDescription>
                {t(
                  'Zero means no total budget cap. A capped budget reserves the maximum reward before a run starts.'
                )}
              </FieldDescription>
            </Field>
          </div>
          <div className='space-y-4 border-t pt-5'>
            <div>
              <h3 className='text-sm font-semibold'>
                {t('Weekly leaderboard rewards')}
              </h3>
              <FieldDescription>
                {t(
                  'Set fixed rewards for first, second and third place. Only these three places receive weekly rewards after saving.'
                )}
              </FieldDescription>
            </div>
            <div className='grid gap-5 sm:grid-cols-3'>
              <Field>
                <FieldLabel htmlFor='reward-weekly-first'>
                  {t('Weekly first-place reward')} ({getCurrencyLabel()})
                </FieldLabel>
                <Input
                  id='reward-weekly-first'
                  type='number'
                  min={0}
                  step={getEditableQuotaStep()}
                  {...form.register('weeklyFirst')}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor='reward-weekly-second'>
                  {t('Weekly second-place reward')} ({getCurrencyLabel()})
                </FieldLabel>
                <Input
                  id='reward-weekly-second'
                  type='number'
                  min={0}
                  step={getEditableQuotaStep()}
                  {...form.register('weeklySecond')}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor='reward-weekly-third'>
                  {t('Weekly third-place reward')} ({getCurrencyLabel()})
                </FieldLabel>
                <Input
                  id='reward-weekly-third'
                  type='number'
                  min={0}
                  step={getEditableQuotaStep()}
                  {...form.register('weeklyThird')}
                />
              </Field>
            </div>
            <p className='text-sm'>
              {t('Total weekly podium rewards')}:{' '}
              <strong>{formatQuota(weeklyTotal)}</strong>
            </p>
            <FieldDescription>
              {t(
                'Saved amounts apply to this week’s unsettled prizes. Player pages refresh rewards automatically every 5 seconds. Settled rewards are never recalculated.'
              )}
            </FieldDescription>
            <FieldDescription>
              {t(
                'Turn on quota rewards to activate weekly prizes. Turning them off does not cancel an already activated week.'
              )}
            </FieldDescription>
          </div>
          <div className='space-y-4 border-t pt-5'>
            <div className='flex items-center justify-between gap-4'>
              <div>
                <h3 className='text-sm font-semibold'>{t('PvP duels')}</h3>
                <FieldDescription>
                  {t(
                    'Stakes are escrowed when a duel starts and the winner takes the pot. Zero keeps the default bounds.'
                  )}
                </FieldDescription>
              </div>
            </div>
            <SettingsSwitchField
              controlId='game-pvp'
              label={t('Enable PvP duels')}
              checked={form.watch('pvpEnabled')}
              onCheckedChange={(v) =>
                form.setValue('pvpEnabled', v, { shouldDirty: true })
              }
              description={t(
                'Turning off PvP stops new duels, queue entries and invites. Duels already in progress finish and settle.'
              )}
            />
            <div className='grid gap-5 sm:grid-cols-2'>
              <Field>
                <FieldLabel htmlFor='game-pvp-min-stake'>
                  {t('Minimum duel stake')} ({getCurrencyLabel()})
                </FieldLabel>
                <Input
                  id='game-pvp-min-stake'
                  type='number'
                  min={0}
                  step={getEditableQuotaStep()}
                  {...form.register('pvpMin')}
                />
                <FieldDescription>
                  {t(
                    'The smallest stake a ranked queue or friendly duel accepts.'
                  )}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor='game-pvp-max-stake'>
                  {t('Maximum duel stake')} ({getCurrencyLabel()})
                </FieldLabel>
                <Input
                  id='game-pvp-max-stake'
                  type='number'
                  min={0}
                  step={getEditableQuotaStep()}
                  {...form.register('pvpMax')}
                />
                <FieldDescription>
                  {t(
                    'Friendly stakes are also capped by both players’ balances.'
                  )}
                </FieldDescription>
              </Field>
            </div>
          </div>
          {Object.keys(form.formState.errors).length > 0 && (
            <p role='alert' className='text-destructive text-sm'>
              {t('Invalid game reward settings')}
            </p>
          )}
          <div className='bg-muted/20 border p-4 text-sm'>
            <p>
              {t('Maximum reward for one run')}:{' '}
              <strong>{formatQuota(maximum)}</strong>
            </p>
            <p className='text-muted-foreground mt-2 text-xs'>
              {t(
                'Based on at most 129 collected tokens. No token means no reward; points and boss token values do not multiply payouts.'
              )}
            </p>
          </div>
          <FieldDescription>
            {t(
              'Game switches apply immediately. Daily rewards and budgets lock at the first reward-enabled run; earlier runs keep their starting rules. Weekly prize changes apply to the current unsettled week.'
            )}
          </FieldDescription>
        </FieldGroup>
      </SettingsForm>
    </SettingsSection>
  )
}
