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
import { BriefcaseBusiness } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuthStore } from '@/stores/auth-store'

import { BoardPanel } from './components/board-panel'
import { ChatPanel } from './components/chat-panel'
import { InterviewPanel } from './components/interview-panel'
import { JdPanel } from './components/jd-panel'
import { CareerModelField } from './components/model-field'
import { ProfilePanel } from './components/profile-panel'
import { ReviewPanel } from './components/review-panel'
import { TodayPanel } from './components/today-panel'
import { ToolsPanel } from './components/tools-panel'
import { CareerVoiceField } from './components/voice-field'
import { useCareerModel } from './hooks/use-career'
import { useCareerTts } from './hooks/use-career-tts'

const TABS = [
  { value: 'today', label: 'Today' },
  { value: 'board', label: 'Applications' },
  { value: 'jd', label: 'Resume match' },
  { value: 'interview', label: 'Mock interview' },
  { value: 'review', label: 'Debrief' },
  { value: 'chat', label: 'Ask the coach' },
  { value: 'tools', label: 'Free tools' },
  { value: 'profile', label: 'Profile' },
] as const
type CareerTab = (typeof TABS)[number]['value']

export function CareerStudio() {
  const user = useAuthStore((state) => state.auth.user)
  // Remount per account so no state from another user survives a switch.
  return <CareerWorkspaceView key={`${user?.id}:${user?.group}`} />
}

function CareerWorkspaceView() {
  const { t } = useTranslation()
  const modelState = useCareerModel()
  const ttsState = useCareerTts(modelState)
  const [tab, setTab] = useState<CareerTab>('today')
  const [jd, setJd] = useState('')
  const [reviewCompany, setReviewCompany] = useState('')

  return (
    <div className='mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-8'>
      <header className='flex flex-wrap items-end justify-between gap-4 border-b-2 border-black pb-5'>
        <div>
          <p className='text-muted-foreground mb-2 text-xs font-medium'>
            {t('Job-search workspace')}
          </p>
          <h1 className='font-serif text-4xl font-medium tracking-tight sm:text-5xl'>
            {t('Career Studio')}
          </h1>
          <p className='text-muted-foreground mt-3 max-w-2xl text-sm'>
            {t(
              'A job-search companion for new graduates: tailor your resume, rehearse interviews, track applications and get through the pressure.'
            )}
          </p>
        </div>
        <div className='flex items-center gap-2 text-xs'>
          <BriefcaseBusiness className='size-4' aria-hidden='true' />
          <span>{t('Need to talk? Call 12356')}</span>
        </div>
      </header>

      <div className='grid gap-4 sm:grid-cols-2'>
        <CareerModelField state={modelState} />
        <CareerVoiceField tts={ttsState} />
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          // Reading aloud belongs to the visible tab.
          ttsState.stop()
          setTab(value as CareerTab)
        }}
      >
        <TabsList className='h-auto flex-wrap'>
          {TABS.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {t(item.label)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value='today' className='pt-4'>
          <TodayPanel modelState={modelState} />
        </TabsContent>
        <TabsContent value='board' className='pt-4'>
          <BoardPanel
            onAnalyse={(value) => {
              setJd(value)
              setTab('jd')
            }}
            onDebrief={(application) => {
              setReviewCompany(`${application.company} ${application.role}`)
              setTab('review')
            }}
          />
        </TabsContent>
        <TabsContent value='jd' className='pt-4'>
          <JdPanel modelState={modelState} jd={jd} onJdChange={setJd} />
        </TabsContent>
        <TabsContent value='interview' className='pt-4'>
          <InterviewPanel modelState={modelState} ttsState={ttsState} />
        </TabsContent>
        <TabsContent value='review' className='pt-4'>
          <ReviewPanel
            modelState={modelState}
            ttsState={ttsState}
            company={reviewCompany}
            onCompanyChange={setReviewCompany}
          />
        </TabsContent>
        <TabsContent value='chat' className='pt-4'>
          <ChatPanel modelState={modelState} ttsState={ttsState} />
        </TabsContent>
        <TabsContent value='tools' className='pt-4'>
          <ToolsPanel modelState={modelState} />
        </TabsContent>
        <TabsContent value='profile' className='pt-4'>
          <ProfilePanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}
