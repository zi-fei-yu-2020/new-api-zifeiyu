package tokengame

import (
	"os"
	"slices"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type matchBoardFixture struct {
	Seed  uint32      `json:"seed"`
	Level int         `json:"level"`
	Tiles []MatchTile `json:"tiles"`
}

type matchReplayFixture struct {
	Seed    uint32     `json:"seed"`
	Mode    int        `json:"mode"`
	Unlocks int        `json:"unlocks"`
	Inputs  []int      `json:"inputs"`
	State   MatchState `json:"state"`
}

func matchInput(op, arg, dt int) int {
	return op | arg<<3 | dt<<10
}

func cloneMatchState(s MatchState) MatchState {
	s.Tiles = slices.Clone(s.Tiles)
	s.Tray = slices.Clone(s.Tray)
	s.Hint = slices.Clone(s.Hint)
	return s
}

// matchScript records every input fed to a state, so a scenario doubles as a
// replay fixture.
type matchScript struct {
	seed    uint32
	mode    int
	unlocks int
	state   MatchState
	inputs  []int
}

func newMatchScript(seed uint32, mode, unlocks int) *matchScript {
	return &matchScript{seed: seed, mode: mode, unlocks: unlocks, state: NewMatch(seed, mode, unlocks)}
}

func (m *matchScript) do(t *testing.T, op, arg, dt int) {
	t.Helper()
	input := matchInput(op, arg, dt)
	require.True(t, m.state.Apply(input))
	m.inputs = append(m.inputs, input)
}

func (m *matchScript) fixture() matchReplayFixture {
	return matchReplayFixture{Seed: m.seed, Mode: m.mode, Unlocks: m.unlocks, Inputs: m.inputs, State: cloneMatchState(m.state)}
}

func matchWitnessOrder(s MatchState) []int {
	_, order, _ := generateMatchLevel(MatchLevelSeed(s.Seed, s.Level), s.Level)
	return order
}

// playLevel follows the generator order until the level changes or the run
// ends. With skills it also casts reveal, undo and shuffle once each and
// continues along the shuffled solution order.
func (m *matchScript) playLevel(t *testing.T, dt int, skills bool) {
	t.Helper()
	level := m.state.Level
	order := matchWitnessOrder(m.state)
	revealed, undone, shuffled := false, false, false
	for k := 0; k < len(order) && m.state.Level == level && !m.state.Done(); {
		switch {
		case skills && k == 6 && !revealed:
			revealed = true
			m.do(t, MatchOpReveal, 0, dt)
		case skills && k == 7 && !undone:
			undone = true
			m.do(t, MatchOpPick, order[k], dt)
			m.do(t, MatchOpUndo, 0, dt)
		case skills && k == 13 && !shuffled:
			shuffled = true
			probe := cloneMatchState(m.state)
			order, k = probe.shuffleBoard(), 0
			m.do(t, MatchOpShuffle, 0, dt)
			require.Equal(t, probe.Tiles, m.state.Tiles)
		default:
			m.do(t, MatchOpPick, order[k], dt)
			k++
		}
	}
}

func (m *matchScript) playRun(t *testing.T, dt int) {
	t.Helper()
	for !m.state.Done() {
		m.playLevel(t, dt, false)
	}
}

// fillTrayWithDistinctTypes picks exposed tiles of 7 different types.
func (m *matchScript) fillTrayWithDistinctTypes(t *testing.T) {
	t.Helper()
	for !m.state.Done() {
		picked := false
		for _, id := range m.state.Exposed() {
			inTray := slices.ContainsFunc(m.state.Tray, func(trayID int) bool {
				return m.state.Tiles[trayID].Type == m.state.Tiles[id].Type
			})
			if !inTray {
				m.do(t, MatchOpPick, id, 2)
				picked = true
				break
			}
		}
		require.True(t, picked, "no exposed tile of a new type")
	}
}

// playComboPair clears two triples of the first level with the given clock gap
// between the first clear and the second.
func (m *matchScript) playComboPair(t *testing.T, gap int) {
	t.Helper()
	order := matchWitnessOrder(m.state)
	for k := range 3 {
		m.do(t, MatchOpPick, order[k], 2)
	}
	m.do(t, MatchOpPick, order[3], 2)
	m.do(t, MatchOpPick, order[4], 2)
	m.do(t, MatchOpPick, order[5], gap-4)
}

func matchFixtureScripts(t *testing.T) []*matchScript {
	t.Helper()
	var scripts []*matchScript

	daily := newMatchScript(20260601, MatchModeDaily, 7)
	daily.playRun(t, 2)
	scripts = append(scripts, daily)

	wrap := newMatchScript(4294967295, MatchModeDaily, 0)
	wrap.playRun(t, 3)
	scripts = append(scripts, wrap)

	for _, gap := range []int{50, 51} {
		combo := newMatchScript(11, MatchModeEndless, 0)
		combo.playComboPair(t, gap)
		scripts = append(scripts, combo)
	}

	mixed := newMatchScript(7, MatchModeEndless, 7)
	for range 3 {
		mixed.playLevel(t, 2, mixed.state.Level == 1)
	}
	scripts = append(scripts, mixed)

	lost := newMatchScript(99, MatchModeEndless, 0)
	for lost.state.Level < 10 {
		lost.playLevel(t, 2, false)
	}
	lost.fillTrayWithDistinctTypes(t)
	scripts = append(scripts, lost)

	rejected := newMatchScript(5, MatchModeEndless, MatchUnlockReveal)
	rejected.do(t, MatchOpUndo, 0, 0)                                    // empty tray
	rejected.do(t, MatchOpShuffle, 0, 5)                                 // locked
	rejected.do(t, MatchOpPick, 127, 5)                                  // no such tile
	rejected.do(t, MatchOpPick, matchWitnessOrder(rejected.state)[0], 0) // accepted: no action yet
	rejected.do(t, MatchOpPick, matchWitnessOrder(rejected.state)[1], 1) // rejected: gap under 2
	rejected.do(t, MatchOpWait, 0, 200)
	scripts = append(scripts, rejected)

	full := newMatchScript(2026, MatchModeEndless, 0)
	full.playRun(t, 2)
	scripts = append(scripts, full)

	return scripts
}

func matchFixtureBoards() []matchBoardFixture {
	cases := []struct {
		seed  uint32
		level int
	}{{1, 1}, {12345, 5}, {2026, 12}, {0x9E3779B9, 20}, {777, 9}, {4294967295, 30}, {0, 3}}
	boards := make([]matchBoardFixture, 0, len(cases))
	for _, c := range cases {
		tiles, _, _ := generateMatchLevel(MatchLevelSeed(c.seed, c.level), c.level)
		boards = append(boards, matchBoardFixture{Seed: c.seed, Level: c.level, Tiles: tiles})
	}
	return boards
}

func TestMatch3BoardCompatibility(t *testing.T) {
	raw, err := os.ReadFile("testdata/match3-boards.json")
	require.NoError(t, err)
	var fixtures []matchBoardFixture
	require.NoError(t, common.Unmarshal(raw, &fixtures))
	require.GreaterOrEqual(t, len(fixtures), 3)
	assert.True(t, slices.ContainsFunc(fixtures, func(f matchBoardFixture) bool { return f.Seed == 4294967295 && f.Level == 30 }))
	for _, fixture := range fixtures {
		tiles, _, _ := generateMatchLevel(MatchLevelSeed(fixture.Seed, fixture.Level), fixture.Level)
		require.Equal(t, fixture.Tiles, tiles)
	}
}

func TestMatch3ReplayCompatibility(t *testing.T) {
	raw, err := os.ReadFile("testdata/match3-replays.json")
	require.NoError(t, err)
	var fixtures []matchReplayFixture
	require.NoError(t, common.Unmarshal(raw, &fixtures))
	require.GreaterOrEqual(t, len(fixtures), 3)
	for _, fixture := range fixtures {
		require.Equal(t, MatchVersion, fixture.State.Version)
		state := NewMatch(fixture.Seed, fixture.Mode, fixture.Unlocks)
		for _, input := range fixture.Inputs {
			require.True(t, state.Apply(input))
		}
		require.Equal(t, fixture.State, state)
	}
}

// Regenerate the fixtures: WRITE_MATCH3_FIXTURES=1 go test ./pkg/tokengame -run TestMatch3WriteFixtures
// The web engine tests replay the same files, so regenerate only for a new MatchVersion.
func TestMatch3WriteFixtures(t *testing.T) {
	if os.Getenv("WRITE_MATCH3_FIXTURES") == "" {
		t.Skip("set WRITE_MATCH3_FIXTURES=1 to regenerate match3-boards.json and match3-replays.json")
	}
	var replays []matchReplayFixture
	for _, script := range matchFixtureScripts(t) {
		replays = append(replays, script.fixture())
	}
	encoded, err := common.Marshal(matchFixtureBoards())
	require.NoError(t, err)
	require.NoError(t, os.WriteFile("testdata/match3-boards.json", encoded, 0o644))
	encoded, err = common.Marshal(replays)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile("testdata/match3-replays.json", encoded, 0o644))
}

