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

import type { GameState } from './engine'

type Props = {
  state: MutableRefObject<GameState>
  input: MutableRefObject<{ direction: number; dash: boolean; upgrade: number }>
  active: boolean
  controlsDisabled?: boolean
}
export function Arena({
  state,
  input,
  active,
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
    let frame = 0,
      px = state.current.x,
      py = state.current.y
    const positions = new Map<number, { x: number; y: number }>()
    const draw = () => {
      const width = element.clientWidth,
        height = width * 0.7,
        ratio = Math.min(window.devicePixelRatio || 1, 2)
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
      // Corner marks frame a quiet, bright tactical arena.
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
      px = reduced ? s.x : px + (s.x - px) * 0.35
      py = reduced ? s.y : py + (s.y - py) * 0.35
      ctx.setLineDash([35, 70])
      ctx.strokeStyle = '#d8ddd1'
      ctx.lineWidth = 12
      ctx.beginPath()
      ctx.arc(px, py, 2200, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      const tokens = active
        ? s.tokens
        : [
            { x: 3400, y: 2400, value: 10 },
            { x: 6300, y: 4500, value: 10 },
            { x: 4400, y: 4800, value: 10 },
            { x: 6500, y: 2000, value: 10 },
          ]
      for (const token of tokens) {
        ctx.save()
        ctx.translate(token.x, token.y)
        ctx.rotate(Math.PI / 4)
        ctx.fillStyle = '#318b63'
        ctx.fillRect(-60, -60, 120, 120)
        ctx.restore()
      }
      const enemies = active
        ? s.enemies
        : [
            { id: -1, x: 2000, y: 1800, kind: 0, hp: 3 },
            { id: -2, x: 7800, y: 5200, kind: 2, hp: 12 },
            { id: -3, x: 7600, y: 1800, kind: 1, hp: 2 },
            { id: -4, x: 2600, y: 5500, kind: 0, hp: 3 },
          ]
      const ids = new Set<number>()
      for (const e of enemies) {
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
      if (active && s.beam_until > s.tick) {
        ctx.strokeStyle = '#343b30'
        ctx.lineWidth = 22
        ctx.beginPath()
        const targets =
          s.version >= 3
            ? (s.beam_targets ?? [])
            : [{ x: s.beam_x, y: s.beam_y }]
        for (const target of targets) {
          ctx.moveTo(px, py)
          ctx.lineTo(target.x, target.y)
        }
        ctx.stroke()
      }
      if (active && s.dash_until > s.tick) {
        ctx.strokeStyle = '#78a48a'
        ctx.lineWidth = 25
        ctx.beginPath()
        ctx.arc(px, py, 260, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.fillStyle = active && s.hurt_until > s.tick ? '#b35443' : '#20251e'
      ctx.fillRect(px - 150, py - 150, 300, 300)
      ctx.fillStyle = '#fff'
      ctx.fillRect(px - 45, py - 45, 90, 90)
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [active, state])
  useEffect(() => {
    if (!active || controlsDisabled) return
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
    const release = () => {
      keys.clear()
      input.current.direction = 0
      input.current.dash = false
      input.current.upgrade = 0
    }
    const down = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('input,textarea,select,[contenteditable="true"]')) {
        return
      }
      // Space and Enter activate a focused button or link; the movement keys
      // stay live so a clicked upgrade button does not freeze the player.
      if (
        (e.key === ' ' || e.key === 'Enter') &&
        target?.closest('button,a,summary,[role="button"]')
      ) {
        return
      }
      // Browser and OS shortcuts (Cmd+1, Ctrl+S, Alt+Arrow) belong to the
      // user, and the keyup of a key pressed under Cmd is never delivered, so
      // a modifier combo releases every held movement key instead.
      if (e.ctrlKey || e.metaKey || e.altKey) {
        release()
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
    const hide = () => {
      if (document.hidden) release()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', hide)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', hide)
      release()
    }
  }, [active, controlsDisabled, input])
  return (
    <canvas
      ref={canvas}
      tabIndex={0}
      aria-label={t(
        'Game arena. Move with WASD or arrow keys; press Space to dash.'
      )}
      className='game-arena focus-visible:outline-foreground block aspect-[10/7] w-full focus-visible:outline-2 focus-visible:outline-offset-[-3px]'
    />
  )
}
