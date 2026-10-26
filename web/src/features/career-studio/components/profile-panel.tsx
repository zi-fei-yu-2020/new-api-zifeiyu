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
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import * as z from 'zod'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useCareerStudioStore } from '@/stores/career-studio-store'

import { useCareerWorkspace } from '../hooks/use-career'

const profileSchema = z.object({
  school: z.string().trim().max(100),
  major: z.string().trim().max(100),
  graduationYear: z
    .string()
    .trim()
    .regex(/^(\d{4})?$/, 'Enter a four-digit year'),
  targetRoles: z.string().trim().max(200),
  cities: z.string().trim().max(200),
  resume: z.string().max(20_000, 'Keep the resume under 20,000 characters'),
})

const FIELDS = [
  ['school', 'School'],
  ['major', 'Major'],
  ['graduationYear', 'Graduation year'],
  ['targetRoles', 'Target roles'],
  ['cities', 'Preferred cities'],
] as const

export function ProfilePanel() {
  const { t } = useTranslation()
  const { userId, workspace } = useCareerWorkspace()
  const saveProfile = useCareerStudioStore((state) => state.saveProfile)
  const clearWorkspace = useCareerStudioStore((state) => state.clearWorkspace)
  const [confirming, setConfirming] = useState(false)
  const form = useForm<z.infer<typeof profileSchema>>({
    resolver: zodResolver(profileSchema),
    defaultValues: workspace.profile,
  })
  const { reset } = form

  useEffect(() => reset(workspace.profile), [reset, workspace.profile])

  return (
    <div className='space-y-4'>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Your profile, applications and debriefs are stored only in this browser for this account. Resume text is sent to the model you choose only when you run an AI feature.'
        )}
      </p>
      <Form {...form}>
        <form
          className='grid gap-3 border border-black p-4 sm:grid-cols-2'
          onSubmit={form.handleSubmit((values) => {
            saveProfile(userId, values)
            toast.success(t('Profile saved'))
          })}
        >
          {FIELDS.map(([name, label]) => (
            <FormField
              key={name}
              control={form.control}
              name={name}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t(label)}</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          ))}
          <FormField
            control={form.control}
            name='resume'
            render={({ field }) => (
              <FormItem className='sm:col-span-2'>
                <FormLabel>{t('Resume (plain text)')}</FormLabel>
                <FormControl>
                  <Textarea rows={14} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className='flex flex-wrap gap-2 sm:col-span-2'>
            <Button type='submit'>{t('Save')}</Button>
            <Button
              type='button'
              variant='outline'
              onClick={() => setConfirming(true)}
            >
              {t('Clear all career data')}
            </Button>
          </div>
        </form>
      </Form>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('Clear all career data')}
        desc={t(
          'This removes your profile, applications, daily tasks and debriefs from this browser. It cannot be undone.'
        )}
        destructive
        confirmText={t('Clear')}
        handleConfirm={() => {
          clearWorkspace(userId)
          setConfirming(false)
          toast.success(t('Career data cleared'))
        }}
      />
    </div>
  )
}
