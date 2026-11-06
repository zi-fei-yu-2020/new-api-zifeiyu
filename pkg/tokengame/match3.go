package tokengame

import (
	"cmp"
	"slices"
)

// The stacked-tile (match three, 7 slot tray) engine. It is deterministic and
// integer only: the server replays seed + inputs to derive every score, and
// the web engine in web/src/features/game-center/match3/engine.ts must give
// bit-identical states. Parity traps for the port:
//   - every uint32 result needs Math.imul / >>>0 on the TypeScript side;
//   - slices that are empty stay empty (never nil) so JSON carries [] not null;
//   - iterate arrays in id order only and sort only by the total (z, y, x) order;
//   - consume exactly the same number of random draws per step.
//
// Any rule or constant change after release needs a new MatchVersion; the
// shared fixtures in testdata/match3-*.json pin version 1.

const MatchVersion = 1
const MatchTrayCap = 7

// MatchComboWindowTicks is inclusive: a clear within 50 ticks of the previous
// one continues the combo, 51 ticks breaks it. The clock is the sum of the
// claimed input deltas, never a wall clock.
const MatchComboWindowTicks = 50

// MatchMinGapTicks is the smallest clock distance between two accepted
// non-wait actions (200ms).
const MatchMinGapTicks = 2
const MatchMaxInputs = 3000
const MatchEnergyCap = 6
const MatchStartEnergy = 2
const MatchMaxTypes = 10
const MatchMaxArg = 127
const MatchMaxDelta = 255

const MatchCostReveal = 1
const MatchCostUndo = 2
const MatchCostShuffle = 3

const MatchUnlockReveal = 1
const MatchUnlockUndo = 2
const MatchUnlockShuffle = 4

const MatchModeEndless = 0
const MatchModeDaily = 1

const MatchPlaying = 0
const MatchCompleted = 1
const MatchLost = 2

const MatchLocBoard = 0
const MatchLocTray = 1
const MatchLocCleared = 2

// Input = op | arg<<3 | dt<<10. Ops 5..7 are invalid.
const MatchOpWait = 0
const MatchOpPick = 1
const MatchOpReveal = 2
const MatchOpUndo = 3
const MatchOpShuffle = 4

const matchEndlessLevelCap = 30
const matchDailyFirstLevel = 5
const matchDailyLevelCap = 7

type MatchTile struct {
	ID   int `json:"id"`
	X    int `json:"x"`
	Y    int `json:"y"`
	Z    int `json:"z"`
	Type int `json:"type"`
	Loc  int `json:"loc"`
	Seq  int `json:"seq"`
}

type MatchState struct {
	Version   int         `json:"version"`
	Mode      int         `json:"mode"`
	Seed      uint32      `json:"seed"`
	RNG       uint32      `json:"rng"`
	Level     int         `json:"level"`
	LevelCap  int         `json:"level_cap"`
	Clock     int         `json:"clock"`
	LastClear int         `json:"last_clear"`
	LastAct   int         `json:"last_act"`
	Combo     int         `json:"combo"`
	BestCombo int         `json:"best_combo"`
	Energy    int         `json:"energy"`
	Score     int         `json:"score"`
	Cleared   int         `json:"cleared"`
	Unlocks   int         `json:"unlocks"`
	Inputs    int         `json:"inputs"`
	Picks     int         `json:"picks"`
	Undos     int         `json:"undos"`
	Reveals   int         `json:"reveals"`
	Shuffles  int         `json:"shuffles"`
	Rejected  int         `json:"rejected"`
	NextSeq   int         `json:"next_seq"`
	Status    int         `json:"status"`
	Tiles     []MatchTile `json:"tiles"`
	Tray      []int       `json:"tray"`
	Hint      []int       `json:"hint"`
}

// ValidMatchInput reports whether input is a well formed action word.
func ValidMatchInput(input int) bool {
	return input >= 0 && input < 1<<18 && input&7 <= MatchOpShuffle
}

// MatchLevelSeed derives the board seed of one level (uint32 wraparound).
func MatchLevelSeed(seed uint32, level int) uint32 {
	return seed + uint32(level)*0x9E3779B9
}

