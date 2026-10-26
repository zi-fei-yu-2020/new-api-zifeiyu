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
// Static, reviewed guidance for mainland China new graduates. It never goes
// through a model so policy details cannot be invented. All strings are i18n
// keys; keep them general and point users to the local authority.
export const POLICY_CARDS = [
  {
    id: 'fresh-status',
    title: 'How long do I keep fresh-graduate status?',
    points: [
      'For civil service and public institution exams, graduates who have not secured a job within two years of leaving school, and whose archives remain with the school or a talent service agency, are usually treated as fresh graduates.',
      'Companies define "fresh graduate" for campus hiring themselves; some only accept the current year.',
      'Signing a labor contract and paying social insurance may end fresh-graduate status for some exams. Read each announcement carefully.',
    ],
    action:
      'Check the exact definition in each recruitment announcement before applying.',
  },
  {
    id: 'tripartite',
    title: 'Tripartite agreement, labor contract and breach penalty',
    points: [
      'The tripartite agreement between school, student and employer is mainly used for employment records and moving your archives; the labor contract defines your employment relationship.',
      'Before signing, confirm the salary structure, probation period, work location, social insurance and housing fund base, and the breach penalty.',
      'Legal probation limits: up to two months for contracts of one to three years, and up to six months for three years or longer.',
      'If you want to withdraw, talk to HR first; many employers will negotiate.',
    ],
    action: 'Ask HR to confirm unclear terms in writing before you sign.',
  },
  {
    id: 'archives',
    title: 'What happens to my personal archives and hukou?',
    points: [
      'Since 2023 the graduate employment registration certificate is no longer required for hukou registration or archive transfer.',
      'Employers that can hold archives (such as state-owned enterprises and public institutions) receive them directly; otherwise they can be held by a public employment and talent service agency.',
      'Never open your sealed archive or keep it at home for long; it can become invalid and cause trouble later.',
    ],
    action:
      'Before leaving school, ask the career office where your archive will be sent.',
  },
  {
    id: 'insurance',
    title: 'Should I pay social insurance myself before finding a job?',
    points: [
      'Between graduation and your first job you can enrol as a flexibly employed person for pension and medical insurance, usually through the local social insurance app.',
      'Avoid gaps in medical insurance: many regions apply a waiting period after a lapse.',
      'Many cities count continuous contribution months for hukou, home purchase and school enrolment.',
    ],
    action:
      'Search for flexible employment enrolment in your local social insurance app.',
  },
  {
    id: 'subsidies',
    title: 'Which subsidies can I apply for?',
    points: [
      'One-off job-seeking subsidies support graduating students from families facing hardship (for example low-income households or those with student loans), usually through the school. Amounts are set by each province.',
      'Government employment internship programmes pay a living allowance to graduates within two years of leaving school, and may lead to an offer.',
      'Approved vocational training with a certificate may qualify for a training subsidy.',
      'Unemployed graduates can register at the local public employment service for free career guidance and job referrals.',
    ],
    action:
      'Search "高校毕业生" in the 掌上12333 app or your local human resources bureau account.',
  },
  {
    id: 'rights',
    title: 'Unpaid wages or unfair dismissal',
    points: [
      'Call the 12333 human resources hotline or file a complaint with the local labor inspection team.',
      'Labor arbitration is free; the time limit is generally one year.',
      'Keep evidence: contract, pay records, attendance, chat logs and badge.',
      'Students on internships are usually not in a labor relationship; read the internship agreement for allowance and insurance terms.',
    ],
    action: 'Take screenshots as soon as something goes wrong.',
  },
  {
    id: 'mental-health',
    title: 'When the pressure is too much',
    points: [
      'The national psychological assistance hotline 12356 is available; university counselling centres often serve recent graduates too.',
      'If low mood, insomnia or loss of appetite lasts more than two weeks, see the psychology or psychiatry department of a hospital. It is as normal as seeing a doctor for a cold.',
      'Talk honestly with your family about where you are; they often understand more than you expect.',
      'The outcome of a job search does not define your worth.',
    ],
    action: 'Talk to one person today.',
  },
] as const
