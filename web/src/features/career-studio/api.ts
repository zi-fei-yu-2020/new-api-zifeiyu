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
import type { ChatCompletionResponse } from '@/features/playground/types'
import { api, getFreshAuthHeaders } from '@/lib/api'
import { createServerError } from '@/lib/server-error-message'

import {
  CHAT_TASK,
  DAILY_TASK,
  INTERVIEW_FEEDBACK_TASK,
  INTERVIEW_QUESTIONS_TASK,
  JD_MATCH_TASK,
  JSON_ONLY,
  REVIEW_TASK,
  SCAM_TASK,
  coachPersona,
  profileSummary,
} from './lib/prompts'
import { mergeScamResult } from './lib/scam'
import {
  MALFORMED_RESPONSE,
  parseModelJson,
  readRecords,
  readScore,
  readString,
  readStrings,
  uniqueBy,
} from './lib/structured'
import type {
  CareerProfile,
  ChatMessage,
  InterviewFeedback,
  InterviewQuestion,
  JdMatchResult,
  ReviewResult,
  ScamCheckResult,
} from './types'

export type CareerModel = {
  model: string
  group: string
  today: string
  replyLanguage: string
}

// Requests go through the session playground relay: the user's own group,
// channels and wallet are charged exactly like the Playground.
async function complete(
  target: CareerModel,
  system: string,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<string> {
  await getFreshAuthHeaders()
  signal?.throwIfAborted()
  const response = await api.post<ChatCompletionResponse>(
    '/pg/chat/completions',
    {
      model: target.model,
      group: target.group,
      messages: [
        {
          role: 'system',
          content: `${coachPersona(target.today, target.replyLanguage)}\n${system}`,
        },
        ...messages,
      ],
      max_tokens: 2048,
      stream: false,
    },
    {
      signal,
      timeout: 120_000,
      skipAuthRefresh: true,
      skipErrorHandler: true,
      skipBusinessError: true,
    }
  )
  const data = response.data
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw createServerError(data)
  }
  const choice = data?.choices?.[0]
  if (choice?.finish_reason === 'length') {
    throw new Error(
      'The model reached its output limit. Shorten the input or choose another model.'
    )
  }
  if (choice?.finish_reason === 'content_filter') {
    throw new Error('The model declined this content.')
  }
  const text = choice?.message?.content
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('The model returned no answer. Try another model.')
  }
  return text
}

async function completeJson(
  target: CareerModel,
  task: string,
  input: string,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const text = await complete(
    target,
    `${task}\n${JSON_ONLY}`,
    [{ role: 'user', content: input }],
    signal
  )
  return parseModelJson(text)
}

export async function matchJobDescription(
  target: CareerModel,
  profile: CareerProfile,
  resume: string,
  jd: string,
  signal?: AbortSignal
): Promise<JdMatchResult> {
  const data = await completeJson(
    target,
    JD_MATCH_TASK,
    `Profile: ${profileSummary(profile)}\n\nResume:\n${resume}\n\nJob description:\n${jd}`,
    signal
  )
  return {
    score: readScore(data.score, 100),
    verdict: readString(data.verdict, true),
    matched: readStrings(data.matched),
    gaps: uniqueBy(
      readRecords(data.gaps, (item) => ({
        item: readString(item.item, true),
        advice: readString(item.advice),
      })),
      (gap) => gap.item
    ),
    rewrites: uniqueBy(
      readRecords(data.rewrites, (item) => ({
        before: readString(item.before, true),
        after: readString(item.after, true),
      })),
      (rewrite) => rewrite.before
    ),
    selfIntro: readString(data.selfIntro),
    likelyQuestions: readStrings(data.likelyQuestions),
  }
}

export async function createInterview(
  target: CareerModel,
  role: string,
  jd: string,
  resume: string,
  signal?: AbortSignal
): Promise<InterviewQuestion[]> {
  const data = await completeJson(
    target,
    INTERVIEW_QUESTIONS_TASK,
    `Target role: ${role}\nJob description: ${jd || 'not provided'}\nResume: ${resume || 'not provided'}`,
    signal
  )
  const questions = uniqueBy(
    readRecords(data.questions, (item) => ({
      question: readString(item.question, true),
      intent: readString(item.intent),
      tip: readString(item.tip),
    })),
    (item) => item.question
  )
  if (!questions.length) throw new Error(MALFORMED_RESPONSE)
  return questions
}

export async function reviewAnswer(
  target: CareerModel,
  role: string,
  question: string,
  answer: string,
  signal?: AbortSignal
): Promise<InterviewFeedback> {
  const data = await completeJson(
    target,
    INTERVIEW_FEEDBACK_TASK,
    `Role: ${role}\nQuestion: ${question}\nCandidate answer:\n${answer}`,
    signal
  )
  return {
    score: readScore(data.score, 10),
    strengths: readStrings(data.strengths),
    improvements: readStrings(data.improvements),
    betterAnswer: readString(data.betterAnswer),
    followUp: readString(data.followUp),
  }
}

export async function debriefRejection(
  target: CareerModel,
  company: string,
  stage: string,
  content: string,
  signal?: AbortSignal
): Promise<ReviewResult> {
  const data = await completeJson(
    target,
    REVIEW_TASK,
    `Company and role: ${company || 'not provided'}\nStage: ${stage || 'not provided'}\nWhat happened:\n${content}`,
    signal
  )
  return {
    empathy: readString(data.empathy, true),
    reframe: readString(data.reframe, true),
    controllable: readStrings(data.controllable),
    uncontrollable: readStrings(data.uncontrollable),
    nextActions: readStrings(data.nextActions),
    lesson: readString(data.lesson),
  }
}

export async function planToday(
  target: CareerModel,
  profile: CareerProfile,
  summary: string,
  signal?: AbortSignal
): Promise<string[]> {
  const data = await completeJson(
    target,
    DAILY_TASK,
    `Profile: ${profileSummary(profile)}\nApplication data: ${summary}`,
    signal
  )
  const tasks = readStrings(data.tasks, 3)
  if (tasks.length !== 3) throw new Error(MALFORMED_RESPONSE)
  return tasks
}

export async function checkRecruitment(
  target: CareerModel,
  text: string,
  signal?: AbortSignal
): Promise<ScamCheckResult> {
  const data = await completeJson(target, SCAM_TASK, text, signal)
  const risk = data.risk
  if (risk !== 'high' && risk !== 'medium' && risk !== 'low') {
    throw new Error(MALFORMED_RESPONSE)
  }
  return mergeScamResult(text, {
    risk,
    summary: readString(data.summary, true),
    redFlags: readStrings(data.redFlags),
    advice: readString(data.advice),
  })
}

export async function chatWithCoach(
  target: CareerModel,
  profile: CareerProfile,
  history: ChatMessage[],
  signal?: AbortSignal
): Promise<string> {
  const text = await complete(
    target,
    `${CHAT_TASK}\nUser profile: ${profileSummary(profile)}`,
    history.slice(-12),
    signal
  )
  return text.trim()
}
