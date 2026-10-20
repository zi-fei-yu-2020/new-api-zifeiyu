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
export const DURATION = 900
export const UPGRADE_PAUSE_TICKS = 100
export const TICK_MS = 100
export const MAX_INPUT_BATCH = 300
export type Enemy = {
  id: number
  x: number
  y: number
  hp: number
  kind: number
}
export type Token = { x: number; y: number; value: number }
export type GameState = {
  version: number
  tick: number
  clock_tick?: number
  pause_ticks?: number
  rng: number
  x: number
  y: number
  hp: number
  max_hp: number
  score: number
  kills: number
  collected: number
  picked_tokens: number
  power: number
  speed: number
  upgrades: number
  haste?: number
  extra_targets?: number
  attack_charge?: number
  beam_targets?: { x: number; y: number }[]
  dash_until: number
  dash_ready: number
  hurt_until: number
  beam_x: number
  beam_y: number
  beam_until: number
  next_id: number
  enemies: Enemy[]
  tokens: Token[]
}
export function newGame(seed: number, version = 3): GameState {
  return {
    version,
    ...(version >= 2 ? { clock_tick: 0, pause_ticks: 0 } : {}),
    tick: 0,
    rng: seed,
    x: 5000,
    y: 3500,
    hp: 100,
    max_hp: 100,
    score: 0,
    kills: 0,
    collected: 0,
    picked_tokens: 0,
    power: 3,
    speed: 140,
    upgrades: 0,
    dash_until: 0,
    dash_ready: 0,
    hurt_until: 0,
    beam_x: 0,
    beam_y: 0,
    beam_until: 0,
    next_id: 0,
    enemies: [],
    tokens: [],
  }
}
const directions = [
  [0, 0],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
]
function random(s: GameState, n: number) {
  s.rng = (Math.imul(s.rng, 1664525) + 1013904223) >>> 0
  return s.rng % n
}
export function gameDuration(s: GameState) {
  return s.version >= 2 ? DURATION : 1800
}
export function gameCursor(s: GameState) {
  return s.version >= 2 ? (s.clock_tick ?? 0) : s.tick
}
export function upgradePending(s: GameState) {
  return (
    s.version >= 2 &&
    !isDone(s) &&
    s.upgrades < Math.min(3, Math.floor(s.tick / 200))
  )
}
export function isDone(s: GameState) {
  return s.hp <= 0 || s.tick >= gameDuration(s)
}
// Kept in lockstep with pkg/tokengame/engine.go; shared replay fixtures verify parity.
export function step(s: GameState, input: number) {
  if (isDone(s)) return
  if (s.version >= 2) {
    s.clock_tick = (s.clock_tick ?? 0) + 1
    if (upgradePending(s)) {
      s.pause_ticks = (s.pause_ticks ?? 0) + 1
      let choice = input >> 5
      if (choice === 0 && s.pause_ticks >= UPGRADE_PAUSE_TICKS) choice = 3
      if (choice > 0) {
        s.upgrades++
        s.pause_ticks = 0
        if (choice === 1) s.power += 2
        if (choice === 2) {
          if (s.version >= 3) {
            s.haste = (s.haste ?? 0) + 1
            s.speed = 140 + 35 * s.haste
          } else s.speed += 20
        }
        if (choice === 3) {
          if (s.version >= 3) s.extra_targets = (s.extra_targets ?? 0) + 1
          else {
            s.max_hp += 15
            s.hp = Math.min(s.max_hp, s.hp + 35)
          }
        }
      }
      return
    }
  }
  s.tick++
  const upgrade = input >> 5
  if (
    s.version < 2 &&
    upgrade > 0 &&
    s.upgrades < Math.min(5, Math.floor(s.tick / 300))
  ) {
    s.upgrades++
    if (upgrade === 1) s.power += 2
    if (upgrade === 2) s.speed += 20
    if (upgrade === 3) {
      s.max_hp += 15
      s.hp = Math.min(s.max_hp, s.hp + 35)
    }
  }
  if (input & 16 && s.tick >= s.dash_ready) {
    s.dash_until = s.tick + 4
    s.dash_ready = s.tick + 45
  }
  const d = directions[input & 15]
  let speed = s.speed
  if (s.tick < s.dash_until) speed *= 3
  if (d[0] && d[1]) speed = Math.trunc((speed * 707) / 1000)
  s.x = Math.max(200, Math.min(9800, s.x + d[0] * speed))
  s.y = Math.max(200, Math.min(6800, s.y + d[1] * speed))
  const interval =
    s.version >= 2
      ? Math.max(4, 10 - Math.floor(s.tick / 150))
      : Math.max(5, 15 - Math.floor(s.tick / 180))
  const boss = (s.version >= 2 ? [250, 550, 800] : [600, 1200, 1650]).includes(
    s.tick
  )
  if ((s.tick % interval === 0 || boss) && s.enemies.length < 100) {
    let kind = random(s, 10)
    if (kind < 6) kind = 0
    else if (kind < 9) kind = 1
    else kind = 2
    if (boss) kind = 3
    let x = random(s, 10000),
      y = random(s, 7000)
    switch (random(s, 4)) {
      case 0:
        x = 0
        break
      case 1:
        x = 10000
        break
      case 2:
        y = 0
        break
      case 3:
        y = 7000
        break
    }
    s.enemies.push({
      id: ++s.next_id,
      x,
      y,
      hp: (s.version >= 2 ? [4, 3, 14, 70] : [3, 2, 12, 100])[kind],
      kind,
    })
  }
  let attackReady = s.tick % (s.version >= 2 ? 4 : 5) === 0
  if (s.version >= 3) {
    s.attack_charge = (s.attack_charge ?? 0) + 100 + 25 * (s.haste ?? 0)
    attackReady = s.attack_charge >= 400
    if (attackReady) s.attack_charge -= 400
  }
  if (attackReady && s.enemies.length) {
    const targetCount = s.version >= 3 ? 1 + (s.extra_targets ?? 0) : 1
    if (s.version >= 3) delete s.beam_targets
    const selected = new Set<number>()
    for (let shot = 0; shot < targetCount; shot++) {
      let closest = -1,
        dist = 2200 * 2200
      s.enemies.forEach((e, i) => {
        if (s.version >= 3 && (selected.has(i) || e.hp <= 0)) return
        const dd = (e.x - s.x) ** 2 + (e.y - s.y) ** 2
        if (dd < dist) {
          closest = i
          dist = dd
        }
      })
      if (closest < 0) break
      selected.add(closest)
      const e = s.enemies[closest]
      e.hp -= s.power
      if (shot === 0) {
        s.beam_x = e.x
        s.beam_y = e.y
      }
      s.beam_until = s.tick + 2
      if (s.version >= 3) {
        s.beam_targets ??= []
        s.beam_targets.push({ x: e.x, y: e.y })
      }
    }
  }

  s.enemies = s.enemies.filter((e) => {
    if (e.hp <= 0) {
      s.kills++
      const value = e.kind === 3 ? 100 : 10
      s.score += value * 2
      if (s.tokens.length < 200) s.tokens.push({ x: e.x, y: e.y, value })
      return false
    }
    const dx = s.x - e.x,
      dy = s.y - e.y,
      dist = Math.max(1, Math.floor(Math.sqrt(dx * dx + dy * dy)))
    const velocity =
      s.version >= 2
        ? [105, 155, 70, 90][e.kind] + Math.floor(s.tick / 30)
        : [48, 85, 32, 38][e.kind] + Math.floor(s.tick / 120)
    e.x += Math.trunc((dx * velocity) / dist)
    e.y += Math.trunc((dy * velocity) / dist)
    if (dist < 330 && s.tick >= s.hurt_until && s.tick >= s.dash_until) {
      s.hp = Math.max(0, s.hp - [8, 6, 15, 25][e.kind])
      s.hurt_until = s.tick + 8
    }
    return true
  })
  s.tokens = s.tokens.filter((token) => {
    const dx = s.x - token.x,
      dy = s.y - token.y,
      dist = Math.floor(Math.sqrt(dx * dx + dy * dy))
    if (dist < 450) {
      s.collected += token.value
      s.picked_tokens++
      s.score += token.value * 3
      return false
    }
    if (dist < 1400) {
      token.x += Math.trunc((dx * 220) / dist)
      token.y += Math.trunc((dy * 220) / dist)
    }
    return true
  })
  if (s.tick % 10 === 0) s.score++
}
