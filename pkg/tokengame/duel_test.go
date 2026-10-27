package tokengame

import (
	"math"
	"os"
	"slices"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
)

func TestDuelDeterministicReplay(t *testing.T) {
	for _, seed := range []uint32{1, 42, 20261027} {
		first, second := NewDuel(seed), NewDuel(seed)
		for tick := 0; tick < 300; tick++ {
			input1, input2 := duelScriptInput(tick, 1), duelScriptInput(tick, 7)
			first.Step(input1, input2)
			second.Step(input1, input2)
		}
		rawFirst, err := common.Marshal(first)
		require.NoError(t, err)
		rawSecond, err := common.Marshal(second)
		require.NoError(t, err)
		require.JSONEq(t, string(rawFirst), string(rawSecond))
	}
}

// A fixed scripted input: run in one direction, dash on cooldown, upgrade as
// soon as the gate opens. Shared by engine tests and fixture generation.
func duelScriptInput(tick, direction int) int {
	input := direction
	if tick%45 == 0 {
		input |= 16
	}
	if tick == 200 || tick == 400 || tick == 600 {
		input |= 1 << 5
	}
	return input
}

func TestDuelPlayersTradeFireAndCreditEnemyKills(t *testing.T) {
	state := NewDuel(42)
	state.Tick = 3
	state.Players[0].AttackCharge = 300
	state.Players[1].AttackCharge = 300
	state.Players[1].X, state.Players[1].Y = 4000, 3500
	state.Step(0, 0)
	require.Equal(t, 97, state.Players[0].HP, "players within beam range must trade damage")
	require.Equal(t, 97, state.Players[1].HP)
	require.Len(t, state.Players[0].BeamTargets, 1)
	require.Equal(t, 1, state.Players[0].BeamTargets[0].Kind, "the opponent is the priority target")

	state = NewDuel(42)
	state.Tick = 3
	state.Players[0].AttackCharge = 300
	state.Players[1].X, state.Players[1].Y = 9000, 3500 // out of beam range
	state.Enemies = []DuelEnemy{{ID: 1, X: 3000, Y: 3500, HP: 3, Kind: 0}}
	state.Step(0, 0)
	require.Equal(t, 1, state.Players[0].Kills, "enemy kills credit the last hitting player")
	require.Empty(t, state.Enemies)
	require.Empty(t, state.Tokens, "the drop lands inside the pickup radius")
	require.Equal(t, 10, state.Players[0].Collected)
	require.Zero(t, state.Players[0].BeamTargets[0].Kind)
}

func TestDuelEnemiesChaseNearestPlayerTieBreaksToPlayerOne(t *testing.T) {
	state := NewDuel(42)
	state.Tick = 10
	state.Enemies = []DuelEnemy{{ID: 1, X: 5000, Y: 3500, HP: 14, Kind: 0}}
	state.Step(0, 0)
	require.Less(t, state.Enemies[0].X, 5000, "equidistant enemies must chase player one")
	state = NewDuel(42)
	state.Tick = 10
	state.Enemies = []DuelEnemy{{ID: 1, X: 6000, Y: 3500, HP: 14, Kind: 0}}
	state.Step(0, 0)
	require.Greater(t, state.Enemies[0].X, 6000, "closer player two must be chased instead")
}

func TestDuelMutualKnockoutIsADraw(t *testing.T) {
	state := NewDuel(42)
	state.Tick = 3
	state.Players[0].HP = 1
	state.Players[1].HP = 1
	state.Players[0].AttackCharge = 300
	state.Players[1].AttackCharge = 300
	state.Players[1].X, state.Players[1].Y = 4000, 3500
	state.Step(0, 0)
	require.True(t, state.Finished)
	require.Equal(t, 3, state.Winner)
}

func TestDuelTimeoutDecidesByScore(t *testing.T) {
	state := NewDuel(42)
	state.Tick = 899
	state.Players[0].Score = 10
	state.Players[1].Score = 5
	state.Step(0, 0)
	require.True(t, state.Finished)
	require.Equal(t, 1, state.Winner)
	require.Positive(t, state.Players[0].HP)
	require.Positive(t, state.Players[1].HP)

	state = NewDuel(7)
	state.Tick = 899
	state.Step(0, 0)
	require.True(t, state.Finished)
	require.Equal(t, 3, state.Winner, "equal scores at the timeout must draw")
}

func TestDuelForfeitLosesImmediately(t *testing.T) {
	state := NewDuel(42)
	state.Tick = 50
	state.Forfeit(0)
	require.True(t, state.Finished)
	require.Equal(t, 2, state.Winner)
	state.Forfeit(1)
	require.Equal(t, 2, state.Winner, "a finished duel cannot change result")
}

