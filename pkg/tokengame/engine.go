package tokengame

import "math"

const Duration = 1800
const TickMillis = 100
const MaxInputBatch = 300
const Version = 3
const SprintDuration = 900
const UpgradePauseTicks = 100
const MaxTokens = 187 // Legacy ceiling, retained for existing runs.
const SprintMaxTokens = 129

type Enemy struct {
	ID   int `json:"id"`
	X    int `json:"x"`
	Y    int `json:"y"`
	HP   int `json:"hp"`
	Kind int `json:"kind"`
}
type Token struct {
	X     int `json:"x"`
	Y     int `json:"y"`
	Value int `json:"value"`
}
type BeamTarget struct {
	X int `json:"x"`
	Y int `json:"y"`
}
type State struct {
	Version      int          `json:"version"`
	Tick         int          `json:"tick"`
	ClockTick    int          `json:"clock_tick,omitempty"`
	PauseTicks   int          `json:"pause_ticks,omitempty"`
	RNG          uint32       `json:"rng"`
	X            int          `json:"x"`
	Y            int          `json:"y"`
	HP           int          `json:"hp"`
	MaxHP        int          `json:"max_hp"`
	Score        int          `json:"score"`
	Kills        int          `json:"kills"`
	Collected    int          `json:"collected"`
	PickedTokens int          `json:"picked_tokens"`
	Power        int          `json:"power"`
	Speed        int          `json:"speed"`
	Upgrades     int          `json:"upgrades"`
	Haste        int          `json:"haste,omitempty"`
	ExtraTargets int          `json:"extra_targets,omitempty"`
	AttackCharge int          `json:"attack_charge,omitempty"`
	BeamTargets  []BeamTarget `json:"beam_targets,omitempty"`
	DashUntil    int          `json:"dash_until"`
	DashReady    int          `json:"dash_ready"`
	HurtUntil    int          `json:"hurt_until"`
	BeamX        int          `json:"beam_x"`
	BeamY        int          `json:"beam_y"`
	BeamUntil    int          `json:"beam_until"`
	NextID       int          `json:"next_id"`
	Enemies      []Enemy      `json:"enemies"`
	Tokens       []Token      `json:"tokens"`
}

func New(seed uint32) State {
	return State{Version: Version, RNG: seed, X: 5000, Y: 3500, HP: 100, MaxHP: 100, Power: 3, Speed: 140, Enemies: []Enemy{}, Tokens: []Token{}}
}
func (s *State) random(n int) int {
	s.RNG = s.RNG*1664525 + 1013904223
	return int(uint64(s.RNG) % uint64(n))
}
func (s *State) Duration() int {
	if s.Version >= 2 {
		return SprintDuration
	}
	return Duration
}
func (s *State) Cursor() int {
	if s.Version >= 2 {
		return s.ClockTick
	}
	return s.Tick
}
func (s *State) ClockLimit() int {
	if s.Version >= 2 {
		return SprintDuration + 3*UpgradePauseTicks
	}
	return Duration
}
func (s *State) UpgradePending() bool {
	return s.Version >= 2 && !s.Done() && s.Upgrades < min(3, s.Tick/200)
}
func (s *State) Done() bool     { return s.HP <= 0 || s.Tick >= s.Duration() }
func ValidInput(input int) bool { return input >= 0 && input <= 127 && input&15 <= 8 }

var directions = [9][2]int{{0, 0}, {0, -1}, {1, -1}, {1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}}

