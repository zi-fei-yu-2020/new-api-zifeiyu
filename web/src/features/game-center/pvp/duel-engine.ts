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
export const DUEL_VERSION = 1
export const DUEL_DURATION = 900
export const DUEL_TICK_MS = 100
export const DUEL_MAX_INPUT_BATCH = 300

export type DuelBeamTarget = { x: number; y: number; kind: number }
export type DuelPlayer = {
  x: number
  y: number
  hp: number
  max_hp: number
  score: number
  kills: number
  collected: number
  power: number
  speed: number
  upgrades: number
  haste: number
  extra_targets: number
  attack_charge: number
  dash_until: number
  dash_ready: number
  hurt_until: number
  beam_until: number
  beam_targets: DuelBeamTarget[] | null
  cursor: number
}
export type DuelEnemy = {
  id: number
  x: number
  y: number
  hp: number
  kind: number
  last_hit: number
}
export type DuelToken = { x: number; y: number; value: number }
export type DuelState = {
  version: number
  tick: number
  rng: number
  next_id: number
  players: [DuelPlayer, DuelPlayer]
  enemies: DuelEnemy[]
  tokens: DuelToken[]
  winner: number
  finished: boolean
}

export function newDuel(seed: number): DuelState {
  const players: [DuelPlayer, DuelPlayer] = [
    {
      x: 2500,
      y: 3500,
      hp: 100,
      max_hp: 100,
      score: 0,
      kills: 0,
      collected: 0,
      power: 3,
      speed: 140,
      upgrades: 0,
      haste: 0,
      extra_targets: 0,
      attack_charge: 0,
      dash_until: 0,
      dash_ready: 0,
      hurt_until: 0,
      beam_until: 0,
      beam_targets: null,
      cursor: 0,
    },
    {
      x: 7500,
      y: 3500,
      hp: 100,
      max_hp: 100,
      score: 0,
      kills: 0,
      collected: 0,
      power: 3,
      speed: 140,
      upgrades: 0,
      haste: 0,
      extra_targets: 0,
      attack_charge: 0,
      dash_until: 0,
      dash_ready: 0,
      hurt_until: 0,
      beam_until: 0,
      beam_targets: null,
      cursor: 0,
    },
  ]
  return {
    version: DUEL_VERSION,
    tick: 0,
    rng: seed >>> 0,
    next_id: 0,
    players,
    enemies: [],
    tokens: [],
    winner: 0,
    finished: false,
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

function random(s: DuelState, n: number) {
  s.rng = (Math.imul(s.rng, 1664525) + 1013904223) >>> 0
  return s.rng % n
}

export function encodeDuelInput(
  direction: number,
  dash: boolean,
  upgrade: number
) {
  return direction | (dash ? 16 : 0) | (upgrade << 5)
}

// Kept in lockstep with pkg/tokengame/duel.go; shared replay fixtures verify parity.
export function step(s: DuelState, input1: number, input2: number) {
  if (s.finished) return
  s.tick++
  const inputs = [input1, input2]
  for (let i = 0; i < s.players.length; i++) {
    const player = s.players[i]
    const choice = inputs[i] >> 5
    if (choice > 0 && player.upgrades < Math.min(3, Math.floor(s.tick / 200))) {
      player.upgrades++
      if (choice === 1) player.power += 2
      if (choice === 2) {
        player.haste++
        player.speed = 140 + 35 * player.haste
      }
      if (choice === 3) player.extra_targets++
    }
    if (inputs[i] & 16 && s.tick >= player.dash_ready) {
      player.dash_until = s.tick + 4
      player.dash_ready = s.tick + 45
    }
    const d = directions[inputs[i] & 15]
    let speed = player.speed
    if (s.tick < player.dash_until) speed *= 3
    if (d[0] !== 0 && d[1] !== 0) speed = Math.trunc((speed * 707) / 1000)
    player.x = Math.max(200, Math.min(9800, player.x + d[0] * speed))
    player.y = Math.max(200, Math.min(6800, player.y + d[1] * speed))
  }
  duelAttack(s, 0)
  duelAttack(s, 1)
  duelSpawn(s)
  duelMoveEnemies(s)
  duelReapEnemies(s)
  duelCollectTokens(s)
  if (s.tick % 10 === 0) {
    s.players[0].score++
    s.players[1].score++
  }
  duelSettle(s)
}

// Forfeit records a resignation as a knockout loss for the resigned slot.
export function forfeit(s: DuelState, slot: number) {
  if (s.finished) return
  s.players[slot].hp = 0
  duelSettle(s)
}

function duelAttack(s: DuelState, slot: number) {
  const player = s.players[slot]
  player.attack_charge += 100 + 25 * player.haste
  if (player.attack_charge < 400) return
  player.attack_charge -= 400
  player.beam_targets = null
  let shots = 1 + player.extra_targets
  const opponent = s.players[1 - slot]
  if (opponent.hp > 0) {
    const dx = opponent.x - player.x
    const dy = opponent.y - player.y
    if (dx * dx + dy * dy <= 2200 * 2200) {
      opponent.hp = Math.max(0, opponent.hp - player.power)
      player.beam_until = s.tick + 2
      player.beam_targets = [{ x: opponent.x, y: opponent.y, kind: 1 }]
      shots--
    }
  }
  const selected = new Set<number>()
  while (shots > 0) {
    let closest = -1
    let dist = 2200 * 2200
    for (let i = 0; i < s.enemies.length; i++) {
      if (selected.has(i) || s.enemies[i].hp <= 0) continue
      const dx = s.enemies[i].x - player.x
      const dy = s.enemies[i].y - player.y
      const dd = dx * dx + dy * dy
      if (dd < dist) {
        closest = i
        dist = dd
      }
    }
    if (closest < 0) break
    selected.add(closest)
    const enemy = s.enemies[closest]
    enemy.hp -= player.power
    enemy.last_hit = slot + 1
    player.beam_until = s.tick + 2
    player.beam_targets = [
      ...(player.beam_targets ?? []),
      { x: enemy.x, y: enemy.y, kind: 0 },
    ]
    shots--
  }
}

function duelSpawn(s: DuelState) {
  const interval = Math.max(4, 10 - Math.floor(s.tick / 150))
  const boss = s.tick === 250 || s.tick === 550 || s.tick === 800
  if ((s.tick % interval !== 0 && !boss) || s.enemies.length >= 100) return
  let kind = random(s, 10)
  if (kind < 6) kind = 0
  else if (kind < 9) kind = 1
  else kind = 2
  if (boss) kind = 3
  let x = random(s, 10000)
  let y = random(s, 7000)
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
    hp: [4, 3, 14, 70][kind],
    kind,
    last_hit: 0,
  })
}

