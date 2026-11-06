package model

import (
	"errors"
	"fmt"
	"hash/crc32"
	"math"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/pkg/tokengame"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrMatchClosed = errors.New("The tile game is currently closed")

// ErrMatchAttempts is kept for the HTTP layer; StartMatch returns the finished
// daily run instead of an error so the player can see the result.
var ErrMatchAttempts = errors.New("No daily tile game attempt is left today")
var ErrMatchInput = errors.New("Tile game progress is out of sync. Reconnect to continue the same run")

const matchModeDaily = "daily"
const matchModeEndless = "endless"
const matchRunning = "running"

// A run that was never finished is given up on after a day, which also lets its
// week be settled.
const matchRunAbandonAfter = 24 * time.Hour

// matchClockSlackTicks is how far a run's claimed clock may trail the wall clock
// (30s). It covers thinking time and a boss key pause, whose idle gaps the client
// sends capped. Further lag is waited out by the server with matchClockCatchUpTicks
// of margin so that sync jitter does not trigger it again at once.
const matchClockSlackTicks = 300
const matchClockCatchUpTicks = 50

// MatchRun is one tile game run. Slot makes the database the arbiter of the
// daily attempt ('daily:<day>') and of the single active endless run
// ('endless:active', rewritten to 'endless:<id>' when the run ends).
type MatchRun struct {
	ID         string `gorm:"type:varchar(40);primaryKey" json:"id"`
	UserID     int    `gorm:"uniqueIndex:idx_match_slot;index" json:"-"`
	Slot       string `gorm:"type:varchar(48);uniqueIndex:idx_match_slot" json:"-"`
	Mode       string `gorm:"type:varchar(8)" json:"mode"`
	Day        string `gorm:"type:varchar(10);index" json:"day"`
	Week       string `gorm:"type:varchar(10);index" json:"week"`
	Status     string `gorm:"type:varchar(16);index" json:"status"`
	Seed       int64  `json:"-"`
	Unlocks    int    `json:"unlocks"`
	Level      int    `json:"level"`
	Score      int    `json:"score"`
	StartedAt  int64  `gorm:"index" json:"started_at"`
	UpdatedAt  int64  `gorm:"autoUpdateTime:false" json:"updated_at"`
	FinishedAt int64  `json:"finished_at"`
	StateJSON  string `gorm:"type:text" json:"-"`
}

// MatchRank holds the best score of one player on one board ('daily:<day>' or
// 'weekly:<week>').
type MatchRank struct {
	ID         uint   `gorm:"primaryKey"`
	Board      string `gorm:"type:varchar(24);uniqueIndex:idx_match_rank_user;index:idx_match_rank_order,priority:1"`
	UserID     int    `gorm:"uniqueIndex:idx_match_rank_user"`
	Score      int    `gorm:"index:idx_match_rank_order,priority:2"`
	Level      int
	AchievedAt int64
}

type MatchProfile struct {
	UserID    int `gorm:"primaryKey;autoIncrement:false"`
	BestLevel int
	XP        int
	Runs      int
}

type MatchView struct {
	*MatchRun
	State      tokengame.MatchState `json:"state"`
	ServerTime int64                `json:"server_time"`
}

type MatchStatus struct {
	Settings struct {
		Enabled        bool `json:"enabled"`
		RewardsEnabled bool `json:"rewards_enabled"`
	} `json:"settings"`
	Day        string     `json:"day"`
	Week       string     `json:"week"`
	ResetsAt   int64      `json:"resets_at"`
	ServerTime int64      `json:"server_time"`
	DailyRun   *MatchView `json:"daily_run"`
	EndlessRun *MatchView `json:"endless_run"`
	Profile    struct {
		BestLevel int `json:"best_level"`
		XP        int `json:"xp"`
		Rank      int `json:"rank"`
		Unlocks   int `json:"unlocks"`
	} `json:"profile"`
	WeeklyPrizes         []int `json:"weekly_prizes"`
	WeeklyTotal          int   `json:"weekly_total"`
	WeeklyRewardsEnabled bool  `json:"weekly_rewards_enabled"`
}

// match3Period is the weekly prize snapshot of the ranked endless board. Only
// the top three are paid, with fixed amounts set by an administrator.
func (settings GameSettings) match3Period(week string) GamePeriod {
	period := GamePeriod{ID: "match3:" + week, WeeklyRewardVersion: 2}
	if !settings.Match3RewardsEnabled {
		return period
	}
	period.RewardsInitialized = true
	period.WeeklyFirstQuota, period.WeeklySecondQuota, period.WeeklyThirdQuota = settings.Match3WeeklyFirst, settings.Match3WeeklySecond, settings.Match3WeeklyThird
	period.Budget = period.WeeklyFirstQuota + period.WeeklySecondQuota + period.WeeklyThirdQuota
	return period
}

// matchEndlessUnlocks lists the skills a player has earned: reveal always, undo
// from level 3 and shuffle from level 6.
func matchEndlessUnlocks(bestLevel int) int {
	unlocks := tokengame.MatchUnlockReveal
	if bestLevel >= 3 {
		unlocks |= tokengame.MatchUnlockUndo
	}
	if bestLevel >= 6 {
		unlocks |= tokengame.MatchUnlockShuffle
	}
	return unlocks
}

// matchRankOf is the largest r with 50*r*(r+1) <= xp.
func matchRankOf(xp int) int {
	rank := 0
	for 50*(rank+1)*(rank+2) <= xp {
		rank++
	}
	return rank
}

func matchView(run *MatchRun, now time.Time) (*MatchView, error) {
	view := &MatchView{MatchRun: run, ServerTime: now.UnixMilli()}
	err := common.Unmarshal([]byte(run.StateJSON), &view.State)
	if err == nil && view.State.Version != tokengame.MatchVersion {
		err = ErrMatchInput
	}
	return view, err
}

func matchOpen(settings GameSettings) bool {
	return settings.Enabled && settings.Match3Enabled
}

// GetMatchStatus is read-only: it never advances or creates a run.
func GetMatchStatus(userID int, now time.Time) (*MatchStatus, error) {
	settings, err := GetGameSettings()
	if err != nil {
		return nil, err
	}
	day, week, reset := GameCalendar(now)
	status := &MatchStatus{Day: day, Week: week, ResetsAt: reset, ServerTime: now.UnixMilli()}
	status.Settings.Enabled = matchOpen(settings)
	status.Settings.RewardsEnabled = settings.Match3RewardsEnabled
	for _, mode := range []string{matchModeDaily, matchModeEndless} {
		query := DB.Where("user_id = ? AND mode = ?", userID, mode)
		if mode == matchModeDaily {
			query = query.Where("(day = ? OR status = ?)", day, matchRunning)
		} else {
			query = query.Where("status = ?", matchRunning)
		}
		var run MatchRun
		err := query.Order("started_at DESC").First(&run).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		view, err := matchView(&run, now)
		if err != nil {
			return nil, err
		}
		if mode == matchModeDaily {
			status.DailyRun = view
		} else {
			status.EndlessRun = view
		}
	}
	var profile MatchProfile
	if err := DB.Where("user_id = ?", userID).Limit(1).Find(&profile).Error; err != nil {
		return nil, err
	}
	status.Profile.BestLevel, status.Profile.XP = profile.BestLevel, profile.XP
	status.Profile.Rank = matchRankOf(profile.XP)
	status.Profile.Unlocks = matchEndlessUnlocks(profile.BestLevel)
	period := settings.match3Period(week)
	var stored []GamePeriod
	if err := DB.Where("id = ?", period.ID).Find(&stored).Error; err != nil {
		return nil, err
	}
	if len(stored) == 1 {
		period = stored[0]
	}
	status.WeeklyPrizes = period.weeklyPrizes()
	status.WeeklyTotal = status.WeeklyPrizes[0] + status.WeeklyPrizes[1] + status.WeeklyPrizes[2]
	status.WeeklyRewardsEnabled = settings.Match3RewardsEnabled && period.rewardRulesInitialized()
	return status, nil
}

// StartMatch returns the player's current run of that mode or creates it. The
// unique slot makes concurrent starts converge on one run.
func StartMatch(userID int, mode string, now time.Time) (*MatchView, error) {
	if mode != matchModeDaily && mode != matchModeEndless {
		return nil, ErrMatchInput
	}
	settings, err := GetGameSettings()
	if err != nil {
		return nil, err
	}
	if !matchOpen(settings) {
		return nil, ErrMatchClosed
	}
	day, week, _ := GameCalendar(now)
	run := MatchRun{ID: common.GetUUID(), UserID: userID, Mode: mode, Day: day, Week: week, Status: matchRunning, StartedAt: now.UnixMilli(), UpdatedAt: now.UnixMilli()}
	var state tokengame.MatchState
	if mode == matchModeDaily {
		// A daily left running from an earlier day is finished first.
		var previous MatchRun
		err := DB.Where("user_id = ? AND mode = ? AND status = ?", userID, mode, matchRunning).Order("started_at DESC").First(&previous).Error
		if err == nil {
			return matchView(&previous, now)
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, err
		}
		run.Slot = "daily:" + day
		run.Seed = int64(crc32.ChecksumIEEE([]byte("match3-daily-v1:" + day)))
		run.Unlocks = tokengame.MatchUnlockReveal | tokengame.MatchUnlockUndo | tokengame.MatchUnlockShuffle
		state = tokengame.NewMatch(uint32(run.Seed), tokengame.MatchModeDaily, run.Unlocks)
	} else {
		var profile MatchProfile
		if err := DB.Where("user_id = ?", userID).Limit(1).Find(&profile).Error; err != nil {
			return nil, err
		}
		run.Slot = "endless:active"
		run.Seed = int64(common.GetRandomInt(math.MaxInt32) + 1)
		run.Unlocks = matchEndlessUnlocks(profile.BestLevel)
		state = tokengame.NewMatch(uint32(run.Seed), tokengame.MatchModeEndless, run.Unlocks)
	}
	run.Level = state.Level
	data, err := common.Marshal(state)
	if err != nil {
		return nil, err
	}
	run.StateJSON = string(data)
	err = DB.Transaction(func(tx *gorm.DB) error {
		result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&run)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			var existing MatchRun
			if err := tx.Where("user_id = ? AND slot = ?", userID, run.Slot).First(&existing).Error; err != nil {
				return err
			}
			run = existing
			return nil
		}
		if mode != matchModeEndless || !settings.Match3RewardsEnabled {
			return nil
		}
		period := settings.match3Period(week)
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&period).Error; err != nil {
			return err
		}
		if err := lockForUpdate(tx).First(&period, "id = ?", period.ID).Error; err != nil {
			return err
		}
		if period.rewardRulesInitialized() {
			return nil
		}
		period = settings.match3Period(week)
		return tx.Save(&period).Error
	})
	if err != nil {
		return nil, err
	}
	return matchView(&run, now)
}