func TestDuelUpgradesApplyInstantly(t *testing.T) {
	for choice, check := range map[int]func(s *DuelState){
		1: func(s *DuelState) { require.Equal(t, 5, s.Players[0].Power) },
		2: func(s *DuelState) { require.Equal(t, 175, s.Players[0].Speed); require.Equal(t, 1, s.Players[0].Haste) },
		3: func(s *DuelState) { require.Equal(t, 1, s.Players[0].ExtraTargets) },
	} {
		state := NewDuel(42)
		state.Tick = 199
		state.Step(choice<<5, 0)
		require.Equal(t, 1, state.Players[0].Upgrades)
		require.Zero(t, state.Players[1].Upgrades, "upgrades only apply to the choosing player")
		check(&state)
	}
	state := NewDuel(42)
	state.Tick = 199
	state.Step(1<<5, 0)
	state.Step(1<<5, 0)
	require.Equal(t, 1, state.Players[0].Upgrades, "the upgrade gate only reopens every 200 ticks")
}

func TestDuelDashBurstsMoveThreeTimesFaster(t *testing.T) {
	state := NewDuel(42)
	state.Step(16|2, 0) // direction (1,-1) with dash: 140*3*707/1000 = 296 per axis
	require.Equal(t, 2500+296, state.Players[0].X)
	require.Equal(t, 3500-296, state.Players[0].Y)
	require.Equal(t, 5, state.Players[0].DashUntil)
	require.Equal(t, 46, state.Players[0].DashReady)
}

func TestDuelChargeKeepsCadenceAndScalesWithHaste(t *testing.T) {
	for level, expected := range map[int]int{0: 40, 2: 60} {
		state := NewDuel(42)
		for upgrade := 0; upgrade < level; upgrade++ {
			state.Tick = (upgrade + 1) * 200
			state.Step(2<<5, 0)
			state.Tick = 0
		}
		require.Equal(t, 140+35*level, state.Players[0].Speed)
		state.Tick = 0
		state.Players[0].AttackCharge = 0
		state.Players[1].X, state.Players[1].Y = 9000, 3500
		shots := 0
		for tick := 0; tick < 160; tick++ {
			state.Enemies = []DuelEnemy{{ID: 1, X: 3000, Y: 3500, HP: 1000, Kind: 0}}
			state.Step(0, 0)
			if state.Players[0].BeamUntil == state.Tick+2 {
				shots++
			}
		}
		require.Equal(t, expected, shots, "haste %d must fire at %d shots per 160 ticks", level, expected)
	}
}

func TestDuelStepAfterFinishHasNoEffect(t *testing.T) {
	state := NewDuel(42)
	for !state.Finished {
		state.Step(3|16, 7|16)
	}
	before, err := common.Marshal(state)
	require.NoError(t, err)
	for range 10 {
		state.Step(3|16, 7|16)
	}
	after, err := common.Marshal(state)
	require.NoError(t, err)
	require.JSONEq(t, string(before), string(after))
}

func TestAdvanceDuelFillsMissingInputsNeutrally(t *testing.T) {
	advanced := NewDuel(42)
	AdvanceDuel(&advanced, 300, []int{3, 3, 3}, nil)
	require.Equal(t, 3, advanced.Players[0].Cursor)
	require.Equal(t, 0, advanced.Players[1].Cursor)
	advanced.Players[0].Cursor = 0
	manual := NewDuel(42)
	for tick := 0; tick < 300; tick++ {
		input1 := 0
		if tick < 3 {
			input1 = 3
		}
		manual.Step(input1, 0)
	}
	require.Equal(t, manual, advanced)
}

func TestDuelReplayCompatibility(t *testing.T) {
	raw, err := os.ReadFile("testdata/duel-replays.json")
	require.NoError(t, err)
	var fixtures []struct {
		Seed    uint32
		Inputs1 []int
		Inputs2 []int
		State   DuelState
	}
	require.NoError(t, common.Unmarshal(raw, &fixtures))
	require.GreaterOrEqual(t, len(fixtures), 3)
	for _, fixture := range fixtures {
		state := NewDuel(fixture.Seed)
		require.Equal(t, len(fixture.Inputs1), len(fixture.Inputs2), "duel inputs must stay tick-aligned")
		for tick := range fixture.Inputs1 {
			require.True(t, ValidInput(fixture.Inputs1[tick]))
			require.True(t, ValidInput(fixture.Inputs2[tick]))
			state.Step(fixture.Inputs1[tick], fixture.Inputs2[tick])
		}
		require.Equal(t, fixture.State, state)
	}
}

