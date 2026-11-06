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
import { HugeiconsIcon } from '@hugeicons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import {
  matchExposed,
  MATCH_LOC_BOARD,
  type MatchState,
  type MatchTile,
} from './engine'
import { MATCH_TILE_THEMES } from './theme'

export function TileFace(props: { type: number; className?: string }) {
  const theme = MATCH_TILE_THEMES[props.type] ?? MATCH_TILE_THEMES[0]
  return (
    <HugeiconsIcon
      icon={theme.icon}
      strokeWidth={1.8}
      aria-hidden='true'
      className={cn('size-3/5', theme.className, props.className)}
    />
  )
}

type Direction = 'left' | 'right' | 'up' | 'down' | 'any'
const ARROW_DIRECTIONS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

// The spatially closest candidate: the one ahead of from in the direction
// with the smallest detour, ties going to the higher layer, then the lower id.
// 'any' ignores the direction and is used to pick where focus lands after a
// tile has left the board.
function nearestTile(
  candidates: MatchTile[],
  from: MatchTile,
  direction: Direction
): number | null {
  let best: MatchTile | null = null
  let bestCost = Infinity
  for (const tile of candidates) {
    if (tile.id === from.id) continue
    const dx = tile.x - from.x
    const dy = tile.y - from.y
    let ahead = Math.abs(dx) + Math.abs(dy)
    let aside = 0
    if (direction === 'left') [ahead, aside] = [-dx, Math.abs(dy)]
    if (direction === 'right') [ahead, aside] = [dx, Math.abs(dy)]
    if (direction === 'up') [ahead, aside] = [-dy, Math.abs(dx)]
    if (direction === 'down') [ahead, aside] = [dy, Math.abs(dx)]
    if (ahead <= 0) continue
    const cost = ahead + 2 * aside
    if (
      cost < bestCost ||
      (cost === bestCost && best !== null && tile.z > best.z)
    ) {
      best = tile
      bestCost = cost
    }
  }
  return best ? best.id : null
}

// The stack of tiles. Every board tile is a real button; a covered one stays
// in the accessibility tree with aria-disabled, but only uncovered tiles take
// part in the roving tabindex and in arrow-key navigation.
export function Match3Board(props: {
  state: MatchState
  onPick: (id: number) => boolean
}) {
  const { t } = useTranslation()
  const board = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<number, HTMLButtonElement>())
  const refocus = useRef(false)
  const [focusId, setFocusId] = useState<number | null>(null)
  const exposed = useMemo(() => matchExposed(props.state), [props.state])
  const exposedTiles = exposed.map((id) => props.state.tiles[id])
  const tiles = props.state.tiles.filter((tile) => tile.loc === MATCH_LOC_BOARD)
  let activeId: number | null = exposed[0] ?? null
  if (focusId !== null && exposed.includes(focusId)) activeId = focusId

  // A picked tile takes its button with it, so keyboard focus is handed to a
  // neighbour once the new state has rendered.
  const activeRef = useRef(activeId)
  activeRef.current = activeId
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    if (activeRef.current !== null) {
      buttons.current.get(activeRef.current)?.focus()
    }
  }, [props.state])

  const pick = (tile: MatchTile) => {
    if (!exposed.includes(tile.id)) return
    const onBoard = board.current?.contains(document.activeElement) ?? false
    const next = nearestTile(exposedTiles, tile, 'any')
    if (!props.onPick(tile.id)) return
    refocus.current = onBoard
    setFocusId(next)
  }

  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const direction = ARROW_DIRECTIONS[event.key]
    if (!direction || event.altKey || event.ctrlKey || event.metaKey) return
    const id = Number((event.target as HTMLElement).dataset.tileId)
    const from = props.state.tiles[id]
    if (!from) return
    event.preventDefault()
    const next = nearestTile(exposedTiles, from, direction)
    if (next === null) return
    setFocusId(next)
    buttons.current.get(next)?.focus()
  }

  return (
    <div
      ref={board}
      role='group'
      aria-label={t('Tile board')}
      className='match3-board'
      onKeyDown={move}
    >
      {tiles.map((tile) => {
        const covered = !exposed.includes(tile.id)
        const type = t(MATCH_TILE_THEMES[tile.type]?.label ?? 'Token')
        let label = t('{{type}} tile, available', { type })
        if (covered) label = t('{{type}} tile, covered', { type })
        else if (props.state.hint.includes(tile.id)) {
          label = t('{{type}} tile, available, suggested', { type })
        }
        return (
          <button
            key={tile.id}
            ref={(element) => {
              if (element) buttons.current.set(tile.id, element)
              else buttons.current.delete(tile.id)
            }}
            type='button'
            className='match3-tile'
            data-tile-id={tile.id}
            data-hint={props.state.hint.includes(tile.id) ? 'true' : undefined}
            aria-disabled={covered || undefined}
            aria-label={label}
            tabIndex={tile.id === activeId ? 0 : -1}
            style={
              {
                '--m3-x': tile.x,
                '--m3-y': tile.y,
                '--m3-z': tile.z,
              } as React.CSSProperties
            }
            onClick={() => pick(tile)}
          >
            <TileFace type={tile.type} />
          </button>
        )
      })}
    </div>
  )
}