// finishMatchRun closes a run inside the caller's transaction, which already
// holds the run row lock. finishedAt is when the player last acted, not when the
// sweep gave up on the run, because it breaks ties between equal weekly scores.
// It records the result, banks the score on the board
// (keeping the best score; ties keep the earlier one), rewrites the endless slot
// and, for endless runs, updates the player's profile. Lock order is run, rank,
// profile; the weekly period and the user wallet are only touched by settlement.
func finishMatchRun(tx *gorm.DB, run *MatchRun, state *tokengame.MatchState, status string, finishedAt time.Time) error {
	run.Status = status
	run.FinishedAt = finishedAt.UnixMilli()
	run.Score = state.Score
	run.Level = state.Level
	if run.Mode == matchModeEndless {
		run.Slot = "endless:" + run.ID
	}
	if state.Score > 0 {
		board := "daily:" + run.Day
		if run.Mode == matchModeEndless {
			board = "weekly:" + run.Week
		}
		fresh := MatchRank{Board: board, UserID: run.UserID, Score: state.Score, Level: state.Level, AchievedAt: finishedAt.UnixMilli()}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&fresh).Error; err != nil {
			return err
		}
		var rank MatchRank
		if err := lockForUpdate(tx).Where("board = ? AND user_id = ?", board, run.UserID).First(&rank).Error; err != nil {
			return err
		}
		if state.Score > rank.Score {
			if err := tx.Model(&rank).Updates(map[string]any{"score": state.Score, "level": state.Level, "achieved_at": finishedAt.UnixMilli()}).Error; err != nil {
				return err
			}
		}
	}
	if run.Mode != matchModeEndless {
		return nil
	}
	cleared := state.Level - 1
	if state.Status == tokengame.MatchCompleted {
		cleared = state.Level
	}
	gained := 20*cleared + 5*cleared*(cleared+1)/2
	profile := MatchProfile{UserID: run.UserID}
	if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&profile).Error; err != nil {
		return err
	}
	if err := lockForUpdate(tx).First(&profile, "user_id = ?", run.UserID).Error; err != nil {
		return err
	}
	return tx.Model(&profile).Updates(map[string]any{"best_level": max(profile.BestLevel, cleared), "xp": profile.XP + gained, "runs": profile.Runs + 1}).Error
}