func TestMatch3DailyWinFollowingGeneratorOrder(t *testing.T) {
	m := newMatchScript(20260601, MatchModeDaily, 0)
	assert.Equal(t, 5, m.state.Level)
	assert.Equal(t, 7, m.state.LevelCap)
	m.playRun(t, 2)
	s := m.state
	assert.Equal(t, MatchCompleted, s.Status)
	assert.Equal(t, 7, s.Level)
	assert.Equal(t, 33, s.Cleared)
	assert.Equal(t, 99, s.Picks)
	assert.Equal(t, 0, s.Rejected)
	assert.Equal(t, 33, s.BestCombo) // a clear every 6 ticks never breaks the combo
	assert.Empty(t, s.Tray)
	// 33 clears score 100*min(combo,5) with the combo growing 1..33 and capped at
	// 5 for scoring, plus 100*level for finishing levels 5, 6, 7.
	assert.Equal(t, 100*(1+2+3+4+5*29)+100*(5+6+7), s.Score)
}

func TestMatch3ComboWindowIsInclusive(t *testing.T) {
	for _, tc := range []struct {
		gap, combo, score int
	}{{50, 2, 300}, {51, 1, 200}} {
		m := newMatchScript(11, MatchModeEndless, 0)
		m.playComboPair(t, tc.gap)
		assert.Equal(t, tc.combo, m.state.Combo, "gap %d", tc.gap)
		assert.Equal(t, tc.score, m.state.Score, "gap %d", tc.gap)
		assert.Equal(t, 2, m.state.Cleared)
	}
}