// matchRandom advances the LCG and scales its high bits into [0, n).
func matchRandom(rng *uint32, n int) int {
	*rng = *rng*1664525 + 1013904223
	return int(uint64(*rng) * uint64(n) >> 32)
}

// matchShuffle is a Fisher-Yates shuffle that draws for i from len-1 down to 1.
func matchShuffle[T any](rng *uint32, items []T) {
	for i := len(items) - 1; i >= 1; i-- {
		j := matchRandom(rng, i+1)
		items[i], items[j] = items[j], items[i]
	}
}

// matchCovered reports whether a board tile lies under another board tile:
// a higher layer within one cell on both axes.
func matchCovered(tiles []MatchTile, id int) bool {
	t := tiles[id]
	for _, u := range tiles {
		if u.Loc == MatchLocBoard && u.Z > t.Z && u.X-t.X < 2 && t.X-u.X < 2 && u.Y-t.Y < 2 && t.Y-u.Y < 2 {
			return true
		}
	}
	return false
}

// matchExposedIDs lists the uncovered board tiles in ascending id order.
func matchExposedIDs(tiles []MatchTile) []int {
	ids := []int{}
	for _, t := range tiles {
		if t.Loc == MatchLocBoard && !matchCovered(tiles, t.ID) {
			ids = append(ids, t.ID)
		}
	}
	return ids
}

// matchRemovalOrder builds a solution order over the board tiles: repeatedly
// remove one random exposed tile. Following it picks tiles layer by layer so
// every tile is exposed when its turn comes, which makes boards solvable by
// construction. It draws exactly one random number per board tile.
func matchRemovalOrder(tiles []MatchTile, rng *uint32) []int {
	work := slices.Clone(tiles)
	order := []int{}
	for {
		exposed := matchExposedIDs(work)
		if len(exposed) == 0 {
			return order
		}
		id := exposed[matchRandom(rng, len(exposed))]
		work[id].Loc = MatchLocCleared
		order = append(order, id)
	}
}

// generateMatchLevel builds a level board from its seed. The returned order is
// the witness solution (a pick order that never holds more than 2 tray tiles)
// and rng is the generator state after generation.
func generateMatchLevel(levelSeed uint32, level int) (tiles []MatchTile, order []int, rng uint32) {
	rng = levelSeed
	triples := min(5+level, 20)
	n := 3 * triples
	layers := min(2+level/3, 5)
	types := min(4+level/2, MatchMaxTypes)

	// Pick the cells of each layer: even layers use an 8x6 grid, odd layers a
	// 7x5 grid offset by one so tiles overlap their neighbours below.
	tiles = []MatchTile{}
	for z := range layers {
		first, lastX, lastY := 0, 14, 10
		if z%2 == 1 {
			first, lastX, lastY = 1, 13, 9
		}
		cells := []MatchTile{}
		for y := first; y <= lastY; y += 2 {
			for x := first; x <= lastX; x += 2 {
				cells = append(cells, MatchTile{X: x, Y: y, Z: z})
			}
		}
		matchShuffle(&rng, cells)
		quota := n / layers
		if z == 0 {
			quota += n % layers
		}
		chosen := cells[:quota]
		slices.SortFunc(chosen, func(a, b MatchTile) int {
			return cmp.Or(cmp.Compare(a.Y, b.Y), cmp.Compare(a.X, b.X))
		})
		tiles = append(tiles, chosen...)
	}
	for i := range tiles {
		tiles[i].ID = i
	}

	order = matchRemovalOrder(tiles, &rng)
	typeList := make([]int, triples)
	for j := range typeList {
		typeList[j] = j % types
	}
	matchShuffle(&rng, typeList)
	for k, id := range order {
		tiles[id].Type = typeList[k/3]
	}
	return tiles, order, rng
}

