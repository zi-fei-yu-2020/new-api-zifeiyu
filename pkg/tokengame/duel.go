package tokengame

import "math"

const DuelVersion = 1
const DuelDuration = 900

type DuelBeamTarget struct {
	X    int `json:"x"`
	Y    int `json:"y"`
	Kind int `json:"kind"` // 0 = enemy, 1 = opposing player
}

type DuelPlayer struct {
	X            int              `json:"x"`
	Y            int              `json:"y"`
	HP           int              `json:"hp"`
	MaxHP        int              `json:"max_hp"`
	Score        int              `json:"score"`
	Kills        int              `json:"kills"`
	Collected    int              `json:"collected"`
	Power        int              `json:"power"`
	Speed        int              `json:"speed"`
	Upgrades     int              `json:"upgrades"`
	Haste        int              `json:"haste"`
	ExtraTargets int              `json:"extra_targets"`
	AttackCharge int              `json:"attack_charge"`
	DashUntil    int              `json:"dash_until"`
	DashReady    int              `json:"dash_ready"`
	HurtUntil    int              `json:"hurt_until"`
	BeamUntil    int              `json:"beam_until"`
	BeamTargets  []DuelBeamTarget `json:"beam_targets"`
	Cursor       int              `json:"cursor"` // input ticks already consumed by the server
}

type DuelEnemy struct {
	ID      int `json:"id"`
	X       int `json:"x"`
	Y       int `json:"y"`
	HP      int `json:"hp"`
	Kind    int `json:"kind"`
	LastHit int `json:"last_hit"` // player slot 1|2 that damaged it last, 0 = untouched
}

type DuelToken struct {
	X     int `json:"x"`
	Y     int `json:"y"`
	Value int `json:"value"`
}

type DuelState struct {
	Version  int           `json:"version"`
	Tick     int           `json:"tick"`
	RNG      uint32        `json:"rng"`
	NextID   int           `json:"next_id"`
	Players  [2]DuelPlayer `json:"players"` // index 0 = slot 1, index 1 = slot 2
	Enemies  []DuelEnemy   `json:"enemies"`
	Tokens   []DuelToken   `json:"tokens"`
	Winner   int           `json:"winner"` // 0 = in progress, 1, 2, 3 = draw
	Finished bool          `json:"finished"`
}

func NewDuel(seed uint32) DuelState {
	state := DuelState{Version: DuelVersion, RNG: seed, Enemies: []DuelEnemy{}, Tokens: []DuelToken{}}
	for slot := range state.Players {
		state.Players[slot].HP = 100
		state.Players[slot].MaxHP = 100
		state.Players[slot].Power = 3
		state.Players[slot].Speed = 140
	}
	state.Players[0].X, state.Players[0].Y = 2500, 3500
	state.Players[1].X, state.Players[1].Y = 7500, 3500
	return state
}

func (s *DuelState) random(n int) int {
	s.RNG = s.RNG*1664525 + 1013904223
	return int(uint64(s.RNG) % uint64(n))
}

func (s *DuelState) Done() bool { return s.Finished }

// Step is the authoritative fixed-point 1v1 simulation. Both clients only ever
// submit constrained input values; every position, hit, kill and score is
// derived here from the seed plus the two input streams, so the full duel can
// be replayed byte-for-byte from the recorded batches.
func (s *DuelState) Step(input1, input2 int) {
	if s.Finished {
		return
	}
	s.Tick++
	inputs := [2]int{input1, input2}
	for i := range s.Players {
		player := &s.Players[i]
		if choice := inputs[i] >> 5; choice > 0 && player.Upgrades < min(3, s.Tick/200) {
			player.Upgrades++
			switch choice {
			case 1:
				player.Power += 2
			case 2:
				player.Haste++
				player.Speed = 140 + 35*player.Haste
			case 3:
				player.ExtraTargets++
			}
		}
		if inputs[i]&16 != 0 && s.Tick >= player.DashReady {
			player.DashUntil = s.Tick + 4
			player.DashReady = s.Tick + 45
		}
		d := directions[inputs[i]&15]
		speed := player.Speed
		if s.Tick < player.DashUntil {
			speed *= 3
		}
		if d[0] != 0 && d[1] != 0 {
			speed = speed * 707 / 1000
		}
		player.X = max(200, min(9800, player.X+d[0]*speed))
		player.Y = max(200, min(6800, player.Y+d[1]*speed))
	}
	s.duelAttack(0)
	s.duelAttack(1)
	s.duelSpawn()
	s.duelMoveEnemies()
	s.duelReapEnemies()
	s.duelCollectTokens()
	if s.Tick%10 == 0 {
		s.Players[0].Score++
		s.Players[1].Score++
	}
	s.duelSettle()
}

