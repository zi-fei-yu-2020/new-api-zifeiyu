package tokengame

import (
	"os"
	"slices"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLegacyReplayCompatibility(t *testing.T) {
	raw, err := os.ReadFile("testdata/replays.json")
	require.NoError(t, err)
	var fixtures []struct {
		Seed   uint32
		Inputs []int
		State  State
	}
	require.NoError(t, common.Unmarshal(raw, &fixtures))
	require.GreaterOrEqual(t, len(fixtures), 3)
	for _, fixture := range fixtures {
		state := New(fixture.Seed)
		state.Version = 1
		for _, input := range fixture.Inputs {
			state.Step(input)
		}
		require.Equal(t, fixture.State, state)
	}
}
func TestUpgradePausesCombatAndCannotBeExtended(t *testing.T) {
	state := New(42)
	state.Version = 2
	state.Tick = 200
	state.ClockTick = 200
	state.HP = 50
	state.Enemies = []Enemy{{ID: 1, X: state.X, Y: state.Y, HP: 40, Kind: 3}}
	state.Tokens = []Token{{X: state.X, Y: state.Y, Value: 10}}
	before := state
	for range UpgradePauseTicks - 1 {
		state.Step(3 | 16)
	}
	require.Equal(t, before.Tick, state.Tick)
	require.Equal(t, before.HP, state.HP)
	require.Equal(t, before.X, state.X)
	require.Equal(t, before.Enemies, state.Enemies)
	require.Equal(t, before.Tokens, state.Tokens)
	require.Zero(t, state.Score)
	require.Equal(t, 299, state.Cursor())
	require.True(t, state.UpgradePending())
	// Saving and restoring a checkpoint cannot renew the choice timer.
	raw, err := common.Marshal(state)
	require.NoError(t, err)
	require.NoError(t, common.Unmarshal(raw, &state))
	state.Step(0)
	require.False(t, state.UpgradePending())
	require.Equal(t, 1, state.Upgrades)
	require.Equal(t, 85, state.HP)
	require.Equal(t, 200, state.Tick)
	state.Step(0)
	require.Equal(t, 201, state.Tick)
}
func TestUpgradeChoiceAndEarlyInputs(t *testing.T) {
	for choice := 1; choice <= 3; choice++ {
		state := New(42)
		state.Step(choice << 5)
		require.Zero(t, state.Upgrades)
		state.Tick = 200
		state.ClockTick = 200
		state.Step(choice << 5)
		require.Equal(t, 200, state.Tick)
		require.Equal(t, 201, state.Cursor())
		require.Equal(t, 1, state.Upgrades)
		require.False(t, state.UpgradePending())
	}
}
func TestSprintLimitsAndThreats(t *testing.T) {
	slots := 0
	for tick := 1; tick <= SprintDuration; tick++ {
		if tick%max(4, 10-tick/150) == 0 || tick == 250 || tick == 550 || tick == 800 {
			slots++
		}
	}
	require.Equal(t, SprintMaxTokens, slots)
	state := New(42)
	state.HP = 100000
	state.MaxHP = 100000
	for !state.Done() {
		state.Step(0)
		require.LessOrEqual(t, state.Cursor(), 1200)
	}
	require.Equal(t, 900, state.Tick)
	require.Equal(t, 1200, state.Cursor())
	require.Equal(t, 3, state.Upgrades)
	for _, seed := range []uint32{1, 42, 20261019} {
		idle := New(seed)
		for !idle.Done() {
			idle.Step(0)
		}
		require.Zero(t, idle.HP, "standing still should not win the sprint")
	}
}

func TestSprintReplayCompatibility(t *testing.T) {
	raw, err := os.ReadFile("testdata/sprint-replays.json")
	require.NoError(t, err)
	var fixtures []struct {
		Seed   uint32
		Inputs []int
		State  State
	}
	require.NoError(t, common.Unmarshal(raw, &fixtures))
	require.GreaterOrEqual(t, len(fixtures), 3)
	for _, fixture := range fixtures {
		state := New(fixture.Seed)
		state.Version = fixture.State.Version
		for _, input := range fixture.Inputs {
			state.Step(input)
		}
		require.Equal(t, fixture.State, state)
	}
}

func TestCombatMobilityStacksAndFiresAtPromisedRate(t *testing.T) {
	for level := 0; level <= 3; level++ {
		s := New(42)
		for upgrade := 0; upgrade < level; upgrade++ {
			s.Tick = (upgrade + 1) * 200
			s.ClockTick = s.Tick
			s.Step(2 << 5)
		}
		require.Equal(t, 140+35*level, s.Speed)
		require.Equal(t, level, s.Haste)
		s.Tick = 0
		s.ClockTick = 0
		s.AttackCharge = 0
		shots := 0
		for tick := 0; tick < 160; tick++ {
			s.Enemies = []Enemy{{ID: 1, X: 6000, Y: 3500, HP: 1000, Kind: 0}}
			s.Step(0)
			if s.BeamUntil == s.Tick+2 {
				shots++
			}
		}
		require.Equal(t, 40+10*level, shots, "attack rate must increase 25%% per upgrade")
	}
}
func TestCombatTargetsHitDistinctLivingEnemiesWithinRange(t *testing.T) {
	for extra := 0; extra <= 3; extra++ {
		s := New(42)
		s.Tick = 3
		s.ClockTick = 3
		s.AttackCharge = 300
		s.ExtraTargets = extra
		s.Enemies = []Enemy{{ID: 1, X: 5500, Y: 3500, HP: 40}, {ID: 2, X: 5500, Y: 3500, HP: 40}, {ID: 3, X: 5700, Y: 3500, HP: 40}, {ID: 4, X: 5800, Y: 3500, HP: 40}, {ID: 5, X: 9000, Y: 3500, HP: 40}, {ID: 6, X: 5000, Y: 3500, HP: 0}}
		s.Step(0)
		require.Len(t, s.BeamTargets, 1+extra)
		for i := 0; i < 5; i++ {
			expected := 40
			if i < 1+extra {
				expected -= 3
			}
			require.Equal(t, expected, s.Enemies[i].HP)
		}
		require.Equal(t, 1, s.Kills, "already defeated enemies must not consume a target slot")
	}
}
func TestCombatUpgradeReplacesHealingAndPausesAttackCharge(t *testing.T) {
	s := New(42)
	s.HP = 40
	s.Tick = 200
	s.ClockTick = 200
	s.AttackCharge = 300
	for range UpgradePauseTicks {
		s.Step(0)
	}
	require.Equal(t, 40, s.HP)
	require.Equal(t, 100, s.MaxHP)
	require.Equal(t, 1, s.ExtraTargets)
	require.Equal(t, 300, s.AttackCharge)
	require.Equal(t, 200, s.Tick)
	for level := 2; level <= 3; level++ {
		s.Tick = level * 200
		s.ClockTick = s.Tick
		s.Step(3 << 5)
	}
	require.Equal(t, 3, s.ExtraTargets)
	require.Equal(t, 40, s.HP)
	legacy := New(42)
	legacy.Version = 2
	legacy.Tick = 200
	legacy.ClockTick = 200
	legacy.HP = 40
	legacy.Step(3 << 5)
	require.Equal(t, 75, legacy.HP)
	require.Zero(t, legacy.ExtraTargets)
}
func TestCombatReplayCompatibility(t *testing.T) {
	raw, err := os.ReadFile("testdata/combat-replays.json")
	require.NoError(t, err)
	var fixtures []struct {
		Seed   uint32
		Inputs []int
		State  State
	}
	require.NoError(t, common.Unmarshal(raw, &fixtures))
	require.GreaterOrEqual(t, len(fixtures), 3)
	for _, fixture := range fixtures {
		s := New(fixture.Seed)
		s.Version = fixture.State.Version
		for _, input := range fixture.Inputs {
			s.Step(input)
		}
		require.Equal(t, fixture.State, s)
	}
}

func TestCombatMultishotDropsOneTokenPerDefeatedEnemy(t *testing.T) {
	s := New(42)
	s.Tick = 3
	s.ClockTick = 3
	s.AttackCharge = 300
	s.ExtraTargets = 1
	s.Enemies = []Enemy{{ID: 1, X: 5100, Y: 3500, HP: 3}, {ID: 2, X: 4900, Y: 3500, HP: 3}}
	s.Step(0)
	require.Equal(t, 2, s.Kills)
	require.Equal(t, 2, s.PickedTokens)
	require.Equal(t, 20, s.Collected)
	require.Empty(t, s.Enemies)
	s.Step(0)
	require.Equal(t, 2, s.PickedTokens, "a defeated enemy cannot pay out twice")
}

func TestRandomVersionsKeepLegacyStreamAndFixLowBitBias(t *testing.T) {
	legacy, current := New(42), New(42)
	legacy.Version = 3
	// Version 3 and older keep the plain modulo so stored runs replay unchanged.
	rng := uint32(42)
	for range 8 {
		rng = rng*1664525 + 1013904223
		assert.Equal(t, int(rng%4), legacy.random(4))
	}
	// The low bits of the legacy stream cycle with period four; version 4 does not.
	var legacyEdges, edges []int
	for range 64 {
		legacyEdges = append(legacyEdges, legacy.random(4))
		edges = append(edges, current.random(4))
	}
	assert.Equal(t, legacyEdges[:4], legacyEdges[4:8])
	assert.NotEqual(t, edges[:4], edges[4:8])
	counts := [10]int{}
	for range 10000 {
		draw := current.random(10)
		require.GreaterOrEqual(t, draw, 0)
		require.Less(t, draw, 10)
		counts[draw]++
	}
	for value, count := range counts {
		assert.InDelta(t, 1000, count, 150, "draw %d must be roughly uniform", value)
	}
}

func TestRandomReplayCompatibility(t *testing.T) {
	raw, err := os.ReadFile("testdata/random-v4-replays.json")
	require.NoError(t, err)
	var fixtures []struct {
		Seed   uint32
		Inputs []int
		State  State
	}
	require.NoError(t, common.Unmarshal(raw, &fixtures))
	require.GreaterOrEqual(t, len(fixtures), 3)
	for _, fixture := range fixtures {
		require.Equal(t, Version, fixture.State.Version)
		s := New(fixture.Seed)
		for _, input := range fixture.Inputs {
			s.Step(input)
		}
		require.Equal(t, fixture.State, s)
	}
}

// Regenerate the version 4 fixtures: WRITE_SOLO_FIXTURES=1 go test ./pkg/tokengame -run TestSoloWriteFixtures
// The input scripts come from the committed version 3 combat fixtures; each is
// replayed under the current rules and truncated where the run ends.
func TestSoloWriteFixtures(t *testing.T) {
	if os.Getenv("WRITE_SOLO_FIXTURES") == "" {
		t.Skip("set WRITE_SOLO_FIXTURES=1 to regenerate random-v4-replays.json")
	}
	raw, err := os.ReadFile("testdata/combat-replays.json")
	require.NoError(t, err)
	var sources []struct {
		Seed   uint32 `json:"seed"`
		Inputs []int  `json:"inputs"`
	}
	require.NoError(t, common.Unmarshal(raw, &sources))
	type fixture struct {
		Seed   uint32 `json:"seed"`
		Inputs []int  `json:"inputs"`
		State  State  `json:"state"`
	}
	var fixtures []fixture
	for _, source := range sources {
		s := New(source.Seed)
		var used []int
		for _, input := range source.Inputs {
			if s.Done() {
				break
			}
			used = append(used, input)
			s.Step(input)
		}
		require.Positive(t, s.Kills)
		s.Enemies = slices.Clone(s.Enemies)
		s.Tokens = slices.Clone(s.Tokens)
		fixtures = append(fixtures, fixture{Seed: source.Seed, Inputs: used, State: s})
	}
	encoded, err := common.Marshal(fixtures)
	require.NoError(t, err)
	// The web engine always carries pause_ticks while Go omits a zero value;
	// spell it out so the committed fixture compares equal on both sides.
	var generic []map[string]any
	require.NoError(t, common.Unmarshal(encoded, &generic))
	for _, entry := range generic {
		state := entry["state"].(map[string]any)
		if _, ok := state["pause_ticks"]; !ok {
			state["pause_ticks"] = 0
		}
	}
	encoded, err = common.Marshal(generic)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile("testdata/random-v4-replays.json", encoded, 0o644))
}