function duelMoveEnemies(s: DuelState) {
  for (const enemy of s.enemies) {
    // Chase the nearest living player; a tie keeps player one so the run
    // stays deterministic. When nobody is left alive this tick, hold course.
    let target = 0
    if (s.players[0].hp > 0 && s.players[1].hp > 0) {
      const dx1 = s.players[0].x - enemy.x
      const dy1 = s.players[0].y - enemy.y
      const dx2 = s.players[1].x - enemy.x
      const dy2 = s.players[1].y - enemy.y
      if (dx2 * dx2 + dy2 * dy2 < dx1 * dx1 + dy1 * dy1) target = 1
    } else if (s.players[1].hp > 0) {
      target = 1
    }
    const player = s.players[target]
    const dx = player.x - enemy.x
    const dy = player.y - enemy.y
    const dist = Math.max(1, Math.floor(Math.sqrt(dx * dx + dy * dy)))
    const velocity = [105, 155, 70, 90][enemy.kind] + Math.floor(s.tick / 30)
    enemy.x += Math.trunc((dx * velocity) / dist)
    enemy.y += Math.trunc((dy * velocity) / dist)
    if (
      dist < 330 &&
      s.tick >= player.hurt_until &&
      s.tick >= player.dash_until
    ) {
      player.hp = Math.max(0, player.hp - [8, 6, 15, 25][enemy.kind])
      player.hurt_until = s.tick + 8
    }
  }
}

function duelReapEnemies(s: DuelState) {
  const kept: DuelEnemy[] = []
  for (const enemy of s.enemies) {
    if (enemy.hp > 0) {
      kept.push(enemy)
      continue
    }
    const value = enemy.kind === 3 ? 100 : 10
    let slot = enemy.last_hit - 1
    if (slot < 0 || slot > 1) slot = 0
    s.players[slot].kills++
    s.players[slot].score += value * 2
    if (s.tokens.length < 200) {
      s.tokens.push({ x: enemy.x, y: enemy.y, value })
    }
  }
  s.enemies = kept
}

// Player one resolves first, so a token both players can reach in the same
// tick goes to player one; magnets pull toward whichever player judges it.
function duelCollectTokens(s: DuelState) {
  for (const player of s.players) {
    const kept: DuelToken[] = []
    for (const token of s.tokens) {
      const dx = player.x - token.x
      const dy = player.y - token.y
      const dist = Math.floor(Math.sqrt(dx * dx + dy * dy))
      if (dist < 450) {
        player.collected += token.value
        player.score += token.value * 3
        continue
      }
      if (dist < 1400) {
        token.x += Math.trunc((dx * 220) / dist)
        token.y += Math.trunc((dy * 220) / dist)
      }
      kept.push(token)
    }
    s.tokens = kept
  }
}

function duelSettle(s: DuelState) {
  const [first, second] = s.players
  if (first.hp <= 0 || second.hp <= 0) {
    s.finished = true
    if (first.hp <= 0 && second.hp <= 0) s.winner = 3
    else if (first.hp <= 0) s.winner = 2
    else s.winner = 1
    return
  }
  if (s.tick >= DUEL_DURATION) {
    s.finished = true
    s.winner = 3
    if (first.score > second.score) s.winner = 1
    else if (second.score > first.score) s.winner = 2
  }
}