// Forfeit records a resignation as a knockout loss for the resigned slot.
func (s *DuelState) Forfeit(slot int) {
	if s.Finished {
		return
	}
	s.Players[slot].HP = 0
	s.duelSettle()
}

func (s *DuelState) duelAttack(slot int) {
	player := &s.Players[slot]
	player.AttackCharge += 100 + 25*player.Haste
	if player.AttackCharge < 400 {
		return
	}
	player.AttackCharge -= 400
	player.BeamTargets = nil
	shots := 1 + player.ExtraTargets
	opponent := &s.Players[1-slot]
	if opponent.HP > 0 {
		dx, dy := opponent.X-player.X, opponent.Y-player.Y
		if dx*dx+dy*dy <= 2200*2200 {
			opponent.HP = max(0, opponent.HP-player.Power)
			player.BeamUntil = s.Tick + 2
			player.BeamTargets = append(player.BeamTargets, DuelBeamTarget{X: opponent.X, Y: opponent.Y, Kind: 1})
			shots--
		}
	}
	selected := make([]bool, len(s.Enemies))
	for ; shots > 0; shots-- {
		closest, dist := -1, 2200*2200
		for i := range s.Enemies {
			if selected[i] || s.Enemies[i].HP <= 0 {
				continue
			}
			dx, dy := s.Enemies[i].X-player.X, s.Enemies[i].Y-player.Y
			if dd := dx*dx + dy*dy; dd < dist {
				closest, dist = i, dd
			}
		}
		if closest < 0 {
			break
		}
		selected[closest] = true
		enemy := &s.Enemies[closest]
		enemy.HP -= player.Power
		enemy.LastHit = slot + 1
		player.BeamUntil = s.Tick + 2
		player.BeamTargets = append(player.BeamTargets, DuelBeamTarget{X: enemy.X, Y: enemy.Y})
	}
}

func (s *DuelState) duelSpawn() {
	interval := max(4, 10-s.Tick/150)
	boss := s.Tick == 250 || s.Tick == 550 || s.Tick == 800
	if (s.Tick%interval != 0 && !boss) || len(s.Enemies) >= 100 {
		return
	}
	kind := s.random(10)
	if kind < 6 {
		kind = 0
	} else if kind < 9 {
		kind = 1
	} else {
		kind = 2
	}
	if boss {
		kind = 3
	}
	x, y := s.random(10000), s.random(7000)
	switch s.random(4) {
	case 0:
		x = 0
	case 1:
		x = 10000
	case 2:
		y = 0
	case 3:
		y = 7000
	}
	s.NextID++
	s.Enemies = append(s.Enemies, DuelEnemy{ID: s.NextID, X: x, Y: y, HP: []int{4, 3, 14, 70}[kind], Kind: kind})
}