// AdvanceMatch locks a user's run and accepts a bounded, append-only input
// batch. Retries return the committed state and apply only the unacknowledged
// suffix. The claimed clock may not run ahead of the wall clock.
func AdvanceMatch(userID int, id string, from int, inputs []int, quit bool, now time.Time) (*MatchView, error) {
	if len(inputs) > tokengame.MaxInputBatch || from < 0 {
		return nil, ErrMatchInput
	}
	for _, input := range inputs {
		if !tokengame.ValidMatchInput(input) {
			return nil, ErrMatchInput
		}
	}
	settings, err := GetGameSettings()
	if err != nil {
		return nil, err
	}
	// A closed game only lets a player resign, so an administrator closing it
	// stops a run that is in flight.
	if !matchOpen(settings) && (!quit || len(inputs) > 0) {
		return nil, ErrMatchClosed
	}
	var view *MatchView
	err = DB.Transaction(func(tx *gorm.DB) error {
		var run MatchRun
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&run).Error; err != nil {
			return err
		}
		var err error
		view, err = matchView(&run, now)
		if err != nil {
			return err
		}
		state := &view.State
		if run.Status != matchRunning || from > state.Inputs {
			return nil
		}
		suffix := inputs[min(len(inputs), state.Inputs-from):]
		elapsed := max(int64(0), (now.UnixMilli()-run.StartedAt)/tokengame.TickMillis)
		// The claimed clock also may not fall behind the wall clock by more than
		// the slack, otherwise a client could claim 200ms between picks made
		// seconds apart and keep a combo alive forever. The shortfall is waited
		// out before the batch, which breaks the combo exactly as real idle time does.
		claimed := 0
		for _, input := range suffix {
			claimed += input >> 10
		}
		if shortfall := elapsed - matchClockSlackTicks - int64(state.Clock+claimed); shortfall > 0 && len(suffix) > 0 {
			state.Clock += int(shortfall) + matchClockCatchUpTicks
		}
		applied := false
		for _, input := range suffix {
			if !state.Apply(input) {
				break
			}
			applied = true
		}
		if state.Inputs > tokengame.MatchMaxInputs || int64(state.Clock) > elapsed+2 {
			return ErrMatchInput
		}
		if !applied && !quit {
			return nil
		}
		run.Score, run.Level, run.UpdatedAt = state.Score, state.Level, now.UnixMilli()
		switch {
		case state.Status == tokengame.MatchCompleted:
			err = finishMatchRun(tx, &run, state, "completed", now)
		case state.Status == tokengame.MatchLost:
			err = finishMatchRun(tx, &run, state, "lost", now)
		case quit:
			err = finishMatchRun(tx, &run, state, "abandoned", now)
		}
		if err != nil {
			return err
		}
		data, err := common.Marshal(state)
		if err != nil {
			return err
		}
		run.StateJSON = string(data)
		return tx.Save(&run).Error
	})
	if err != nil {
		return nil, err
	}
	return view, nil
}