// A defensive autopilot: flee the nearest threats, keep clear of the other
// player so runs stay a race against the clock, dash on cooldown and upgrade
// haste first. Only used to author committed fixtures, never at runtime.
func duelSurvivalInput(state *DuelState, slot int) int {
	player := &state.Players[slot]
	opponent := &state.Players[1-slot]
	best, bestScore := 0, -1.0
	for d := 1; d < 9; d++ {
		dir := directions[d]
		nx := max(200, min(9800, player.X+dir[0]*player.Speed*5))
		ny := max(200, min(6800, player.Y+dir[1]*player.Speed*5))
		var distances []float64
		for i := range state.Enemies {
			if state.Enemies[i].HP <= 0 {
				continue
			}
			dx, dy := state.Enemies[i].X-nx, state.Enemies[i].Y-ny
			distances = append(distances, math.Sqrt(float64(dx*dx+dy*dy)))
		}
		if opponent.HP > 0 {
			dx, dy := opponent.X-nx, opponent.Y-ny
			distances = append(distances, math.Sqrt(float64(dx*dx+dy*dy))*1.2)
		}
		slices.Sort(distances)
		score := 0.0
		for i, dd := range distances {
			if i >= 4 {
				break
			}
			if dd < 700 {
				dd -= 2000 // deep threats dominate the score so the pilot dodges
			}
			score += dd * (4 - float64(i))
		}
		wall := min(min(nx-200, 9800-nx), min(ny-200, 6800-ny))
		score += float64(wall) * 3
		if score > bestScore {
			bestScore, best = score, d
		}
	}
	input := best
	if state.Tick >= player.DashReady {
		input |= 16
	}
	if player.Upgrades < min(3, (state.Tick+1)/200) {
		if player.Upgrades < 2 {
			input |= 2 << 5
		} else {
			input |= 1 << 5
		}
	}
	return input
}

// duelClone snapshots a state without aliasing its slices, so a recorded
// fixture never changes when the generating simulation keeps running.
func duelClone(state DuelState) DuelState {
	clone := state
	clone.Enemies = slices.Clone(state.Enemies)
	clone.Tokens = slices.Clone(state.Tokens)
	for i := range clone.Players {
		clone.Players[i].BeamTargets = slices.Clone(state.Players[i].BeamTargets)
	}
	return clone
}

// Regenerate the parity fixtures: WRITE_DUEL_FIXTURES=1 go test ./pkg/tokengame -run TestDuelWriteFixtures
func TestDuelWriteFixtures(t *testing.T) {
	if os.Getenv("WRITE_DUEL_FIXTURES") == "" {
		t.Skip("set WRITE_DUEL_FIXTURES=1 to regenerate duel-replays.json")
	}
	type fixture struct {
		Seed    uint32    `json:"seed"`
		Inputs1 []int     `json:"inputs1"`
		Inputs2 []int     `json:"inputs2"`
		State   DuelState `json:"state"`
	}
	var fixtures []fixture
	// Case one: both players charge at each other and trade fire until the
	// duel resolves.
	hunt := NewDuel(7)
	inputs1, inputs2 := []int{}, []int{}
	for !hunt.Finished && hunt.Tick < DuelDuration {
		input1, input2 := duelScriptInput(hunt.Tick, 3), duelScriptInput(hunt.Tick, 7)
		inputs1, inputs2 = append(inputs1, input1), append(inputs2, input2)
		hunt.Step(input1, input2)
	}
	require.True(t, hunt.Finished)
	fixtures = append(fixtures, fixture{Seed: 7, Inputs1: inputs1, Inputs2: inputs2, State: duelClone(hunt)})

	// Cases two and three: defensive autopilot, one long boss-heavy stretch and
	// one run that reaches the timeout decision with both players alive.
	var boss, timeout *fixture
	for seed := uint32(1); seed <= 200 && (boss == nil || timeout == nil); seed++ {
		state := NewDuel(seed)
		run1, run2 := []int{}, []int{}
		for !state.Finished {
			input1, input2 := duelSurvivalInput(&state, 0), duelSurvivalInput(&state, 1)
			run1, run2 = append(run1, input1), append(run2, input2)
			state.Step(input1, input2)
			if boss == nil && state.Tick == 600 && !state.Finished {
				trunc := state
				boss = &fixture{Seed: seed, Inputs1: slices.Clone(run1), Inputs2: slices.Clone(run2), State: duelClone(trunc)}
			}
		}
		if timeout == nil && state.Finished && state.Tick >= DuelDuration && state.Players[0].HP > 0 && state.Players[1].HP > 0 {
			trunc := state
			timeout = &fixture{Seed: seed, Inputs1: run1, Inputs2: run2, State: duelClone(trunc)}
		}
	}
	require.NotNil(t, boss, "no seed produced a 600-tick boss fixture")
	require.NotNil(t, timeout, "no seed produced a timeout fixture")
	require.Positive(t, boss.State.Players[0].Kills+boss.State.Players[1].Kills)
	require.Zero(t, boss.State.Players[0].Cursor)
	fixtures = append(fixtures, *boss)
	fixtures = append(fixtures, *timeout)
	raw, err := common.Marshal(fixtures)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile("testdata/duel-replays.json", raw, 0o644))
}