// advanceDuel replays the authoritative simulation up to the allowed tick.
// Ticks beyond a player's submitted stream use the neutral input, so missing
// batches neither pause the clock nor speed it up.
export function advanceDuel(
  s: DuelState,
  allowed: number,
  inputs1: number[],
  inputs2: number[]
) {
  const limit = Math.min(Math.max(allowed, 0), DUEL_DURATION)
  while (s.tick < limit && !s.finished) {
    const input1 = s.tick < inputs1.length ? inputs1[s.tick] : 0
    const input2 = s.tick < inputs2.length ? inputs2[s.tick] : 0
    step(s, input1, input2)
  }
  s.players[0].cursor = Math.min(inputs1.length, s.tick)
  s.players[1].cursor = Math.min(inputs2.length, s.tick)
}

// One recorded batch per player per sequence number; batches are strictly
// sequential (from == previous from + length). The insertion-ordered id
// reproduces the server's processing order, received_at is the wall clock the
// server allowed the simulation to advance to, and quit marks the resignation
// batch that ended the duel.
export type DuelInputBatch = {
  id: number
  player: number
  seq: number
  from_tick: number
  inputs: number[]
  quit: boolean
  received_at: number
}

export function buildDuelStreams(batches: DuelInputBatch[]) {
  const ordered = [...batches].sort(
    (a, b) => a.player - b.player || a.seq - b.seq
  )
  const streams: [number[], number[]] = [[], []]
  for (const batch of ordered) {
    streams[batch.player - 1].push(...batch.inputs)
  }
  return streams
}

// Mirrors model/pvp.go pvpAllowedTicks: how far server time let the
// authoritative simulation advance when this batch arrived.
export function replayAllowedTicks(startedAt: number, receivedAt: number) {
  const elapsed = Math.floor((receivedAt - startedAt) / DUEL_TICK_MS)
  return Math.max(0, Math.min(elapsed, DUEL_DURATION + DUEL_MAX_INPUT_BATCH))
}

// replayDuelTo rebuilds the authoritative duel exactly as the server ran it:
// batches replay in arrival order and each one advances the simulation only to
// the tick the server clock allowed at that moment. If an accepted batch starts
// behind the current tick, the duel is rebuilt from the complete streams so
// those inputs take effect through the same deterministic rollback as the
// server instead of being acknowledged as neutral.
// target scrubs to an intermediate tick: batches that arrived later than that
// tick do not contribute, and the gap fills with neutral ticks. The settled
// end frame is the exception — a batch arriving after the deadline whose
// inputs the server still applied in its final forced advance is included.
export function replayDuelTo(
  seed: number,
  startedAt: number,
  batches: DuelInputBatch[],
  target: number
): DuelState {
  const ordered = [...batches].sort((a, b) => a.id - b.id)
  let state = newDuel(seed)
  const streams: [number[], number[]] = [[], []]
  for (const batch of ordered) {
    const allowed = replayAllowedTicks(startedAt, batch.received_at)
    const arrived = allowed <= target
    const settled = target >= DUEL_DURATION && state.tick < DUEL_DURATION
    if (!arrived && !settled) continue
    streams[batch.player - 1].push(...batch.inputs)
    if (batch.inputs.length > 0 && batch.from_tick < state.tick) {
      state = newDuel(seed)
    }
    advanceDuel(state, Math.min(allowed, target), streams[0], streams[1])
    if (batch.quit && arrived) forfeit(state, batch.player - 1)
  }
  // Fill the remaining gap with neutral ticks, exactly like the server's
  // forced settlement of a duel whose input window closed.
  advanceDuel(state, target, streams[0], streams[1])
  return state
}

// A replay cursor keeps ordinary forward playback incremental. Arrival ticks,
// seeks and the settled end frame still use replayDuelTo so late-input rollback
// and resignation semantics remain identical to a full authoritative replay.
export function createDuelReplayCursor(
  seed: number,
  startedAt: number,
  batches: DuelInputBatch[]
): (target: number) => DuelState {
  let state: DuelState | null = null
  let streams: [number[], number[]] = [[], []]
  return (target: number) => {
    const hasArrival = batches.some(
      (batch) => replayAllowedTicks(startedAt, batch.received_at) === target
    )
    if (
      state &&
      target === state.tick + 1 &&
      target < DUEL_DURATION &&
      !state.finished &&
      !hasArrival
    ) {
      advanceDuel(state, target, streams[0], streams[1])
      return state
    }

    state = replayDuelTo(seed, startedAt, batches, target)
    streams = buildDuelStreams(
      batches.filter(
        (batch) => replayAllowedTicks(startedAt, batch.received_at) <= target
      )
    )
    return state
  }
}
