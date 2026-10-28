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
import type { LocalizedText } from '../types'

export const RUNWAY_EXPENSES = [
  { key: 'rent', label: 'Rent', flexible: 0 },
  { key: 'food', label: 'Food', flexible: 0.25 },
  { key: 'transport', label: 'Transport', flexible: 0.2 },
  { key: 'subscriptions', label: 'Phone and subscriptions', flexible: 0.5 },
  { key: 'leisure', label: 'Leisure', flexible: 0.5 },
  { key: 'shopping', label: 'Shopping', flexible: 0.5 },
  { key: 'other', label: 'Other', flexible: 0.3 },
] as const
export type RunwayExpenseKey = (typeof RUNWAY_EXPENSES)[number]['key']

export type RunwayResult = {
  monthlyBurn: number
  months: number | null
  monthsAfterCuts: number | null
  monthlySavings: number
  level: 'safe' | 'watch' | 'tight'
  message: LocalizedText
}

function monthsLeft(savings: number, burn: number): number | null {
  return burn <= 0 ? null : Math.round((savings / burn) * 10) / 10
}

export function calculateRunway(
  savings: number,
  income: number,
  expenses: Record<RunwayExpenseKey, number>
): RunwayResult {
  const clean = (value: number) =>
    Number.isFinite(value) ? Math.max(value, 0) : 0
  const total = RUNWAY_EXPENSES.reduce(
    (sum, item) => sum + clean(expenses[item.key]),
    0
  )
  const monthlyBurn = total - clean(income)
  const months = monthsLeft(clean(savings), monthlyBurn)
  // Flexible ratios are rough rules of thumb, shown only as a reference.
  const monthlySavings = Math.round(
    RUNWAY_EXPENSES.reduce(
      (sum, item) => sum + clean(expenses[item.key]) * item.flexible,
      0
    )
  )
  const monthsAfterCuts = monthsLeft(
    clean(savings),
    monthlyBurn - monthlySavings
  )

  if (months === null) {
    return {
      monthlyBurn,
      months,
      monthsAfterCuts,
      monthlySavings,
      level: 'safe',
      message: {
        key: 'Your income covers your spending, so money is not forcing a decision. Take the time to choose well.',
      },
    }
  }
  if (months >= 6) {
    return {
      monthlyBurn,
      months,
      monthsAfterCuts,
      monthlySavings,
      level: 'safe',
      message: {
        key: 'About {{months}} months of runway. There is time; do not rush into an offer that does not fit.',
        values: { months },
      },
    }
  }
  if (months >= 3) {
    return {
      monthlyBurn,
      months,
      monthsAfterCuts,
      monthlySavings,
      level: 'watch',
      message: {
        key: 'About {{months}} months of runway. Trim flexible spending and consider a part-time job or internship as a bridge.',
        values: { months },
      },
    }
  }
  return {
    monthlyBurn,
    months,
    monthsAfterCuts,
    monthlySavings,
    level: 'tight',
    message: {
      key: 'Only about {{months}} months of runway. Consider a bridge job, an honest talk with your family, and local job-seeking subsidies.',
      values: { months },
    },
  }
}
