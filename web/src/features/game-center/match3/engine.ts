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
// Kept in lockstep with pkg/tokengame/match3.go; shared replay fixtures verify parity.
// Integer only: every uint32 result goes through Math.imul / >>> 0, arrays are
// iterated in id order, and nothing outside the seed and the inputs is read.
export const MATCH_VERSION = 1
export const MATCH_TRAY_CAP = 7
// Inclusive: a clear within 50 ticks of the previous one continues the combo.
export const MATCH_COMBO_WINDOW_TICKS = 50
export const MATCH_MIN_GAP_TICKS = 2
export const MATCH_MAX_INPUTS = 3000
export const MATCH_MAX_BATCH = 300
export const MATCH_ENERGY_CAP = 6
export const MATCH_START_ENERGY = 2
export const MATCH_MAX_TYPES = 10
export const MATCH_MAX_ARG = 127
export const MATCH_MAX_DELTA = 255
export const MATCH_TICK_MS = 100

export const MATCH_COST_REVEAL = 1
export const MATCH_COST_UNDO = 2
export const MATCH_COST_SHUFFLE = 3

export const MATCH_UNLOCK_REVEAL = 1
export const MATCH_UNLOCK_UNDO = 2
export const MATCH_UNLOCK_SHUFFLE = 4

export const MATCH_MODE_ENDLESS = 0
export const MATCH_MODE_DAILY = 1

export const MATCH_PLAYING = 0
export const MATCH_COMPLETED = 1
export const MATCH_LOST = 2

export const MATCH_LOC_BOARD = 0
export const MATCH_LOC_TRAY = 1
export const MATCH_LOC_CLEARED = 2

// Input = op | arg<<3 | dt<<10. Ops 5..7 are invalid.
export const MATCH_OP_WAIT = 0
export const MATCH_OP_PICK = 1
export const MATCH_OP_REVEAL = 2
export const MATCH_OP_UNDO = 3
export const MATCH_OP_SHUFFLE = 4

const ENDLESS_LEVEL_CAP = 30
const DAILY_FIRST_LEVEL = 5
const DAILY_LEVEL_CAP = 7
// Daily levels are shown as 1..3 although the engine numbers them 5..7.
export const MATCH_DAILY_LEVEL_OFFSET = DAILY_FIRST_LEVEL - 1

export type MatchTile = {
  id: number
  x: number
  y: number
  z: number
  type: number
  loc: number
  seq: number
}
export type MatchState = {
  version: number
  mode: number
  seed: number
  rng: number
  level: number
  level_cap: number
  clock: number
  last_clear: number
  last_act: number
  combo: number
  best_combo: number
  energy: number
  score: number
  cleared: number
  unlocks: number
  inputs: number
  picks: number
  undos: number
  reveals: number
  shuffles: number
  rejected: number
  next_seq: number
  status: number
  tiles: MatchTile[]
  tray: number[]
  hint: number[]
}
export type MatchInput = { op: number; arg: number; dt: number }

export function encodeMatchInput(op: number, arg: number, dt: number) {
  return op | (arg << 3) | (dt << 10)
}
export function decodeMatchInput(input: number): MatchInput {
  return { op: input & 7, arg: (input >> 3) & MATCH_MAX_ARG, dt: input >> 10 }
}
export function validMatchInput(input: number) {
  return (
    Number.isInteger(input) &&
    input >= 0 &&
    input < 1 << 18 &&
    (input & 7) <= MATCH_OP_SHUFFLE
  )
}
export function matchLevelSeed(seed: number, level: number) {
  return (seed + Math.imul(level, 0x9e3779b9)) >>> 0
}

