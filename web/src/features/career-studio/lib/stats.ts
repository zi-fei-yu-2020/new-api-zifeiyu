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
import type {
  ApplicationStatus,
  CareerApplication,
  LocalizedText,
} from '../types'

const REACHED_INTERVIEW = new Set<ApplicationStatus>(['interview', 'offer'])

export type ConversionRow = {
  name: string
  total: number
  interviews: number
  rate: number
}

export type ApplicationStats = {
  total: number
  thisWeek: number
  interviewing: number
  offers: number
  interviewRate: number
  byTrack: ConversionRow[]
  byChannel: ConversionRow[]
  insights: LocalizedText[]
}

function percent(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0
}

function conversion(
  applications: CareerApplication[],
  field: 'track' | 'channel'
): ConversionRow[] {
  const groups = new Map<string, CareerApplication[]>()
  for (const application of applications) {
    const name = application[field].trim()
    groups.set(name, [...(groups.get(name) ?? []), application])
  }
  return [...groups.entries()]
    .map(([name, items]) => {
      const interviews = items.filter((item) =>
        REACHED_INTERVIEW.has(item.status)
      ).length
      return {
        name,
        total: items.length,
        interviews,
        rate: percent(interviews, items.length),
      }
    })
    .sort((a, b) => b.total - a.total)
}

// A gap is only reported when both sides have enough samples to mean something.
function strongestGap(rows: ConversionRow[]) {
  const valid = rows.filter((row) => row.name && row.total >= 3)
  if (valid.length < 2) return null
  const best = valid.reduce((a, b) => (b.rate > a.rate ? b : a))
  const worst = valid.reduce((a, b) => (b.rate < a.rate ? b : a))
  return best.rate - worst.rate >= 15 ? { best, worst } : null
}

export function applicationStats(
  applications: CareerApplication[],
  today: string
): ApplicationStats {
  const sent = applications.filter((item) => item.status !== 'wishlist')
  const weekAgo = new Date(`${today}T00:00:00Z`)
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7)
  const weekStart = weekAgo.toISOString().slice(0, 10)
  const thisWeek = sent.filter((item) => item.appliedOn >= weekStart).length
  const interviewing = sent.filter((item) => item.status === 'interview').length
  const offers = sent.filter((item) => item.status === 'offer').length
  const ghosted = sent.filter((item) => item.status === 'ghosted').length
  const byTrack = conversion(sent, 'track')
  const byChannel = conversion(sent, 'channel')

  const insights: LocalizedText[] = []
  if (!sent.length) {
    insights.push({
      key: 'No applications yet. Send five, even imperfect ones; data shows which direction suits you.',
    })
  } else {
    if (thisWeek < 5) {
      insights.push({
        key: 'Only {{count}} applications in the last 7 days. Campus hiring is a numbers game: aim for 15-30 a week across 2-3 directions.',
        values: { count: thisWeek },
      })
    }
    if (sent.length >= 10 && interviewing + offers === 0) {
      insights.push({
        key: 'Ten or more applications without an interview usually means the resume screen is the bottleneck. Tailor your resume to a target job description.',
      })
    }
    if (ghosted >= Math.max(5, sent.length / 2)) {
      insights.push({
        key: 'Many applications got no response. Referrals and campus talks usually reply more often than mass applications.',
      })
    }
    for (const gap of [strongestGap(byTrack), strongestGap(byChannel)]) {
      if (!gap) continue
      insights.push({
        key: '"{{best}}" reaches interviews at {{bestRate}}%, well above "{{worst}}" at {{worstRate}}%. Consider leaning towards it.',
        values: {
          best: gap.best.name,
          bestRate: gap.best.rate,
          worst: gap.worst.name,
          worstRate: gap.worst.rate,
        },
      })
    }
    if (offers) {
      insights.push({
        key: 'You have {{count}} offer(s). Before signing, check the breach penalty, probation period and social insurance base.',
        values: { count: offers },
      })
    }
  }

  return {
    total: sent.length,
    thisWeek,
    interviewing,
    offers,
    interviewRate: percent(interviewing + offers, sent.length),
    byTrack,
    byChannel,
    insights,
  }
}

export function completedStreak(
  completedDays: string[],
  today: string
): number {
  const days = new Set(completedDays)
  const cursor = new Date(`${today}T00:00:00Z`)
  // An unfinished today does not break yesterday's streak.
  if (!days.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1)
  let streak = 0
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak++
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return streak
}

// Rule-based plan: available instantly, free, and the fallback when no model is used.
export function ruleBasedTasks(
  hasResume: boolean,
  interviewing: number,
  thisWeek: number,
  rejected: number
): string[] {
  const tasks: string[] = []
  if (!hasResume) tasks.push('Paste your resume into the profile')
  if (interviewing) tasks.push('Run a mock interview for an active process')
  if (thisWeek < 15) tasks.push('Apply to 5 target roles today')
  if (rejected) tasks.push('Write a debrief for your latest rejection')
  tasks.push('Tailor your resume to one job description')
  tasks.push('Take a 20-minute walk or workout')
  return tasks.slice(0, 3)
}
