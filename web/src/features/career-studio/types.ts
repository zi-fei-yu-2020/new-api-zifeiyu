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
export const APPLICATION_STATUSES = [
  { value: 'wishlist', label: 'Wishlist' },
  { value: 'applied', label: 'Applied' },
  { value: 'test', label: 'Online test' },
  { value: 'interview', label: 'Interviewing' },
  { value: 'offer', label: 'Offer' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'ghosted', label: 'No response' },
] as const
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]['value']

export type CareerProfile = {
  school: string
  major: string
  graduationYear: string
  targetRoles: string
  cities: string
  resume: string
}

export type CareerApplication = {
  id: string
  company: string
  role: string
  track: string
  channel: string
  status: ApplicationStatus
  appliedOn: string
  jd: string
}

export type DailyTask = { id: string; title: string; done: boolean }
export type DailyPlan = { day: string; tasks: DailyTask[] }

export type ReviewResult = {
  empathy: string
  reframe: string
  controllable: string[]
  uncontrollable: string[]
  nextActions: string[]
  lesson: string
}
export type ReviewEntry = {
  id: string
  createdAt: string
  stage: string
  company: string
  content: string
  result: ReviewResult
}

export type CareerWorkspace = {
  profile: CareerProfile
  applications: CareerApplication[]
  daily: DailyPlan | null
  reviews: ReviewEntry[]
}

export type JdMatchResult = {
  score: number
  verdict: string
  matched: string[]
  gaps: { item: string; advice: string }[]
  rewrites: { before: string; after: string }[]
  selfIntro: string
  likelyQuestions: string[]
}

export type InterviewQuestion = {
  question: string
  intent: string
  tip: string
}
export type InterviewFeedback = {
  score: number
  strengths: string[]
  improvements: string[]
  betterAnswer: string
  followUp: string
}

export type ScamCheckResult = {
  risk: 'high' | 'medium' | 'low'
  summary: string
  redFlags: string[]
  advice: string
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string }
export type ChatEntry = ChatMessage & { id: string }

/** Translatable copy produced by pure logic: an i18n key and its values. */
export type LocalizedText = {
  key: string
  values?: Record<string, string | number>
}