// Advances the LCG and scales its high bits into [0, n). rng * n stays below 2^53.
function matchRandom(rng: { value: number }, n: number) {
  rng.value = (Math.imul(rng.value, 1664525) + 1013904223) >>> 0
  return Math.floor((rng.value * n) / 4294967296)
}
// Fisher-Yates drawing for i from len-1 down to 1.
function matchShuffle<T>(rng: { value: number }, items: T[]) {
  for (let i = items.length - 1; i >= 1; i--) {
    const j = matchRandom(rng, i + 1)
    const swap = items[i]
    items[i] = items[j]
    items[j] = swap
  }
}
// A board tile is covered by a board tile on a higher layer within one cell on both axes.
function matchCovered(tiles: MatchTile[], id: number) {
  const t = tiles[id]
  return tiles.some(
    (u) =>
      u.loc === MATCH_LOC_BOARD &&
      u.z > t.z &&
      Math.abs(u.x - t.x) < 2 &&
      Math.abs(u.y - t.y) < 2
  )
}
function matchExposedIds(tiles: MatchTile[]) {
  return tiles
    .filter((t) => t.loc === MATCH_LOC_BOARD && !matchCovered(tiles, t.id))
    .map((t) => t.id)
}
// Repeatedly removes one random exposed tile; draws one number per board tile.
function matchRemovalOrder(tiles: MatchTile[], rng: { value: number }) {
  const work = tiles.map((t) => ({ ...t }))
  const order: number[] = []
  for (;;) {
    const exposed = matchExposedIds(work)
    if (exposed.length === 0) return order
    const id = exposed[matchRandom(rng, exposed.length)]
    work[id].loc = MATCH_LOC_CLEARED
    order.push(id)
  }
}

// The returned order is the witness solution (never more than 2 tray tiles) and
// rng is the generator state after generation.
export function generateMatchLevel(levelSeed: number, level: number) {
  const rng = { value: levelSeed >>> 0 }
  const triples = Math.min(5 + level, 20)
  const n = 3 * triples
  const layers = Math.min(2 + Math.floor(level / 3), 5)
  const types = Math.min(4 + Math.floor(level / 2), MATCH_MAX_TYPES)

  // Even layers use an 8x6 grid, odd layers a 7x5 grid offset by one.
  const tiles: MatchTile[] = []
  for (let z = 0; z < layers; z++) {
    const first = z % 2 === 1 ? 1 : 0
    const lastX = z % 2 === 1 ? 13 : 14
    const lastY = z % 2 === 1 ? 9 : 10
    const cells: MatchTile[] = []
    for (let y = first; y <= lastY; y += 2) {
      for (let x = first; x <= lastX; x += 2) {
        cells.push({ id: 0, x, y, z, type: 0, loc: MATCH_LOC_BOARD, seq: 0 })
      }
    }
    matchShuffle(rng, cells)
    const quota = Math.floor(n / layers) + (z === 0 ? n % layers : 0)
    const chosen = cells.slice(0, quota)
    chosen.sort((a, b) => a.y - b.y || a.x - b.x)
    tiles.push(...chosen)
  }
  tiles.forEach((t, i) => {
    t.id = i
  })

  const order = matchRemovalOrder(tiles, rng)
  const typeList = Array.from({ length: triples }, (_, j) => j % types)
  matchShuffle(rng, typeList)
  order.forEach((id, k) => {
    tiles[id].type = typeList[Math.floor(k / 3)]
  })
  return { tiles, order, rng: rng.value }
}

function loadLevel(s: MatchState) {
  const level = generateMatchLevel(matchLevelSeed(s.seed, s.level), s.level)
  s.tiles = level.tiles
  s.rng = level.rng
  s.tray = []
  s.hint = []
}

