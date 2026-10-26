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
// Crisis screening runs locally before any free text reaches a model. It is
// rule based on purpose: it needs no network, costs nothing, and must keep
// working when the model or the balance is unavailable. False positives are
// acceptable; a missed crisis is not.
const CRISIS_PATTERNS = [
  /想死|不想活|活着没意思|活不下去|自杀|轻生|了结自己|结束(自己的)?生命/,
  /跳楼|割腕|吃安眠药|烧炭|一了百了|去死|死了算了|死了就好|不想再醒来|遗书|告别这个世界/,
  /消失(在这个世界|掉)?算了/,
  /\b(kill(ing)? myself|suicid(e|al)|end(ing)? my life|want to die|don'?t want to live|self[- ]harm)\b/i,
]
const DISTRESS_PATTERNS = [
  /崩溃|撑不下去|绝望|没有希望|喘不过气|一无是处|废物|没用的人|焦虑到|睡不着|失眠|抑郁/,
  /\b(hopeless|worthless|can'?t go on|breaking down|panic attack|depressed)\b/i,
]

export type SafetyLevel = 'crisis' | 'distress' | 'none'

export function screenText(text: string): SafetyLevel {
  const compact = text.replaceAll(/\s+/g, '')
  if (
    CRISIS_PATTERNS.some(
      (pattern) => pattern.test(compact) || pattern.test(text)
    )
  ) {
    return 'crisis'
  }
  if (
    DISTRESS_PATTERNS.some(
      (pattern) => pattern.test(compact) || pattern.test(text)
    )
  ) {
    return 'distress'
  }
  return 'none'
}

export const CRISIS_HOTLINES = [
  {
    phone: '12356',
    label: 'National psychological assistance hotline (China)',
  },
  { phone: '400-161-9995', label: 'Hope 24 crisis hotline (China)' },
  { phone: '120', label: 'Medical emergency (China)' },
  { phone: '110', label: 'Police (China)' },
] as const