func (s *DuelState) duelMoveEnemies() {
	for i := range s.Enemies {
		enemy := &s.Enemies[i]
		// Chase the nearest living player; a tie keeps player one so the run
		// stays deterministic. When nobody is left alive this tick, hold course.
		target := 0
		if s.Players[0].HP > 0 && s.Players[1].HP > 0 {
			dx1, dy1 := s.Players[0].X-enemy.X, s.Players[0].Y-enemy.Y
			dx2, dy2 := s.Players[1].X-enemy.X, s.Players[1].Y-enemy.Y
			if dx2*dx2+dy2*dy2 < dx1*dx1+dy1*dy1 {
				target = 1
			}
		} else if s.Players[1].HP > 0 {
			target = 1
		}
		player := &s.Players[target]
		dx, dy := player.X-enemy.X, player.Y-enemy.Y
		dist := max(1, int(math.Sqrt(float64(dx*dx+dy*dy))))
		velocity := []int{105, 155, 70, 90}[enemy.Kind] + s.Tick/30
		enemy.X += dx * velocity / dist
		enemy.Y += dy * velocity / dist
		if dist < 330 && s.Tick >= player.HurtUntil && s.Tick >= player.DashUntil {
			player.HP = max(0, player.HP-[]int{8, 6, 15, 25}[enemy.Kind])
			player.HurtUntil = s.Tick + 8
		}
	}
}

func (s *DuelState) duelReapEnemies() {
	enemies := s.Enemies[:0]
	for _, enemy := range s.Enemies {
		if enemy.HP > 0 {
			enemies = append(enemies, enemy)
			continue
		}
		value := 10
		if enemy.Kind == 3 {
			value = 100
		}
		slot := enemy.LastHit - 1
		if slot < 0 || slot > 1 {
			slot = 0 // unreachable: only player fire can drop an enemy
		}
		s.Players[slot].Kills++
		s.Players[slot].Score += value * 2
		if len(s.Tokens) < 200 {
			s.Tokens = append(s.Tokens, DuelToken{X: enemy.X, Y: enemy.Y, Value: value})
		}
	}
	s.Enemies = enemies
}

// Player one resolves first, so a token both players can reach in the same
// tick goes to player one; magnets pull toward whichever player judges it.
func (s *DuelState) duelCollectTokens() {
	for i := range s.Players {
		player := &s.Players[i]
		tokens := s.Tokens[:0]
		for _, token := range s.Tokens {
			dx, dy := player.X-token.X, player.Y-token.Y
			dist := int(math.Sqrt(float64(dx*dx + dy*dy)))
			if dist < 450 {
				player.Collected += token.Value
				player.Score += token.Value * 3
				continue
			}
			if dist < 1400 {
				token.X += dx * 220 / dist
				token.Y += dy * 220 / dist
			}
			tokens = append(tokens, token)
		}
		s.Tokens = tokens
	}
}

func (s *DuelState) duelSettle() {
	first, second := &s.Players[0], &s.Players[1]
	if first.HP <= 0 || second.HP <= 0 {
		s.Finished = true
		switch {
		case first.HP <= 0 && second.HP <= 0:
			s.Winner = 3
		case first.HP <= 0:
			s.Winner = 2
		default:
			s.Winner = 1
		}
		return
	}
	if s.Tick >= DuelDuration {
		s.Finished = true
		s.Winner = 3
		if first.Score > second.Score {
			s.Winner = 1
		} else if second.Score > first.Score {
			s.Winner = 2
		}
	}
}

// AdvanceDuel replays the authoritative simulation up to the allowed tick.
// Ticks beyond a player's submitted stream use the neutral input, so missing
// batches neither pause the clock nor speed it up.
func AdvanceDuel(state *DuelState, allowed int, inputs1, inputs2 []int) {
	limit := min(max(allowed, 0), DuelDuration)
	for state.Tick < limit && !state.Finished {
		var input1, input2 int
		if state.Tick < len(inputs1) {
			input1 = inputs1[state.Tick]
		}
		if state.Tick < len(inputs2) {
			input2 = inputs2[state.Tick]
		}
		state.Step(input1, input2)
	}
	state.Players[0].Cursor = min(len(inputs1), state.Tick)
	state.Players[1].Cursor = min(len(inputs2), state.Tick)
}
