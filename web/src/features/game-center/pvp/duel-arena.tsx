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
import { useEffect, useRef, type MutableRefObject } from 'react'
import { useTranslation } from 'react-i18next'

import type { DuelState } from './duel-engine'
import type { DuelInput } from './use-duel-session'

type Props = {
  state: MutableRefObject<DuelState>
  mySlot: number
  active: boolean
  input?: MutableRefObject<DuelInput>
  controlsDisabled?: boolean
}

// The duel arena renders the same fixed-point world as the solo arena with
// two combatants: the local player in blue and the opponent in red, each with
// their own beams, dash rings and hurt flashes.
export function DuelArena({
  state,
  mySlot,
  active,
  input,
  controlsDisabled = false,
}: Props) {
  const { t } = useTranslation()
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const ctx = element.getContext('2d')
    if (!ctx) return
    const reduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches
    let frame = 0
    const smooth = [
      { x: state.current.players[0].x, y: state.current.players[0].y },
      { x: state.current.players[1].x, y: state.current.players[1].y },
    ]
    const positions = new Map<number, { x: number; y: number }>()
    const draw = () => {
      const width = element.clientWidth
      const height = width * 0.7
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      if (
        element.width !== Math.round(width * ratio) ||
        element.height !== Math.round(height * ratio)
      ) {
        element.width = Math.round(width * ratio)
        element.height = Math.round(height * ratio)
      }
      ctx.setTransform(element.width / 10000, 0, 0, element.height / 7000, 0, 0)
      ctx.fillStyle = '#f6f7f4'
      ctx.fillRect(0, 0, 10000, 7000)
      ctx.lineWidth = 10
      ctx.strokeStyle = '#e5e8e1'
      ctx.beginPath()
      for (let x = 0; x <= 10000; x += 500) {
        ctx.moveTo(x, 0)
        ctx.lineTo(x, 7000)
      }
      for (let y = 0; y <= 7000; y += 500) {
        ctx.moveTo(0, y)
        ctx.lineTo(10000, y)
      }
      ctx.stroke()
      ctx.strokeStyle = '#b2b7ab'
      ctx.lineWidth = 22
      for (const [x, y, dx, dy] of [
        [220, 220, 1, 1],
        [9780, 220, -1, 1],
        [220, 6780, 1, -1],
        [9780, 6780, -1, -1],
      ]) {
        ctx.beginPath()
        ctx.moveTo(x + dx * 280, y)
        ctx.lineTo(x, y)
        ctx.lineTo(x, y + dy * 280)
        ctx.stroke()
      }
      const s = state.current
      const avatars = [
        { x: s.players[0].x, y: s.players[0].y },
        { x: s.players[1].x, y: s.players[1].y },
      ]
      for (let i = 0; i < 2; i++) {
        smooth[i].x = reduced
          ? avatars[i].x
          : smooth[i].x + (avatars[i].x - smooth[i].x) * 0.35
        smooth[i].y = reduced
          ? avatars[i].y
          : smooth[i].y + (avatars[i].y - smooth[i].y) * 0.35
      }
      const tokens = active
        ? s.tokens
        : [
            { x: 5000, y: 3500, value: 10 },
            { x: 3400, y: 2200, value: 10 },
            { x: 6600, y: 4800, value: 10 },
          ]
      for (const token of tokens) {
        ctx.save()
        ctx.translate(token.x, token.y)
        ctx.rotate(Math.PI / 4)
        ctx.fillStyle = '#318b63'
        ctx.fillRect(-60, -60, 120, 120)
        ctx.restore()
      }
      const ids = new Set<number>()
      for (const e of s.enemies) {
        ids.add(e.id)
        let p = positions.get(e.id)
        if (!p) {
          p = { x: e.x, y: e.y }
          positions.set(e.id, p)
        }
        p.x = reduced ? e.x : p.x + (e.x - p.x) * 0.35
        p.y = reduced ? e.y : p.y + (e.y - p.y) * 0.35
        const radius = [130, 110, 190, 320][e.kind]
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(e.kind === 1 ? Math.PI / 4 : 0)
        ctx.fillStyle = ['#d78270', '#d8a14c', '#a76655', '#7f463c'][e.kind]
        ctx.fillRect(-radius, -radius, radius * 2, radius * 2)
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 20
        ctx.beginPath()
        ctx.moveTo(-radius * 0.4, 0)
        ctx.lineTo(radius * 0.4, 0)
        if (e.kind >= 2) {
          ctx.moveTo(0, -radius * 0.4)
          ctx.lineTo(0, radius * 0.4)
        }
        ctx.stroke()
        ctx.restore()
      }
      for (const id of positions.keys()) if (!ids.has(id)) positions.delete(id)
      for (let i = 0; i < 2; i++) {
        const player = s.players[i]
        const [px, py] = [smooth[i].x, smooth[i].y]
        if (player.hp <= 0) continue
        if (active && player.beam_until > s.tick) {
          ctx.strokeStyle = i === 0 ? '#31589c' : '#a4402f'
          ctx.lineWidth = 22
          ctx.beginPath()
          for (const target of player.beam_targets ?? []) {
            ctx.moveTo(px, py)
            ctx.lineTo(target.x, target.y)
          }
          ctx.stroke()
        }
        if (active && player.dash_until > s.tick) {
          ctx.strokeStyle = i === 0 ? '#7891b5' : '#bd8a80'
          ctx.lineWidth = 25
          ctx.beginPath()
          ctx.arc(px, py, 260, 0, Math.PI * 2)
          ctx.stroke()
        }
        // Slot one fights in blue, slot two in red; the local player's HUD
        // shows which color is theirs.
        ctx.fillStyle = i === 0 ? '#2d5aa0' : '#a03a2a'
        if (active && player.hurt_until > s.tick) {
          ctx.fillStyle = i === 0 ? '#7d9cd0' : '#c97a6b'
        }
        ctx.fillRect(px - 150, py - 150, 300, 300)
        ctx.fillStyle = '#fff'
        ctx.fillRect(px - 45, py - 45, 90, 90)
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [active, state, mySlot])
  useEffect(() => {
    if (!active || controlsDisabled || !input) return
    canvas.current?.focus({ preventScroll: true })
    const keys = new Set<string>()
    const update = () => {
      const x =
        Number(keys.has('d') || keys.has('arrowright')) -
        Number(keys.has('a') || keys.has('arrowleft'))
      const y =
        Number(keys.has('s') || keys.has('arrowdown')) -
        Number(keys.has('w') || keys.has('arrowup'))
      input.current.direction = [
        [8, 1, 2],
        [7, 0, 3],
        [6, 5, 4],
      ][y + 1][x + 1]
    }
    const down = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest(
          'input,textarea,select,button,a,summary,[role="button"],[contenteditable="true"]'
        )
      ) {
        return
      }
      const key = e.key.toLowerCase()
      if (
        [
          'w',
          'a',
          's',
          'd',
          'arrowup',
          'arrowdown',
          'arrowleft',
          'arrowright',
          ' ',
          '1',
          '2',
          '3',
        ].includes(key)
      ) {
        e.preventDefault()
        keys.add(key)
        update()
        if (key === ' ') input.current.dash = true
        if (['1', '2', '3'].includes(key)) input.current.upgrade = Number(key)
      }
    }
    const up = (e: KeyboardEvent) => {
      keys.delete(e.key.toLowerCase())
      update()
    }
    const blur = () => {
      keys.clear()
      input.current.direction = 0
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      blur()
    }
  }, [active, controlsDisabled, input])
  return (
    <canvas
      ref={canvas}
      tabIndex={0}
      aria-label={t(
        'Duel arena. Move with WASD or arrow keys; press Space to dash.'
      )}
      className='game-arena focus-visible:outline-foreground block aspect-[10/7] w-full focus-visible:outline-2 focus-visible:outline-offset-[-3px]'
    />
  )
}