// NewMatch starts a run. Endless starts at level 1 with a cap of 30; daily is
// the fixed three level run 5..7. unlocks is a bit set of the usable skills.
func NewMatch(seed uint32, mode, unlocks int) MatchState {
	s := MatchState{
		Version: MatchVersion, Mode: mode, Seed: seed,
		Level: 1, LevelCap: matchEndlessLevelCap,
		LastAct: -1000, Energy: MatchStartEnergy, Unlocks: unlocks,
		Tray: []int{}, Hint: []int{},
	}
	if mode == MatchModeDaily {
		s.Level, s.LevelCap = matchDailyFirstLevel, matchDailyLevelCap
	}
	s.loadLevel()
	return s
}

// loadLevel replaces the board with the current level's and empties the tray.
func (s *MatchState) loadLevel() {
	s.Tiles, _, s.RNG = generateMatchLevel(MatchLevelSeed(s.Seed, s.Level), s.Level)
	s.Tray = s.Tray[:0]
	s.Hint = s.Hint[:0]
}

func (s *MatchState) Done() bool {
	return s.Status != MatchPlaying
}

// Exposed lists the pickable tile ids in ascending order.
func (s *MatchState) Exposed() []int {
	return matchExposedIDs(s.Tiles)
}

// Apply consumes one input word. It returns false, leaving the state
// untouched, when the run is already over or the word is malformed. Otherwise
// the input is consumed (Inputs advances, the clock moves by dt) and returns
// true even when the action itself is illegal; an illegal action is a
// deterministic no-op that only counts in Rejected.
func (s *MatchState) Apply(input int) bool {
	if s.Done() || !ValidMatchInput(input) {
		return false
	}
	op, arg, dt := input&7, input>>3&MatchMaxArg, input>>10
	s.Inputs++
	s.Clock += dt
	if op == MatchOpWait {
		return true
	}
	ok := s.Clock-s.LastAct >= MatchMinGapTicks
	if ok {
		switch op {
		case MatchOpPick:
			ok = s.pick(arg)
		case MatchOpReveal:
			ok = s.reveal()
		case MatchOpUndo:
			ok = s.undo()
		default:
			ok = s.shuffle()
		}
	}
	if !ok {
		s.Rejected++
		return true
	}
	s.LastAct = s.Clock
	return true
}

// spend pays for a skill when it is unlocked and affordable.
func (s *MatchState) spend(unlockBit, cost int) bool {
	if s.Unlocks&unlockBit == 0 || s.Energy < cost {
		return false
	}
	s.Energy -= cost
	return true
}

func (s *MatchState) pick(id int) bool {
	if id >= len(s.Tiles) || s.Tiles[id].Loc != MatchLocBoard || matchCovered(s.Tiles, id) {
		return false
	}
	s.Hint = s.Hint[:0]
	tile := &s.Tiles[id]
	tile.Loc = MatchLocTray
	tile.Seq = s.NextSeq
	s.NextSeq++
	s.Picks++

	// Keep equal types adjacent: insert after the last tray tile of the type.
	at, same := len(s.Tray), 0
	for i, trayID := range s.Tray {
		if s.Tiles[trayID].Type == tile.Type {
			at = i + 1
			same++
		}
	}
	s.Tray = slices.Insert(s.Tray, at, id)

	if same == 2 {
		for _, trayID := range s.Tray {
			if s.Tiles[trayID].Type == tile.Type {
				s.Tiles[trayID].Loc = MatchLocCleared
			}
		}
		s.Tray = slices.DeleteFunc(s.Tray, func(trayID int) bool { return s.Tiles[trayID].Loc == MatchLocCleared })
		if s.Combo > 0 && s.Clock-s.LastClear <= MatchComboWindowTicks {
			s.Combo++
		} else {
			s.Combo = 1
		}
		s.LastClear = s.Clock
		s.BestCombo = max(s.BestCombo, s.Combo)
		s.Score += 100 * min(s.Combo, 5)
		s.Cleared++
		bonus := 0
		if s.Combo >= 3 {
			bonus = 1
		}
		s.Energy = min(MatchEnergyCap, s.Energy+1+bonus)
	}

	// A 7th tile that completes a triple has already left the tray above.
	if len(s.Tray) >= MatchTrayCap {
		s.Status = MatchLost
		return true
	}
	for _, t := range s.Tiles {
		if t.Loc == MatchLocBoard {
			return true
		}
	}
	s.Score += 100 * s.Level
	if s.Level >= s.LevelCap {
		s.Status = MatchCompleted
		return true
	}
	s.Level++
	s.loadLevel()
	return true
}