// GetMatchRanking returns the best score per player on the daily board or the
// weekly endless board.
func GetMatchRanking(userID int, mode string, now time.Time) ([]GameRank, error) {
	day, week, _ := GameCalendar(now)
	board := "daily:" + day
	switch mode {
	case matchModeDaily:
	case matchModeEndless:
		board = "weekly:" + week
	default:
		return nil, ErrMatchInput
	}
	rows, found, err := cachedGameRanking("match3:"+board, userID, func() ([]GameRank, error) {
		rows := []GameRank{}
		err := DB.Table("match_ranks").Select("match_ranks.user_id, COALESCE(NULLIF(users.display_name, ''), 'Player') AS name, match_ranks.score, match_ranks.level").Joins("JOIN users ON users.id = match_ranks.user_id AND users.deleted_at IS NULL AND users.status = ?", common.UserStatusEnabled).Where("match_ranks.board = ?", board).Order("match_ranks.score DESC, match_ranks.achieved_at ASC, match_ranks.user_id ASC").Limit(gameRankingLimit).Scan(&rows).Error
		for i := range rows {
			rows[i].Rank = i + 1
		}
		return rows, err
	})
	if err != nil || found || len(rows) < gameRankingLimit {
		return rows, err
	}
	var own []GameRank
	err = DB.Table("match_ranks").Select("match_ranks.user_id, COALESCE(NULLIF(users.display_name, ''), 'Player') AS name, match_ranks.score, match_ranks.level, match_ranks.achieved_at AS finished_at").Joins("JOIN users ON users.id = match_ranks.user_id AND users.deleted_at IS NULL AND users.status = ?", common.UserStatusEnabled).Where("match_ranks.board = ? AND match_ranks.user_id = ?", board, userID).Scan(&own).Error
	if err != nil || len(own) == 0 {
		return rows, err
	}
	var ahead int64
	err = DB.Table("match_ranks").Joins("JOIN users ON users.id = match_ranks.user_id AND users.deleted_at IS NULL AND users.status = ?", common.UserStatusEnabled).Where("match_ranks.board = ? AND (match_ranks.score > ? OR (match_ranks.score = ? AND match_ranks.achieved_at < ?) OR (match_ranks.score = ? AND match_ranks.achieved_at = ? AND match_ranks.user_id < ?))", board, own[0].Score, own[0].Score, own[0].FinishedAt, own[0].Score, own[0].FinishedAt, userID).Count(&ahead).Error
	if err != nil {
		return rows, err
	}
	own[0].Rank, own[0].IsMe = int(ahead)+1, true
	return append(rows, own[0]), nil
}