func TestMatch3Skills(t *testing.T) {
	first := func(s MatchState) int { return matchWitnessOrder(s)[0] }

	t.Run("reveal hints exposed tiles of one type", func(t *testing.T) {
		m := newMatchScript(3, MatchModeEndless, 7)
		m.do(t, MatchOpReveal, 0, 0)
		s := m.state
		assert.Equal(t, 1, s.Energy)
		assert.Equal(t, 1, s.Reveals)
		require.NotEmpty(t, s.Hint)
		assert.LessOrEqual(t, len(s.Hint), 3)
		for _, id := range s.Hint {
			assert.Contains(t, s.Exposed(), id)
			assert.Equal(t, s.Tiles[s.Hint[0]].Type, s.Tiles[id].Type)
		}
		m.do(t, MatchOpPick, first(s), 2)
		assert.Empty(t, m.state.Hint, "a pick clears the hint")
	})

	t.Run("reveal prefers the tray type", func(t *testing.T) {
		m := newMatchScript(3, MatchModeEndless, 7)
		m.do(t, MatchOpPick, first(m.state), 0)
		trayType := m.state.Tiles[m.state.Tray[0]].Type
		m.do(t, MatchOpReveal, 0, 2)
		require.NotEmpty(t, m.state.Hint)
		assert.Equal(t, trayType, m.state.Tiles[m.state.Hint[0]].Type)
	})

	t.Run("undo returns the last pick to its slot", func(t *testing.T) {
		m := newMatchScript(3, MatchModeEndless, 7)
		order := matchWitnessOrder(m.state)
		before := m.state.Tiles[order[1]]
		m.do(t, MatchOpPick, order[0], 0)
		m.do(t, MatchOpPick, order[1], 2)
		m.do(t, MatchOpUndo, 0, 2)
		s := m.state
		assert.Equal(t, []int{order[0]}, s.Tray)
		assert.Equal(t, MatchLocBoard, s.Tiles[order[1]].Loc)
		assert.Equal(t, [3]int{before.X, before.Y, before.Z}, [3]int{s.Tiles[order[1]].X, s.Tiles[order[1]].Y, s.Tiles[order[1]].Z})
		assert.Contains(t, s.Exposed(), order[1])
		assert.Equal(t, 0, s.Energy)
		assert.Equal(t, 1, s.Undos)
	})

	t.Run("shuffle keeps tray and type totals", func(t *testing.T) {
		m := newMatchScript(3, MatchModeEndless, 7)
		m.state.Energy = MatchEnergyCap
		m.do(t, MatchOpPick, first(m.state), 0)
		tray := slices.Clone(m.state.Tray)
		count := func(s MatchState) [MatchMaxTypes]int {
			var c [MatchMaxTypes]int
			for _, tile := range s.Tiles {
				if tile.Loc != MatchLocCleared {
					c[tile.Type]++
				}
			}
			return c
		}
		before := count(m.state)
		m.do(t, MatchOpShuffle, 0, 2)
		assert.Equal(t, tray, m.state.Tray)
		assert.Equal(t, before, count(m.state))
		assert.Equal(t, MatchEnergyCap-MatchCostShuffle, m.state.Energy)
		assert.Equal(t, 1, m.state.Shuffles)
	})

	t.Run("locked and unaffordable skills are rejected", func(t *testing.T) {
		m := newMatchScript(3, MatchModeEndless, 0)
		m.do(t, MatchOpReveal, 0, 0)
		assert.Equal(t, 1, m.state.Rejected)
		assert.Equal(t, MatchStartEnergy, m.state.Energy)
		assert.Empty(t, m.state.Hint)

		poor := newMatchScript(3, MatchModeEndless, 7)
		poor.do(t, MatchOpPick, first(poor.state), 0)
		poor.do(t, MatchOpShuffle, 0, 2) // costs 3, holds 2
		poor.state.Energy = 1
		poor.do(t, MatchOpUndo, 0, 2) // costs 2
		assert.Equal(t, 2, poor.state.Rejected)
		assert.Equal(t, 1, poor.state.Energy)
		assert.Len(t, poor.state.Tray, 1)
		assert.Equal(t, 0, poor.state.Shuffles+poor.state.Undos)
	})

	t.Run("illegal picks and fast actions are no-ops", func(t *testing.T) {
		m := newMatchScript(3, MatchModeEndless, 7)
		order := matchWitnessOrder(m.state)
		covered := -1
		for _, tile := range m.state.Tiles {
			if matchCovered(m.state.Tiles, tile.ID) {
				covered = tile.ID
				break
			}
		}
		require.GreaterOrEqual(t, covered, 0)
		m.do(t, MatchOpPick, covered, 0)
		m.do(t, MatchOpPick, 127, 2)
		m.do(t, MatchOpPick, order[0], 0)
		m.do(t, MatchOpPick, order[1], 1) // only 1 tick after the last action
		assert.Equal(t, 3, m.state.Rejected)
		assert.Equal(t, []int{order[0]}, m.state.Tray)
		assert.Equal(t, 4, m.state.Inputs)
	})
}