// reveal sets Hint to up to 3 exposed ids, chosen without randomness: the
// lowest exposed id of each tray type in tray order, otherwise the lowest ids
// of the type with the most exposed tiles (ties to the lowest type id).
func (s *MatchState) reveal() bool {
	if !s.spend(MatchUnlockReveal, MatchCostReveal) {
		return false
	}
	s.Reveals++
	exposed := matchExposedIDs(s.Tiles)
	hint := []int{}
	seen := [MatchMaxTypes]bool{}
	for _, trayID := range s.Tray {
		typ := s.Tiles[trayID].Type
		if seen[typ] || len(hint) == 3 {
			continue
		}
		seen[typ] = true
		for _, id := range exposed {
			if s.Tiles[id].Type == typ {
				hint = append(hint, id)
				break
			}
		}
	}
	if len(hint) == 0 {
		counts := [MatchMaxTypes]int{}
		best := 0
		for _, id := range exposed {
			typ := s.Tiles[id].Type
			counts[typ]++
			if counts[typ] > counts[best] || (counts[typ] == counts[best] && typ < best) {
				best = typ
			}
		}
		for _, id := range exposed {
			if s.Tiles[id].Type == best && len(hint) < 3 {
				hint = append(hint, id)
			}
		}
	}
	s.Hint = hint
	return true
}

// undo returns the most recently picked tray tile to its original board slot.
// Cleared tiles cannot be undone. Hint is deliberately left as is.
func (s *MatchState) undo() bool {
	if len(s.Tray) == 0 || !s.spend(MatchUnlockUndo, MatchCostUndo) {
		return false
	}
	last := 0
	for i, trayID := range s.Tray {
		if s.Tiles[trayID].Seq > s.Tiles[s.Tray[last]].Seq {
			last = i
		}
	}
	s.Tiles[s.Tray[last]].Loc = MatchLocBoard
	s.Tray = slices.Delete(s.Tray, last, last+1)
	s.Undos++
	return true
}

func (s *MatchState) shuffle() bool {
	if !s.spend(MatchUnlockShuffle, MatchCostShuffle) {
		return false
	}
	s.Shuffles++
	s.shuffleBoard()
	return true
}

// shuffleBoard redeals the types of the board tiles and returns the new
// solution order (board ids). It builds a fresh removal order over the board
// and assigns types along it: first the copies that finish the pairs and
// singles already in the tray, then random whole triples. The result is
// solvable whenever the tray allows a completion (len <= 5, or it holds a pair
// and len <= 6). The cost is spent even if the tray is dead.
func (s *MatchState) shuffleBoard() []int {
	order := matchRemovalOrder(s.Tiles, &s.RNG)
	trayTypes := []int{}
	trayCount := [MatchMaxTypes]int{}
	for _, trayID := range s.Tray {
		typ := s.Tiles[trayID].Type
		if trayCount[typ] == 0 {
			trayTypes = append(trayTypes, typ)
		}
		trayCount[typ]++
	}
	boardCount := [MatchMaxTypes]int{}
	for _, t := range s.Tiles {
		if t.Loc == MatchLocBoard {
			boardCount[t.Type]++
		}
	}
	sequence := make([]int, 0, len(order))
	for _, typ := range trayTypes {
		if trayCount[typ] == 2 {
			sequence = append(sequence, typ)
			boardCount[typ]--
		}
	}
	for _, typ := range trayTypes {
		if trayCount[typ] == 1 {
			sequence = append(sequence, typ, typ)
			boardCount[typ] -= 2
		}
	}
	triples := []int{}
	for typ := range MatchMaxTypes {
		for range boardCount[typ] / 3 {
			triples = append(triples, typ)
		}
	}
	matchShuffle(&s.RNG, triples)
	for _, typ := range triples {
		sequence = append(sequence, typ, typ, typ)
	}
	for k, id := range order {
		s.Tiles[id].Type = sequence[k]
	}
	s.Hint = s.Hint[:0]
	return order
}