// Endless starts at level 1 with a cap of 30; daily is the fixed run of levels 5..7.
export function newMatch(seed: number, mode: number, unlocks: number) {
  const s: MatchState = {
    version: MATCH_VERSION,
    mode,
    seed: seed >>> 0,
    rng: 0,
    level: 1,
    level_cap: ENDLESS_LEVEL_CAP,
    clock: 0,
    last_clear: 0,
    last_act: -1000,
    combo: 0,
    best_combo: 0,
    energy: MATCH_START_ENERGY,
    score: 0,
    cleared: 0,
    unlocks,
    inputs: 0,
    picks: 0,
    undos: 0,
    reveals: 0,
    shuffles: 0,
    rejected: 0,
    next_seq: 0,
    status: MATCH_PLAYING,
    tiles: [],
    tray: [],
    hint: [],
  }
  if (mode === MATCH_MODE_DAILY) {
    s.level = DAILY_FIRST_LEVEL
    s.level_cap = DAILY_LEVEL_CAP
  }
  loadLevel(s)
  return s
}
export function isMatchDone(s: MatchState) {
  return s.status !== MATCH_PLAYING
}
// The pickable tile ids in ascending order.
export function matchExposed(s: MatchState) {
  return matchExposedIds(s.tiles)
}

// spend pays for a skill when it is unlocked and affordable.
function spend(s: MatchState, unlockBit: number, cost: number) {
  if ((s.unlocks & unlockBit) === 0 || s.energy < cost) return false
  s.energy -= cost
  return true
}

function pick(s: MatchState, id: number) {
  if (
    id >= s.tiles.length ||
    s.tiles[id].loc !== MATCH_LOC_BOARD ||
    matchCovered(s.tiles, id)
  ) {
    return false
  }
  s.hint = []
  const tile = s.tiles[id]
  tile.loc = MATCH_LOC_TRAY
  tile.seq = s.next_seq
  s.next_seq++
  s.picks++

  // Keep equal types adjacent: insert after the last tray tile of the type.
  let at = s.tray.length
  let same = 0
  s.tray.forEach((trayId, i) => {
    if (s.tiles[trayId].type === tile.type) {
      at = i + 1
      same++
    }
  })
  s.tray.splice(at, 0, id)

  if (same === 2) {
    for (const trayId of s.tray) {
      if (s.tiles[trayId].type === tile.type) {
        s.tiles[trayId].loc = MATCH_LOC_CLEARED
      }
    }
    s.tray = s.tray.filter(
      (trayId) => s.tiles[trayId].loc !== MATCH_LOC_CLEARED
    )
    if (s.combo > 0 && s.clock - s.last_clear <= MATCH_COMBO_WINDOW_TICKS) {
      s.combo++
    } else {
      s.combo = 1
    }
    s.last_clear = s.clock
    s.best_combo = Math.max(s.best_combo, s.combo)
    s.score += 100 * Math.min(s.combo, 5)
    s.cleared++
    const bonus = s.combo >= 3 ? 1 : 0
    s.energy = Math.min(MATCH_ENERGY_CAP, s.energy + 1 + bonus)
  }

  // A 7th tile that completes a triple has already left the tray above.
  if (s.tray.length >= MATCH_TRAY_CAP) {
    s.status = MATCH_LOST
    return true
  }
  if (s.tiles.some((t) => t.loc === MATCH_LOC_BOARD)) return true
  s.score += 100 * s.level
  if (s.level >= s.level_cap) {
    s.status = MATCH_COMPLETED
    return true
  }
  s.level++
  loadLevel(s)
  return true
}

// Hint is up to 3 exposed ids chosen without randomness: the lowest exposed id
// of each tray type in tray order, otherwise the lowest ids of the type with
// the most exposed tiles (ties to the lowest type id).
function reveal(s: MatchState) {
  if (!spend(s, MATCH_UNLOCK_REVEAL, MATCH_COST_REVEAL)) return false
  s.reveals++
  const exposed = matchExposedIds(s.tiles)
  const hint: number[] = []
  const seen: boolean[] = Array<boolean>(MATCH_MAX_TYPES).fill(false)
  for (const trayId of s.tray) {
    const type = s.tiles[trayId].type
    if (seen[type] || hint.length === 3) continue
    seen[type] = true
    const id = exposed.find((e) => s.tiles[e].type === type)
    if (id !== undefined) hint.push(id)
  }
  if (hint.length === 0) {
    const counts: number[] = Array<number>(MATCH_MAX_TYPES).fill(0)
    let best = 0
    for (const id of exposed) {
      const type = s.tiles[id].type
      counts[type]++
      if (
        counts[type] > counts[best] ||
        (counts[type] === counts[best] && type < best)
      ) {
        best = type
      }
    }
    for (const id of exposed) {
      if (s.tiles[id].type === best && hint.length < 3) hint.push(id)
    }
  }
  s.hint = hint
  return true
}

