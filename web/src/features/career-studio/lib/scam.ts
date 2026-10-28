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
import type { ScamCheckResult } from '../types'

// Labels are i18n keys. Rules run before and after the model: a strong rule
// hit can never be downgraded to low risk by a model answer.
const SCAM_RULES = [
  {
    label: 'Training loan or pay-to-train',
    strong: true,
    pattern:
      /(培训|学习)(费|贷)|先培训后(就业|上岗)|包分配|分期(付|还)|training (fee|loan)/i,
  },
  {
    label: 'Upfront payment before onboarding',
    strong: true,
    pattern:
      /押金|保证金|服装费|工装费|体检费.*(交|付)|材料费|入职费|建档费|报名费|deposit|uniform fee/i,
  },
  {
    label: 'Order brushing or advance-payment side job',
    strong: true,
    pattern: /刷单|刷信誉|点赞赚|垫付|佣金返还/,
  },
  {
    label: 'Withholding identity documents',
    strong: true,
    pattern: /身份证.{0,6}(交|押|扣)|扣(押|留).{0,4}(证件|身份证|毕业证)/,
  },
  {
    label: 'Pressure to take out a loan',
    strong: true,
    pattern: /(贷款|网贷|信用卡).{0,8}(办理|申请|激活)/,
  },
  {
    label: 'High pay with no requirements',
    strong: false,
    pattern:
      /无(需|要)?经验.{0,10}(月薪|日薪)?.{0,4}[2-9]\d{4}|轻松.{0,4}(月入|日入)|日结.{0,6}(千|万)/,
  },
  {
    label: 'No labor contract',
    strong: false,
    pattern: /合作协议|承揽协议|不签(劳动)?合同|没有(劳动)?合同/,
  },
  {
    label: 'Pyramid-style recruiting',
    strong: false,
    pattern: /拉人头|发展下线|团队计酬|入门费|创业团队.{0,10}(投资|入股)/,
  },
] as const

export function ruleBasedScamCheck(text: string): ScamCheckResult {
  const hits = SCAM_RULES.filter((rule) => rule.pattern.test(text))
  let risk: ScamCheckResult['risk'] = 'low'
  if (hits.some((hit) => hit.strong) || hits.length >= 2) risk = 'high'
  else if (hits.length) risk = 'medium'
  const summaries = {
    high: 'High risk. Do not continue.',
    medium: 'Suspicious points found. Verify before deciding.',
    low: 'No obvious red flags were found by the rules. Still verify the company.',
  }
  return {
    risk,
    summary: summaries[risk],
    redFlags: hits.map((hit) => hit.label),
    advice:
      'Legitimate employers never charge you, arrange loans or keep your documents before you start. Verify the company in the national enterprise credit system.',
  }
}

/** Never let a model answer lower the risk below what strong rule hits prove. */
export function mergeScamResult(
  text: string,
  model: ScamCheckResult
): ScamCheckResult {
  const rules = ruleBasedScamCheck(text)
  const order = { low: 0, medium: 1, high: 2 }
  const risk = order[model.risk] >= order[rules.risk] ? model.risk : rules.risk
  return {
    ...model,
    risk,
    redFlags: [...new Set([...rules.redFlags, ...model.redFlags])],
  }
}