func TestMatch3EndlessRunAdvancesLevels(t *testing.T) {
	m := newMatchScript(7, MatchModeEndless, 7)
	for range 3 {
		m.playLevel(t, 2, m.state.Level == 1)
	}
	s := m.state
	assert.Equal(t, MatchPlaying, s.Status)
	assert.Equal(t, 4, s.Level)
	assert.Equal(t, 0, s.Rejected)
	assert.Equal(t, [3]int{1, 1, 1}, [3]int{s.Reveals, s.Undos, s.Shuffles})
	assert.Empty(t, s.Tray)
	assert.Equal(t, 6+7+8, s.Cleared)
	assert.Len(t, s.Tiles, 27)

	full := newMatchScript(2026, MatchModeEndless, 0)
	full.playRun(t, 2)
	assert.Equal(t, MatchCompleted, full.state.Status)
	assert.Equal(t, 30, full.state.Level)
	assert.LessOrEqual(t, full.state.Inputs, MatchMaxInputs)
}

func TestMatch3LossWithSevenTrayTiles(t *testing.T) {
	m := newMatchScript(99, MatchModeEndless, 0)
	for m.state.Level < 10 {
		m.playLevel(t, 2, false)
	}
	m.fillTrayWithDistinctTypes(t)
	s := m.state
	assert.Equal(t, MatchLost, s.Status)
	assert.Len(t, s.Tray, MatchTrayCap)
	assert.Equal(t, 10, s.Level)
	types := map[int]bool{}
	for _, id := range s.Tray {
		types[s.Tiles[id].Type] = true
	}
	assert.Len(t, types, MatchTrayCap)
}

