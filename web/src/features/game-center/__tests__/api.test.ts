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
import i18next from 'i18next'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { startGame } from '../api'

afterEach(async () => {
  await i18next.changeLanguage('en')
})

it('preserves a failed start envelope so message_key is translated', async () => {
  const messageKey = 'The daily challenge is currently closed'
  const envelope = {
    success: false,
    message: messageKey,
    message_key: messageKey,
  }
  i18next.addResourceBundle(
    'zh',
    'translation',
    { [messageKey]: '每日挑战暂未开放' },
    true,
    true
  )
  await i18next.changeLanguage('zh')
  vi.spyOn(api, 'post').mockResolvedValue({ data: envelope } as never)

  await expect(startGame()).rejects.toMatchObject({
    message: '每日挑战暂未开放',
    cause: envelope,
  })
})