// Returns the most recently picked tray tile to its original board slot.
// Cleared tiles cannot be undone. Hint is deliberately left as is.
function undo(s: MatchState) {
  if (s.tray.length === 0 || !spend(s, MATCH_UNLOCK_UNDO, MATCH_COST_UNDO)) {
    return false
  }
  let last = 0
  s.tray.forEach((trayId, i) => {
    if (s.tiles[trayId].seq > s.tiles[s.tray[last]].seq) last = i
  })
  s.tiles[s.tray[last]].loc = MATCH_LOC_BOARD
  s.tray.splice(last, 1)
  s.undos++
  return true
}

// Redeals the types of the board tiles and returns the new solution order
// (board ids). Types are assigned along a fresh removal order: first the copies
// that finish the pairs and singles already in the tray, then random whole
// triples. Solvable whenever the tray allows a completion (len <= 5, or it
// holds a pair and len <= 6); the cost is spent even if the tray is dead.
export function shuffleMatchBoard(s: MatchState) {
  const rng = { value: s.rng }
  const order = matchRemovalOrder(s.tiles, rng)
  const trayTypes: number[] = []
  const trayCount: number[] = Array<number>(MATCH_MAX_TYPES).fill(0)
  for (const trayId of s.tray) {
    const type = s.tiles[trayId].type
    if (trayCount[type] === 0) trayTypes.push(type)
    trayCount[type]++
  }
  const boardCount: number[] = Array<number>(MATCH_MAX_TYPES).fill(0)
  for (const t of s.tiles) {
    if (t.loc === MATCH_LOC_BOARD) boardCount[t.type]++
  }
  const sequence: number[] = []
  for (const type of trayTypes) {
    if (trayCount[type] === 2) {
      sequence.push(type)
      boardCount[type]--
    }
  }
  for (const type of trayTypes) {
    if (trayCount[type] === 1) {
      sequence.push(type, type)
      boardCount[type] -= 2
    }
  }
  const triples: number[] = []
  for (let type = 0; type < MATCH_MAX_TYPES; type++) {
    for (let i = 0; i < Math.trunc(boardCount[type] / 3); i++) {
      triples.push(type)
    }
  }
  matchShuffle(rng, triples)
  for (const type of triples) sequence.push(type, type, type)
  order.forEach((id, k) => {
    s.tiles[id].type = sequence[k]
  })
  s.rng = rng.value
  s.hint = []
  return order
}

function shuffle(s: MatchState) {
  if (!spend(s, MATCH_UNLOCK_SHUFFLE, MATCH_COST_SHUFFLE)) return false
  s.shuffles++
  shuffleMatchBoard(s)
  return true
}

// Consumes one input word and mutates s. Returns false, leaving the state
// untouched, when the run is already over or the word is malformed. Otherwise
// the input is consumed (inputs advances, the clock moves by dt) and it returns
// true even when the action itself is illegal; an illegal action is a
// deterministic no-op that only counts in rejected.
export function applyMatch(s: MatchState, input: number) {
  if (isMatchDone(s) || !validMatchInput(input)) return false
  const { op, arg, dt } = decodeMatchInput(input)
  s.inputs++
  s.clock += dt
  if (op === MATCH_OP_WAIT) return true
  let ok = s.clock - s.last_act >= MATCH_MIN_GAP_TICKS
  if (ok) {
    if (op === MATCH_OP_PICK) ok = pick(s, arg)
    else if (op === MATCH_OP_REVEAL) ok = reveal(s)
    else if (op === MATCH_OP_UNDO) ok = undo(s)
    else ok = shuffle(s)
  }
  if (!ok) {
    s.rejected++
    return true
  }
  s.last_act = s.clock
  return true
}