// SettleMatchWeek pays the weekly ranked endless podium once, after the week
// has ended. The ledger key makes every payment idempotent.
func SettleMatchWeek(week string, now time.Time) error {
	start, err := time.ParseInLocation("2006-01-02", week, gameZone)
	if err != nil {
		return err
	}
	if now.Before(start.AddDate(0, 0, 7).Add(5 * time.Minute)) {
		return nil
	}
	// The kill switches defer the payout instead of voiding it: the week stays
	// unsettled and is paid once the game and its rewards are switched on again.
	settings, err := GetGameSettings()
	if err != nil {
		return err
	}
	if !matchOpen(settings) || !settings.Match3RewardsEnabled {
		return nil
	}
	credits := map[int]int{}
	err = DB.Transaction(func(tx *gorm.DB) error {
		var period GamePeriod
		if err := lockForUpdate(tx).First(&period, "id = ?", "match3:"+week).Error; err != nil {
			return err
		}
		if period.Settled {
			return nil
		}
		var rows []GameRank
		err := tx.Table("match_ranks").Select("match_ranks.user_id").Joins("JOIN users ON users.id = match_ranks.user_id AND users.deleted_at IS NULL AND users.status = ?", common.UserStatusEnabled).Where("match_ranks.board = ?", "weekly:"+week).Order("match_ranks.score DESC, match_ranks.achieved_at ASC, match_ranks.user_id ASC").Limit(3).Scan(&rows).Error
		if err != nil {
			return err
		}
		prizes := period.weeklyPrizes()
		for i, row := range rows {
			if prizes[i] == 0 {
				continue
			}
			ok, err := creditGameReward(tx, fmt.Sprintf("match3:%s:%d", week, row.UserID), row.UserID, prizes[i], now)
			if err != nil {
				return err
			}
			if ok {
				period.Spent += prizes[i]
				credits[row.UserID] += prizes[i]
			}
		}
		period.Settled = true
		return tx.Save(&period).Error
	})
	if err == nil {
		for userID, amount := range credits {
			syncCreditUserQuotaCache(userID, amount, "weekly tile game")
			RecordLog(userID, LogTypeSystem, common.NewMessage("Weekly tile game reward: {{quota}}", map[string]any{"quota": logger.FormatQuota(amount)}))
		}
	}
	return err
}

