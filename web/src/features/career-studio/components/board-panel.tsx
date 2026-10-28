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
import { Pencil, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import * as z from 'zod'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useCareerStudioStore } from '@/stores/career-studio-store'

import { localToday, useCareerWorkspace } from '../hooks/use-career'
import { applicationStats } from '../lib/stats'
import {
  APPLICATION_STATUSES,
  type ApplicationStatus,
  type CareerApplication,
} from '../types'
import { ConversionTable, Insights, StatTiles } from './stats-view'

const statusValues = APPLICATION_STATUSES.map((item) => item.value) as [
  ApplicationStatus,
  ...ApplicationStatus[],
]
const applicationSchema = z.object({
  company: z.string().trim().min(1, 'Company is required').max(100),
  role: z.string().trim().min(1, 'Job title is required').max(100),
  track: z.string().trim().max(40),
  channel: z.string().trim().max(40),
  status: z.enum(statusValues),
  appliedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a valid date'),
  jd: z.string().max(20_000),
})
type ApplicationValues = z.infer<typeof applicationSchema>

function emptyValues(): ApplicationValues {
  return {
    company: '',
    role: '',
    track: '',
    channel: '',
    status: 'applied',
    appliedOn: localToday(),
    jd: '',
  }
}

type BoardPanelProps = {
  onAnalyse: (jd: string) => void
  onDebrief: (application: CareerApplication) => void
}

export function BoardPanel(props: BoardPanelProps) {
  const { t } = useTranslation()
  const { userId, workspace } = useCareerWorkspace()
  const saveApplication = useCareerStudioStore((state) => state.saveApplication)
  const removeApplication = useCareerStudioStore(
    (state) => state.removeApplication
  )
  const [editing, setEditing] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<CareerApplication | null>(null)
  const form = useForm<ApplicationValues>({
    resolver: zodResolver(applicationSchema),
    defaultValues: emptyValues(),
  })
  const today = localToday()
  const stats = useMemo(
    () => applicationStats(workspace.applications, today),
    [workspace.applications, today]
  )
  const statusItems = Object.fromEntries(
    APPLICATION_STATUSES.map((item) => [item.value, t(item.label)])
  )

  function submit(values: ApplicationValues) {
    saveApplication(userId, { id: editing ?? crypto.randomUUID(), ...values })
    toast.success(t(editing ? 'Application updated' : 'Application added'))
    setEditing(null)
    form.reset(emptyValues())
  }

  function changeStatus(
    application: CareerApplication,
    status: ApplicationStatus
  ) {
    saveApplication(userId, { ...application, status })
    if (status === 'rejected') {
      toast(
        t(
          'That stings. A short debrief turns it into experience for next time.'
        )
      )
    }
    if (status === 'offer') toast.success(t('Congratulations on the offer!'))
  }

  return (
    <div className='space-y-6'>
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(submit)}
          className='grid gap-3 border border-black p-4 sm:grid-cols-2'
          aria-label={t('Application form')}
        >
          {(
            [
              ['company', 'Company'],
              ['role', 'Job title'],
              ['track', 'Direction (for example engineering, product)'],
              ['channel', 'Channel (careers site, referral, campus talk)'],
            ] as const
          ).map(([name, label]) => (
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
            name='status'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('Status')}</FormLabel>
                <Select
                  items={statusItems}
                  value={field.value}
                  onValueChange={(value) => value && field.onChange(value)}
                >
                  <FormControl>
                    <SelectTrigger className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {APPLICATION_STATUSES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {t(item.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='appliedOn'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('Applied on')}</FormLabel>
                <FormControl>
                  <Input type='date' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='jd'
            render={({ field }) => (
              <FormItem className='sm:col-span-2'>
                <FormLabel>{t('Job description (optional)')}</FormLabel>
                <FormControl>
                  <Textarea rows={3} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className='flex gap-2 sm:col-span-2'>
            <Button type='submit'>
              {t(editing ? 'Save changes' : 'Add application')}
            </Button>
            {editing && (
              <Button
                type='button'
                variant='outline'
                onClick={() => {
                  setEditing(null)
                  form.reset(emptyValues())
                }}
              >
                {t('Cancel')}
              </Button>
            )}
          </div>
        </form>
      </Form>

      {workspace.applications.length ? (
        <ul
          className='divide-y divide-neutral-200 border border-black'
          aria-label={t('Applications')}
        >
          {workspace.applications.map((application) => (
            <li
              key={application.id}
              className='flex flex-wrap items-center gap-3 px-3 py-2 text-sm'
            >
              <div className='min-w-40 flex-1'>
                <p className='font-semibold'>{application.company}</p>
                <p className='text-muted-foreground text-xs'>
                  {[
                    application.role,
                    application.track,
                    application.channel,
                    application.appliedOn,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <Select
                items={statusItems}
                value={application.status}
                onValueChange={(value) =>
                  value && changeStatus(application, value as ApplicationStatus)
                }
              >
                <SelectTrigger
                  size='sm'
                  className='w-36'
                  aria-label={t('Status of {{company}}', {
                    company: application.company,
                  })}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {APPLICATION_STATUSES.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {t(item.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {application.jd && (
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => props.onAnalyse(application.jd)}
                >
                  {t('Match resume')}
                </Button>
              )}
              {application.status === 'rejected' && (
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => props.onDebrief(application)}
                >
                  {t('Debrief')}
                </Button>
              )}
              <Button
                size='icon'
                variant='ghost'
                aria-label={t('Edit {{company}}', {
                  company: application.company,
                })}
                onClick={() => {
                  setEditing(application.id)
                  form.reset({ ...application })
                }}
              >
                <Pencil aria-hidden='true' />
              </Button>
              <Button
                size='icon'
                variant='ghost'
                aria-label={t('Delete {{company}}', {
                  company: application.company,
                })}
                onClick={() => setDeleting(application)}
              >
                <Trash2 aria-hidden='true' />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          bordered
          title={t('No applications yet')}
          description={t(
            'Record every application here to see which directions and channels work for you.'
          )}
        />
      )}

      <section className='space-y-3' aria-labelledby='career-conversion-title'>
        <h2 id='career-conversion-title' className='text-lg font-semibold'>
          {t('Conversion')}
        </h2>
        <StatTiles stats={stats} />
        <Insights stats={stats} />
        <div className='grid gap-4 md:grid-cols-2'>
          <ConversionTable title={t('Direction')} rows={stats.byTrack} />
          <ConversionTable title={t('Channel')} rows={stats.byChannel} />
        </div>
      </section>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('Delete application')}
        desc={t('Delete {{company}} - {{role}}? This cannot be undone.', {
          company: deleting?.company ?? '',
          role: deleting?.role ?? '',
        })}
        destructive
        confirmText={t('Delete')}
        handleConfirm={() => {
          if (deleting) removeApplication(userId, deleting.id)
          setDeleting(null)
        }}
      />
    </div>
  )
}
