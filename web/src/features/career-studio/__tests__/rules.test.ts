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
import { describe, expect, it } from 'vitest'

import { calculateRunway } from '../lib/runway'
import { screenText } from '../lib/safety'
import { mergeScamResult, ruleBasedScamCheck } from '../lib/scam'
import { applicationStats, completedStreak } from '../lib/stats'
import type { CareerApplication } from '../types'

function application(
  overrides: Partial<CareerApplication> & Pick<CareerApplication, 'id'>
): CareerApplication {
  return {
    company: 'Acme',
    role: 'Backend',
    track: '',
    channel: '',
    status: 'applied',
    appliedOn: '2026-10-20',
    jd: '',
    ...overrides,
  }
}

const zeroExpenses = {
  rent: 0,
  food: 0,
  transport: 0,
  subscriptions: 0,
  leisure: 0,
  shopping: 0,
  other: 0,
}

describe('crisis screening', () => {
  it.each([
    ['又被拒了，真的不想活了', 'crisis'],
    ['我 想 死', 'crisis'],
    ['I want to die', 'crisis'],
    ['连续被拒，感觉要崩溃了', 'distress'],
    ['I feel hopeless about this', 'distress'],
    ['岗位要求熟悉 Java 和 MySQL', 'none'],
  ])('classifies %j as %s', (text, level) => {
    expect(screenText(text)).toBe(level)
  })
})

describe('recruitment scam rules', () => {
  it('rates a single strong signal as high risk', () => {
    expect(ruleBasedScamCheck('入职前需缴纳 800 元服装费').risk).toBe('high')
  })

  it('rates an ordinary posting as low risk', () => {
    expect(
      ruleBasedScamCheck('Java 开发，五险一金，双休，签劳动合同').risk
    ).toBe('low')
  })

  it('never lets a model answer lower the risk proven by strong rules', () => {
    const merged = mergeScamResult('先培训后就业，培训费可分期', {
      risk: 'low',
      summary: 'Looks fine',
      redFlags: [],
      advice: '',
    })
    expect(merged.risk).toBe('high')
    expect(merged.redFlags).toContain('Training loan or pay-to-train')
  })
})

describe('money runway', () => {
  it('divides savings by net monthly spend', () => {
    const result = calculateRunway(9000, 0, {
      ...zeroExpenses,
      rent: 2000,
      food: 1000,
    })
    expect(result.months).toBe(3)
    expect(result.level).toBe('watch')
    expect(result.monthsAfterCuts).toBeGreaterThan(3)
  })

  it('reports an unlimited runway when income covers spending', () => {
    const result = calculateRunway(1000, 5000, { ...zeroExpenses, rent: 2000 })
    expect(result.months).toBeNull()
    expect(result.level).toBe('safe')
  })

  it('treats negative and non-numeric input as zero', () => {
    const result = calculateRunway(Number.NaN, -10, {
      ...zeroExpenses,
      rent: -500,
      food: 1000,
    })
    expect(result.monthlyBurn).toBe(1000)
    expect(result.months).toBe(0)
  })
})

describe('application statistics', () => {
  it('ignores wishlist entries and computes the interview rate', () => {
    const stats = applicationStats(
      [
        application({ id: '1', status: 'interview' }),
        application({ id: '2', status: 'rejected' }),
        application({ id: '3', status: 'offer' }),
        application({ id: '4', status: 'ghosted' }),
        application({ id: '5', status: 'wishlist' }),
      ],
      '2026-10-26'
    )
    expect(stats.total).toBe(4)
    expect(stats.interviewRate).toBe(50)
    expect(stats.offers).toBe(1)
  })

  it('suggests the direction that converts clearly better', () => {
    const items = [
      ...['interview', 'interview', 'rejected', 'rejected'].map(
        (status, index) =>
          application({
            id: `ops-${index}`,
            track: 'Operations',
            status: status as CareerApplication['status'],
          })
      ),
      ...[0, 1, 2, 3].map((index) =>
        application({
          id: `dev-${index}`,
          track: 'Engineering',
          status: 'ghosted',
        })
      ),
    ]
    const insight = applicationStats(items, '2026-10-26').insights.find(
      (item) => item.values?.best === 'Operations'
    )
    expect(insight?.values).toMatchObject({
      worst: 'Engineering',
      bestRate: 50,
      worstRate: 0,
    })
  })

  it('counts only applications from the last seven days as this week', () => {
    const stats = applicationStats(
      [
        application({ id: '1', appliedOn: '2026-10-25' }),
        application({ id: '2', appliedOn: '2026-10-01' }),
      ],
      '2026-10-26'
    )
    expect(stats.thisWeek).toBe(1)
  })
})

describe('daily streak', () => {
  it('keeps yesterday’s streak when today is not finished yet', () => {
    expect(completedStreak(['2026-10-24', '2026-10-25'], '2026-10-26')).toBe(2)
  })

  it('breaks the streak after a missed day', () => {
    expect(completedStreak(['2026-10-22', '2026-10-26'], '2026-10-26')).toBe(1)
  })
})