// MaintainMatch gives up on runs left running for a day, then settles every
// finished week that has no running endless run left.
func MaintainMatch(now time.Time) error {
	var maintenanceErrors []error
	cutoff := now.Add(-matchRunAbandonAfter).UnixMilli()
	var lastStarted int64
	lastID := ""
	for range 50 {
		var runs []MatchRun
		query := DB.Where("status = ? AND started_at < ?", matchRunning, cutoff)
		if lastID != "" {
			query = query.Where("started_at > ? OR (started_at = ? AND id > ?)", lastStarted, lastStarted, lastID)
		}
		if err := query.Order("started_at ASC, id ASC").Limit(200).Find(&runs).Error; err != nil {
			return errors.Join(append(maintenanceErrors, err)...)
		}
		for _, stale := range runs {
			err := guardGameMaintenance("match3 run "+stale.ID, func() error {
				return DB.Transaction(func(tx *gorm.DB) error {
					var run MatchRun
					if err := lockForUpdate(tx).First(&run, "id = ?", stale.ID).Error; err != nil {
						return err
					}
					if run.Status != matchRunning {
						return nil
					}
					view, err := matchView(&run, now)
					if err != nil {
						return err
					}
					if err := finishMatchRun(tx, &run, &view.State, "abandoned", time.UnixMilli(run.UpdatedAt)); err != nil {
						return err
					}
					return tx.Save(&run).Error
				})
			})
			if err != nil {
				maintenanceErrors = append(maintenanceErrors, fmt.Errorf("abandon tile game run %s (user %d, week %s): %w", stale.ID, stale.UserID, stale.Week, err))
			}
		}
		if len(runs) < 200 {
			break
		}
		lastStarted, lastID = runs[len(runs)-1].StartedAt, runs[len(runs)-1].ID
	}
	var periods []GamePeriod
	if err := DB.Where("id LIKE ? AND settled = ?", "match3:%", false).Find(&periods).Error; err != nil {
		return errors.Join(append(maintenanceErrors, fmt.Errorf("list unsettled tile game weeks: %w", err))...)
	}
	for _, p := range periods {
		week := p.ID[len("match3:"):]
		err := guardGameMaintenance("match3 week "+week, func() error {
			var count int64
			if err := DB.Model(&MatchRun{}).Where("week = ? AND mode = ? AND status = ?", week, matchModeEndless, matchRunning).Count(&count).Error; err != nil {
				return fmt.Errorf("count running tile games for week %s: %w", week, err)
			}
			if count > 0 {
				return nil
			}
			if err := SettleMatchWeek(week, now); err != nil {
				return fmt.Errorf("settle tile game week %s: %w", week, err)
			}
			return nil
		})
		if err != nil {
			maintenanceErrors = append(maintenanceErrors, err)
		}
	}
	return errors.Join(maintenanceErrors...)
}