func TestMatch3InputAfterDoneLeavesStateUnchanged(t *testing.T) {
	m := newMatchScript(20260601, MatchModeDaily, 7)
	m.playRun(t, 2)
	before := cloneMatchState(m.state)
	assert.False(t, m.state.Apply(matchInput(MatchOpPick, 0, 9)))
	assert.False(t, m.state.Apply(matchInput(MatchOpWait, 0, 255)))
	assert.Equal(t, before, m.state)
}

func TestMatch3ValidInput(t *testing.T) {
	assert.True(t, ValidMatchInput(0))
	assert.True(t, ValidMatchInput(matchInput(MatchOpShuffle, MatchMaxArg, MatchMaxDelta)))
	assert.False(t, ValidMatchInput(-1))
	assert.False(t, ValidMatchInput(5))
	assert.False(t, ValidMatchInput(7|1<<10))
	assert.False(t, ValidMatchInput(1<<18))
}

// Following the generator order never needs more than 2 tray tiles, and it
// clears every board for any seed and level.
func TestMatch3GeneratorOrderIsAlwaysSolvable(t *testing.T) {
	for seed := uint32(1); seed <= 200; seed++ {
		for level := 1; level <= 20; level++ {
			s := NewMatch(seed, MatchModeEndless, 0)
			s.Level, s.LevelCap = level, level
			s.loadLevel()
			triples := min(5+level, 20)
			require.Len(t, s.Tiles, 3*triples)
			counts := map[int]int{}
			cells := map[[3]int]bool{}
			for _, tile := range s.Tiles {
				counts[tile.Type]++
				cells[[3]int{tile.X, tile.Y, tile.Z}] = true
			}
			require.Len(t, cells, len(s.Tiles))
			for _, count := range counts {
				require.Equal(t, 0, count%3)
			}
			order := matchWitnessOrder(s)
			require.Len(t, order, len(s.Tiles))
			for _, id := range order {
				require.True(t, s.Apply(matchInput(MatchOpPick, id, 2)), "seed %d level %d", seed, level)
				require.LessOrEqual(t, len(s.Tray), 2, "seed %d level %d", seed, level)
			}
			require.Equal(t, MatchCompleted, s.Status, "seed %d level %d", seed, level)
			require.Equal(t, 0, s.Rejected)
		}
	}
}

// With a pair in the tray, the shuffled board is still solvable by following
// the order shuffleBoard returns.
func TestMatch3ShuffleWithPairInTrayClearsBoard(t *testing.T) {
	for seed := uint32(1); seed <= 40; seed++ {
		for _, level := range []int{1, 8, 15} {
			s := NewMatch(seed, MatchModeEndless, MatchUnlockShuffle)
			s.Level, s.LevelCap = level, level
			s.loadLevel()
			order := matchWitnessOrder(s)
			require.True(t, s.Apply(matchInput(MatchOpPick, order[0], 0)))
			require.True(t, s.Apply(matchInput(MatchOpPick, order[1], 2)))
			require.Len(t, s.Tray, 2)
			s.Energy = MatchEnergyCap
			probe := cloneMatchState(s)
			shuffled := probe.shuffleBoard()
			require.True(t, s.Apply(matchInput(MatchOpShuffle, 0, 2)))
			require.Equal(t, probe.Tiles, s.Tiles)
			require.Len(t, shuffled, len(s.Tiles)-2)
			for _, id := range shuffled {
				require.True(t, s.Apply(matchInput(MatchOpPick, id, 2)))
				require.LessOrEqual(t, len(s.Tray), 2)
			}
			require.Equal(t, MatchCompleted, s.Status, "seed %d level %d", seed, level)
			require.Equal(t, 0, s.Rejected)
		}
	}
}

func TestMatch3EngineHasNoClockOrRandomSource(t *testing.T) {
	raw, err := os.ReadFile("match3.go")
	require.NoError(t, err)
	for _, banned := range []string{"time.", "Date", "Math.random", "performance", "rand."} {
		assert.NotContains(t, string(raw), banned)
	}
}