// Step is the authoritative fixed-point simulation. Inputs contain only direction,
// dash and upgrade choices; positions, kills, score and rewards never come from clients.
func (s *State) Step(input int) {
	if s.Done() {
		return
	}
	if s.Version >= 2 {
		s.ClockTick++
		if s.UpgradePending() {
			s.PauseTicks++
			choice := input >> 5
			if choice == 0 && s.PauseTicks >= UpgradePauseTicks {
				choice = 3
			}
			if choice > 0 {
				s.Upgrades++
				s.PauseTicks = 0
				switch choice {
				case 1:
					s.Power += 2
				case 2:
					if s.Version >= 3 {
						s.Haste++
						s.Speed = 140 + 35*s.Haste
					} else {
						s.Speed += 20
					}
				case 3:
					if s.Version >= 3 {
						s.ExtraTargets++
					} else {
						s.MaxHP += 15
						s.HP = min(s.MaxHP, s.HP+35)
					}
				}
			}
			return
		}
	}
	s.Tick++
	upgrade := input >> 5
	if s.Version < 2 && upgrade > 0 && s.Upgrades < min(5, s.Tick/300) {
		s.Upgrades++
		switch upgrade {
		case 1:
			s.Power += 2
		case 2:
			s.Speed += 20
		case 3:
			s.MaxHP += 15
			s.HP = min(s.MaxHP, s.HP+35)
		}
	}
	if input&16 != 0 && s.Tick >= s.DashReady {
		s.DashUntil = s.Tick + 4
		s.DashReady = s.Tick + 45
	}
	d := directions[input&15]
	speed := s.Speed
	if s.Tick < s.DashUntil {
		speed *= 3
	}
	if d[0] != 0 && d[1] != 0 {
		speed = speed * 707 / 1000
	}
	s.X = max(200, min(9800, s.X+d[0]*speed))
	s.Y = max(200, min(6800, s.Y+d[1]*speed))
	interval := max(5, 15-s.Tick/180)
	boss := s.Tick == 600 || s.Tick == 1200 || s.Tick == 1650
	if s.Version >= 2 {
		interval = max(4, 10-s.Tick/150)
		boss = s.Tick == 250 || s.Tick == 550 || s.Tick == 800
	}
	if (s.Tick%interval == 0 || boss) && len(s.Enemies) < 100 {
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
		hp := []int{3, 2, 12, 100}[kind]
		if s.Version >= 2 {
			hp = []int{4, 3, 14, 70}[kind]
		}
		s.Enemies = append(s.Enemies, Enemy{ID: s.NextID, X: x, Y: y, HP: hp, Kind: kind})
	}
	attackInterval := 5
	if s.Version >= 2 {
		attackInterval = 4
	}
	attackReady := s.Tick%attackInterval == 0
	if s.Version >= 3 {
		// Integer rate accumulation preserves +25% steps at the fixed 100ms tick.
		// Consume cadence even without targets, so idle time cannot stockpile shots.
		s.AttackCharge += 100 + 25*s.Haste
		attackReady = s.AttackCharge >= 400
		if attackReady {
			s.AttackCharge -= 400
		}
	}
	if attackReady && len(s.Enemies) > 0 {
		targetCount := 1
		if s.Version >= 3 {
			targetCount += s.ExtraTargets
			s.BeamTargets = nil
		}
		selected := make([]bool, len(s.Enemies))
		for shot := 0; shot < targetCount; shot++ {
			closest, dist := -1, 2200*2200
			for i, e := range s.Enemies {
				if s.Version >= 3 && (selected[i] || e.HP <= 0) {
					continue
				}
				dx, dy := e.X-s.X, e.Y-s.Y
				dd := dx*dx + dy*dy
				if dd < dist {
					closest = i
					dist = dd
				}
			}
			if closest < 0 {
				break
			}
			selected[closest] = true
			e := &s.Enemies[closest]
			e.HP -= s.Power
			if shot == 0 {
				s.BeamX = e.X
				s.BeamY = e.Y
			}
			s.BeamUntil = s.Tick + 2
			if s.Version >= 3 {
				s.BeamTargets = append(s.BeamTargets, BeamTarget{X: e.X, Y: e.Y})
			}
		}
	}

	enemies := s.Enemies[:0]
	for _, e := range s.Enemies {
		if e.HP <= 0 {
			s.Kills++
			value := 10
			if e.Kind == 3 {
				value = 100
			}
			s.Score += value * 2
			if len(s.Tokens) < 200 {
				s.Tokens = append(s.Tokens, Token{X: e.X, Y: e.Y, Value: value})
			}
			continue
		}
		dx, dy := s.X-e.X, s.Y-e.Y
		dist := max(1, int(math.Sqrt(float64(dx*dx+dy*dy))))
		velocity := []int{48, 85, 32, 38}[e.Kind] + s.Tick/120
		if s.Version >= 2 {
			velocity = []int{105, 155, 70, 90}[e.Kind] + s.Tick/30
		}
		e.X += dx * velocity / dist
		e.Y += dy * velocity / dist
		if dist < 330 && s.Tick >= s.HurtUntil && s.Tick >= s.DashUntil {
			s.HP = max(0, s.HP-[]int{8, 6, 15, 25}[e.Kind])
			s.HurtUntil = s.Tick + 8
		}
		enemies = append(enemies, e)
	}
	s.Enemies = enemies
	tokens := s.Tokens[:0]
	for _, token := range s.Tokens {
		dx, dy := s.X-token.X, s.Y-token.Y
		dist := int(math.Sqrt(float64(dx*dx + dy*dy)))
		if dist < 450 {
			s.Collected += token.Value
			s.PickedTokens++
			s.Score += token.Value * 3
			continue
		}
		if dist < 1400 {
			token.X += dx * 220 / dist
			token.Y += dy * 220 / dist
		}
		tokens = append(tokens, token)
	}
	s.Tokens = tokens
	if s.Tick%10 == 0 {
		s.Score++
	}
}
