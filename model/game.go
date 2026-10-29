package model

import (
	"errors"
	"fmt"
	"hash/crc32"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/pkg/tokengame"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var gameZone = time.FixedZone("UTC+8", 8*60*60)
var ErrGameClosed = errors.New("The daily challenge is currently closed")
var ErrGameInput = errors.New("Game progress is out of sync. Reconnect to continue the same run")
var ErrGameBudget = errors.New("The daily reward budget cannot cover another run")
var ErrGameSettings = errors.New("Invalid game reward settings")
var gameSettingsMutex sync.Mutex

// One unique daily attempt per account, enforced by the database on every instance.
type GameRun struct {
	ID                   string `gorm:"type:varchar(40);primaryKey" json:"id"`
	UserID               int    `gorm:"uniqueIndex:idx_game_daily_attempt;index" json:"-"`
	Day                  string `gorm:"type:varchar(10);uniqueIndex:idx_game_daily_attempt;index" json:"day"`
	Week                 string `gorm:"type:varchar(10);index" json:"week"`
	StartedAt            int64  `gorm:"index" json:"started_at"`
	FinishedAt           int64  `json:"finished_at"`
	Status               string `gorm:"type:varchar(16);index" json:"status"`
	StateJSON            string `gorm:"type:text" json:"-"`
	Score                int    `json:"score"`
	QuotaAwarded         int    `json:"quota_awarded"`
	RewardVersion        int    `json:"reward_version"`
	FirstTokenQuota      int    `json:"first_token_quota"`
	SubsequentTokenQuota int    `json:"subsequent_token_quota"`
	ReservedQuota        int    `json:"-"`
}
type GamePeriod struct {
	WeeklyRewardVersion  int    `gorm:"not null;default:0"`
	WeeklyFirstQuota     int    `gorm:"not null;default:0"`
	WeeklySecondQuota    int    `gorm:"not null;default:0"`
	WeeklyThirdQuota     int    `gorm:"not null;default:0"`
	RewardsInitialized   bool   `gorm:"not null;default:false"`
	ID                   string `gorm:"type:varchar(20);primaryKey"`
	Budget               int
	Spent                int
	DailyQuota           int
	Reserved             int
	FirstTokenQuota      int
	SubsequentTokenQuota int
	Settled              bool
}

// Legacy periods did not record whether rewards had ever been enabled.
// Preserve any existing financial terms, reservations, spending or settlement;
// only a wholly empty disabled period can acquire its first reward rules.
func (period GamePeriod) rewardRulesInitialized() bool {
	return period.RewardsInitialized || period.WeeklyFirstQuota != 0 || period.WeeklySecondQuota != 0 || period.WeeklyThirdQuota != 0 || period.Budget != 0 || period.Spent != 0 ||
		period.Reserved != 0 || period.DailyQuota != 0 || period.FirstTokenQuota != 0 ||
		period.SubsequentTokenQuota != 0 || period.Settled
}

type GameReward struct {
	ID        string `gorm:"type:varchar(80);primaryKey"`
	UserID    int    `gorm:"index"`
	Quota     int
	CreatedAt int64
}
type GameSettings struct {
	WeeklyRewardVersion  int  `json:"weekly_reward_version"`
	WeeklyFirstQuota     int  `json:"weekly_first_quota"`
	WeeklySecondQuota    int  `json:"weekly_second_quota"`
	WeeklyThirdQuota     int  `json:"weekly_third_quota"`
	Enabled              bool `json:"enabled"`
	RewardsEnabled       bool `json:"rewards_enabled"`
	DailyQuota           int  `json:"daily_quota"`
	DailyBudget          int  `json:"daily_budget"`
	WeeklyBudget         int  `json:"weekly_budget"`
	RewardVersion        int  `json:"reward_version"`
	FirstTokenQuota      int  `json:"first_token_quota"`
	SubsequentTokenQuota int  `json:"subsequent_token_quota"`
	PvpEnabled           bool `json:"pvp_enabled"`
	PvpMinStake          int  `json:"pvp_min_stake"`
	PvpMaxStake          int  `json:"pvp_max_stake"`
}

// PvpStakeBounds returns the effective PvP stake window, substituting the
// defaults for unset (zero) values the same way normalization does.
func (settings GameSettings) PvpStakeBounds() (int, int) {
	minStake, maxStake := settings.PvpMinStake, settings.PvpMaxStake
	if minStake == 0 {
		minStake = common.QuotaRound(common.QuotaPerUnit / 10)
	}
	if maxStake == 0 {
		maxStake = common.QuotaRound(100 * common.QuotaPerUnit)
	}
	return minStake, maxStake
}

func normalizeGameSettings(settings GameSettings) GameSettings {
	if settings.RewardVersion == 0 {
		settings.RewardVersion = 2
	}
	if settings.WeeklyRewardVersion == 0 {
		settings.WeeklyRewardVersion = 1
	}
	// PvP stake bounds keep their defaults until configured; the enabled flag
	// itself is a plain bool so an unset value means disabled.
	settings.PvpMinStake, settings.PvpMaxStake = settings.PvpStakeBounds()
	if settings.WeeklyRewardVersion == 1 {
		settings.WeeklyFirstQuota = int(int64(settings.WeeklyBudget) * 30 / 100)
		settings.WeeklySecondQuota = int(int64(settings.WeeklyBudget) * 20 / 100)
		settings.WeeklyThirdQuota = int(int64(settings.WeeklyBudget) * 15 / 100)
	} else {
		settings.WeeklyBudget = settings.WeeklyFirstQuota + settings.WeeklySecondQuota + settings.WeeklyThirdQuota
	}
	return settings
}

func (settings GameSettings) weeklyPeriod(week string) GamePeriod {
	period := GamePeriod{ID: "week:" + week, WeeklyRewardVersion: max(1, settings.WeeklyRewardVersion)}
	if !settings.RewardsEnabled {
		return period
	}
	period.RewardsInitialized = true
	if period.WeeklyRewardVersion >= 2 {
		period.WeeklyFirstQuota, period.WeeklySecondQuota, period.WeeklyThirdQuota = settings.WeeklyFirstQuota, settings.WeeklySecondQuota, settings.WeeklyThirdQuota
		period.Budget = period.WeeklyFirstQuota + period.WeeklySecondQuota + period.WeeklyThirdQuota
	} else {
		period.Budget = settings.WeeklyBudget
	}
	return period
}

func (period GamePeriod) weeklyPrizes() []int {
	if period.WeeklyRewardVersion >= 2 {
		return []int{period.WeeklyFirstQuota, period.WeeklySecondQuota, period.WeeklyThirdQuota}
	}
	percentages := []int{30, 20, 15}
	prizes := make([]int, len(percentages))
	for i, percentage := range percentages {
		prizes[i] = int(int64(period.Budget) * int64(percentage) / 100)
	}
	return prizes
}

func GetGameSettings() (GameSettings, error) {
	settings := GameSettings{Enabled: true, RewardVersion: 2, WeeklyRewardVersion: 1, FirstTokenQuota: common.QuotaRound(5 * common.QuotaPerUnit), SubsequentTokenQuota: common.QuotaRound(common.QuotaPerUnit / 2), DailyBudget: 0, WeeklyBudget: 50000, PvpEnabled: true, PvpMinStake: common.QuotaRound(common.QuotaPerUnit / 10), PvpMaxStake: common.QuotaRound(100 * common.QuotaPerUnit)}
	var option Option
	err := DB.Where(&Option{Key: "game_center"}).First(&option).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return settings, err
	}
	if err == nil {
		if err = common.Unmarshal([]byte(option.Value), &settings); err != nil {
			return settings, err
		}
	}
	if err = ValidateGameSettings(settings); err != nil {
		return settings, err
	}
	return normalizeGameSettings(settings), nil
}

// GameBudgetView reports frozen reward rules once active, or the current
// configuration before the first reward-enabled run initializes the day.
type GameBudgetView struct {
	WeeklyRewardVersion  int  `json:"weekly_reward_version"`
	WeeklyFirstQuota     int  `json:"weekly_first_quota"`
	WeeklySecondQuota    int  `json:"weekly_second_quota"`
	WeeklyThirdQuota     int  `json:"weekly_third_quota"`
	WeeklyRewardsEnabled bool `json:"weekly_rewards_enabled"`
	DailyQuota           int  `json:"daily_quota"`
	DailyRemaining       int  `json:"daily_remaining"`
	WeeklyPool           int  `json:"weekly_pool"`
	FirstTokenQuota      int  `json:"first_token_quota"`
	SubsequentTokenQuota int  `json:"subsequent_token_quota"`
	DailyReserved        int  `json:"daily_reserved"`
	Unlimited            bool `json:"unlimited"`
	MaxRunReward         int  `json:"max_run_reward"`
	CanStart             bool `json:"can_start"`
}

func GetGameBudgets(settings GameSettings, now time.Time) (GameBudgetView, error) {
	day, week, _ := GameCalendar(now)
	view := GameBudgetView{CanStart: true}
	weekly := settings.weeklyPeriod(week)
	dayID := "day:" + day
	if settings.RewardVersion >= 2 {
		dayID = "token:" + day
		view.Unlimited = settings.DailyBudget == 0
	}
	if settings.RewardsEnabled {
		view.DailyQuota = settings.DailyQuota
		view.DailyRemaining = settings.DailyBudget
		view.FirstTokenQuota = settings.FirstTokenQuota
		view.SubsequentTokenQuota = settings.SubsequentTokenQuota
	}
	var periods []GamePeriod
	if err := DB.Where("id IN ?", []string{dayID, "week:" + week}).Find(&periods).Error; err != nil {
		return view, err
	}
	for _, p := range periods {
		if p.ID == dayID {
			if settings.RewardVersion >= 2 && !p.rewardRulesInitialized() {
				continue
			}
			view.DailyQuota = p.DailyQuota
			view.DailyReserved = p.Reserved
			view.DailyRemaining = max(0, p.Budget-p.Spent-p.Reserved)
			view.FirstTokenQuota = p.FirstTokenQuota
			view.SubsequentTokenQuota = p.SubsequentTokenQuota
			view.Unlimited = settings.RewardVersion >= 2 && p.Budget == 0
		} else {
			weekly = p
		}
	}
	prizes := weekly.weeklyPrizes()
	view.WeeklyPool = prizes[0] + prizes[1] + prizes[2]
	view.WeeklyRewardVersion = max(1, weekly.WeeklyRewardVersion)
	view.WeeklyFirstQuota, view.WeeklySecondQuota, view.WeeklyThirdQuota = prizes[0], prizes[1], prizes[2]
	view.WeeklyRewardsEnabled = weekly.rewardRulesInitialized()
	if settings.RewardVersion >= 2 {
		view.MaxRunReward = GameTokenReward(tokengame.SprintMaxTokens, view.FirstTokenQuota, view.SubsequentTokenQuota)
		view.CanStart = view.Unlimited || view.DailyRemaining >= view.MaxRunReward
	}

	if !settings.RewardsEnabled && settings.RewardVersion >= 2 {
		view.FirstTokenQuota = 0
		view.SubsequentTokenQuota = 0
		view.MaxRunReward = 0
		view.CanStart = true
	}
	return view, nil
}
func ValidateGameSettings(settings GameSettings) error {
	if settings.WeeklyRewardVersion < 0 || settings.WeeklyRewardVersion > 2 || settings.WeeklyFirstQuota < 0 || settings.WeeklySecondQuota < 0 || settings.WeeklyThirdQuota < 0 || settings.WeeklyFirstQuota > 1000000000 || settings.WeeklySecondQuota > 1000000000 || settings.WeeklyThirdQuota > 1000000000 {
		return ErrGameSettings
	}
	if settings.WeeklyRewardVersion == 2 && int64(settings.WeeklyFirstQuota)+int64(settings.WeeklySecondQuota)+int64(settings.WeeklyThirdQuota) > 1000000000 {
		return ErrGameSettings
	}
	if settings.DailyQuota < 0 || settings.DailyQuota > 10000000 || settings.DailyBudget < 0 || settings.DailyBudget > 1000000000 || settings.WeeklyBudget < 0 || settings.WeeklyBudget > 1000000000 || (settings.RewardVersion == 1 && settings.DailyQuota > settings.DailyBudget) {
		return ErrGameSettings
	}
	if settings.RewardVersion == 0 {
		settings.RewardVersion = 2
	}
	if settings.RewardVersion != 1 && settings.RewardVersion != 2 {
		return ErrGameSettings
	}
	if settings.FirstTokenQuota < 0 || settings.SubsequentTokenQuota < 0 || settings.FirstTokenQuota > 1000000000 || settings.SubsequentTokenQuota > 1000000000 || int64(settings.FirstTokenQuota)+int64(tokengame.MaxTokens-1)*int64(settings.SubsequentTokenQuota) > 1000000000 {
		return ErrGameSettings
	}
	// PvP stakes use the effective bounds so unset values validate as defaults.
	minStake, maxStake := settings.PvpStakeBounds()
	if minStake < 0 || maxStake < 0 || minStake > maxStake || settings.PvpMinStake > common.MaxWalletQuota || settings.PvpMaxStake > common.MaxWalletQuota {
		return ErrGameSettings
	}

	return nil
}
func SaveGameSettings(settings GameSettings) error {
	return saveGameSettingsAt(settings, time.Now())
}
func saveGameSettingsAt(settings GameSettings, now time.Time) error {
	if err := ValidateGameSettings(settings); err != nil {
		return err
	}
	settings = normalizeGameSettings(settings)
	value, err := common.Marshal(settings)
	if err != nil {
		return err
	}
	gameSettingsMutex.Lock()
	defer gameSettingsMutex.Unlock()
	err = DB.Transaction(func(tx *gorm.DB) error {
		option := Option{Key: "game_center", Value: string(value)}
		if err := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "key"}}, DoUpdates: clause.AssignmentColumns([]string{"value"})}).Create(&option).Error; err != nil {
			return err
		}
		if settings.WeeklyRewardVersion < 2 {
			return nil
		}
		_, week, _ := GameCalendar(now)
		period := GamePeriod{ID: "week:" + week, WeeklyRewardVersion: 2}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&period).Error; err != nil {
			return err
		}
		if err := lockForUpdate(tx).First(&period, "id = ?", period.ID).Error; err != nil {
			return err
		}
		if period.Settled || (!settings.RewardsEnabled && !period.rewardRulesInitialized()) {
			return nil
		}
		if period.Spent != 0 {
			return ErrGameSettings
		}
		period.WeeklyRewardVersion = 2
		period.WeeklyFirstQuota, period.WeeklySecondQuota, period.WeeklyThirdQuota = settings.WeeklyFirstQuota, settings.WeeklySecondQuota, settings.WeeklyThirdQuota
		period.Budget = settings.WeeklyBudget
		period.RewardsInitialized = true
		return tx.Save(&period).Error
	})
	if err != nil {
		return err
	}
	return updateOptionMap("game_center", string(value))
}
func GameTokenReward(count, first, subsequent int) int {
	if count <= 0 {
		return 0
	}
	return first + (min(count, tokengame.MaxTokens)-1)*subsequent
}
func GameCalendar(now time.Time) (day, week string, reset int64) {
	local := now.In(gameZone)
	day = local.Format("2006-01-02")
	midnight := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, gameZone)
	week = midnight.AddDate(0, 0, -(int(local.Weekday())+6)%7).Format("2006-01-02")
	return day, week, midnight.AddDate(0, 0, 1).UnixMilli()
}

type GameView struct {
	*GameRun
	State      tokengame.State `json:"state"`
	ServerTime int64           `json:"server_time"`
}

func gameView(run *GameRun, now time.Time) (*GameView, error) {
	view := &GameView{GameRun: run, ServerTime: now.UnixMilli()}
	err := common.Unmarshal([]byte(run.StateJSON), &view.State)
	// Version-one runs stored token values; every kill dropped exactly one item
	// and the 200-item capacity exceeded the 187 possible drops.
	if err == nil && view.State.PickedTokens == 0 && view.State.Collected > 0 {
		view.State.PickedTokens = view.State.Kills - len(view.State.Tokens)
	}
	if err == nil && (view.State.Version < 1 || view.State.Version > tokengame.Version) {
		err = ErrGameInput
	}
	return view, err
}
func GetTodayGame(userID int, now time.Time) (*GameView, error) {
	day, _, _ := GameCalendar(now)
	var run GameRun
	// A run started before midnight keeps its original daily slot until it ends.
	err := DB.Where("user_id = ? AND (day = ? OR status = ?)", userID, day, "running").Order("started_at DESC").First(&run).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if run.Status == "running" {
		view, err := AdvanceGame(userID, run.ID, -1, nil, false, now)
		if err == nil && view.Day != day && view.Status != "running" {
			return nil, nil
		}
		return view, err
	}
	return gameView(&run, now)
}
func StartGame(userID int, now time.Time) (*GameView, error) {
	settings, err := GetGameSettings()
	if err != nil {
		return nil, err
	}
	if !settings.Enabled {
		return nil, ErrGameClosed
	}
	day, week, _ := GameCalendar(now)
	previous, err := GetTodayGame(userID, now)
	if err != nil {
		return nil, err
	}
	if previous != nil && (previous.Day == day || previous.Status == "running") {
		return previous, nil
	}
	state := tokengame.New(crc32.ChecksumIEEE([]byte("token-survivor-v1:" + day)))
	data, _ := common.Marshal(state)
	run := GameRun{ID: common.GetUUID(), UserID: userID, Day: day, Week: week, StartedAt: now.UnixMilli(), Status: "running", StateJSON: string(data), RewardVersion: settings.RewardVersion}
	err = DB.Transaction(func(tx *gorm.DB) error {
		result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&run)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return tx.Where("user_id = ? AND day = ?", userID, day).First(&run).Error
		}
		daily := GamePeriod{ID: "day:" + day}
		weekly := settings.weeklyPeriod(week)
		if settings.RewardVersion >= 2 {
			daily.ID = "token:" + day
		}
		if settings.RewardsEnabled {
			daily.RewardsInitialized = settings.RewardVersion >= 2
			daily.Budget = settings.DailyBudget
			daily.DailyQuota = settings.DailyQuota
			daily.FirstTokenQuota = settings.FirstTokenQuota
			daily.SubsequentTokenQuota = settings.SubsequentTokenQuota
		}
		for _, period := range []*GamePeriod{&daily, &weekly} {
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(period).Error; err != nil {
				return err
			}
		}
		if settings.WeeklyRewardVersion >= 2 && settings.RewardsEnabled {
			if err := lockForUpdate(tx).First(&weekly, "id = ?", weekly.ID).Error; err != nil {
				return err
			}
			if !weekly.rewardRulesInitialized() {
				weekly = settings.weeklyPeriod(week)
				if err := tx.Save(&weekly).Error; err != nil {
					return err
				}
			}
		}
		if settings.RewardVersion >= 2 {
			if err := lockForUpdate(tx).First(&daily, "id = ?", daily.ID).Error; err != nil {
				return err
			}
			if settings.RewardsEnabled && !daily.rewardRulesInitialized() {
				daily.RewardsInitialized = true
				daily.Budget = settings.DailyBudget
				daily.DailyQuota = settings.DailyQuota
				daily.FirstTokenQuota = settings.FirstTokenQuota
				daily.SubsequentTokenQuota = settings.SubsequentTokenQuota
				if err := tx.Save(&daily).Error; err != nil {
					return err
				}
			}
			run.FirstTokenQuota = daily.FirstTokenQuota
			run.SubsequentTokenQuota = daily.SubsequentTokenQuota
			if !settings.RewardsEnabled {
				run.FirstTokenQuota = 0
				run.SubsequentTokenQuota = 0
			}
			maximum := GameTokenReward(tokengame.SprintMaxTokens, run.FirstTokenQuota, run.SubsequentTokenQuota)
			if daily.Budget > 0 {
				if daily.Budget-daily.Spent-daily.Reserved < maximum {
					return ErrGameBudget
				}
				run.ReservedQuota = maximum
				if err := tx.Model(&daily).Update("reserved", daily.Reserved+maximum).Error; err != nil {
					return err
				}
			}
			return tx.Save(&run).Error
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return gameView(&run, now)
}

// AdvanceGame locks a user's run and accepts a bounded, append-only input batch.
// Retries return committed state and apply only unacknowledged input suffixes.
// Gaps beyond the input window use neutral inputs; disconnects do not pause time.
func AdvanceGame(userID int, id string, from int, inputs []int, quit bool, now time.Time) (*GameView, error) {
	if len(inputs) > tokengame.MaxInputBatch || from < -1 {
		return nil, ErrGameInput
	}
	for _, input := range inputs {
		if !tokengame.ValidInput(input) {
			return nil, ErrGameInput
		}
	}
	var view *GameView
	credited := 0
	err := DB.Transaction(func(tx *gorm.DB) error {
		var run GameRun
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&run).Error; err != nil {
			return err
		}
		var err error
		view, err = gameView(&run, now)
		if err != nil {
			return err
		}
		if run.Status != "running" {
			return nil
		}
		state := &view.State
		elapsed := max(int64(0), (now.UnixMilli()-run.StartedAt)/tokengame.TickMillis)
		allowed := int(min(int64(state.ClockLimit()), elapsed))
		expired := elapsed >= int64(state.ClockLimit()+tokengame.MaxInputBatch)
		if from == -1 || allowed-state.Cursor() > tokengame.MaxInputBatch || expired {
			for state.Cursor() < allowed && !state.Done() {
				state.Step(0)
			}
		} else if from <= state.Cursor() {
			if from+len(inputs) > allowed+2 {
				return ErrGameInput
			}
			acknowledged := min(len(inputs), state.Cursor()-from)
			for _, input := range inputs[acknowledged:] {
				state.Step(input)
			}
		} else {
			return nil
		}
		if quit {
			for state.Cursor() < allowed && !state.Done() {
				state.Step(0)
			}
		}
		if state.Done() || quit {
			run.Status = "defeated"
			if state.Tick >= state.Duration() && state.HP > 0 {
				run.Status = "survived"
			}
			if quit {
				run.Status = "abandoned"
			}
			run.Score = state.Score
			run.FinishedAt = now.UnixMilli()
			if run.RewardVersion >= 2 {
				var period GamePeriod
				if err := lockForUpdate(tx).First(&period, "id = ?", "token:"+run.Day).Error; err != nil {
					return err
				}
				if state.PickedTokens < 0 || state.PickedTokens > tokengame.MaxTokens {
					return ErrGameInput
				}
				amount := GameTokenReward(state.PickedTokens, run.FirstTokenQuota, run.SubsequentTokenQuota)
				if period.Budget > 0 && (amount > run.ReservedQuota || period.Reserved < run.ReservedQuota) {
					return ErrGameBudget
				}
				if amount > 0 {
					ok, err := creditGameReward(tx, "run:"+run.ID, userID, amount, now)
					if err != nil {
						return err
					}
					if ok {
						credited = amount
						run.QuotaAwarded = amount
						period.Spent += amount
					}
				}
				period.Reserved -= run.ReservedQuota
				run.ReservedQuota = 0
				if err := tx.Save(&period).Error; err != nil {
					return err
				}
			}
			// Existing version-one runs retain their original fixed reward.

			if run.RewardVersion < 2 && !quit && state.Tick >= 300 && state.Kills >= 3 {
				var period GamePeriod
				if err := lockForUpdate(tx).First(&period, "id = ?", "day:"+run.Day).Error; err != nil {
					return err
				}
				amount := min(period.DailyQuota, max(0, period.Budget-period.Spent))
				if amount > 0 {
					ok, err := creditGameReward(tx, "run:"+run.ID, userID, amount, now)
					if err != nil {
						return err
					}
					if ok {
						credited = amount
						run.QuotaAwarded = amount
						if err := tx.Model(&period).Update("spent", period.Spent+amount).Error; err != nil {
							return err
						}
					}
				}
			}
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
	if credited > 0 {
		syncCreditUserQuotaCache(userID, credited, "daily game")
		RecordLog(userID, LogTypeSystem, common.NewMessage("Daily game reward: {{quota}}", map[string]any{"quota": logger.FormatQuota(credited)}))
	}
	return view, nil
}
func creditGameReward(tx *gorm.DB, key string, userID, amount int, now time.Time) (bool, error) {
	var user User
	if err := lockForUpdate(tx).First(&user, userID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		return false, err
	}
	if user.Status != common.UserStatusEnabled || user.Quota > common.MaxWalletQuota-amount || user.Quota < -common.MaxWalletQuota {
		return false, nil
	}
	ledger := GameReward{ID: key, UserID: userID, Quota: amount, CreatedAt: now.UnixMilli()}
	result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&ledger)
	if result.Error != nil || result.RowsAffected == 0 {
		return false, result.Error
	}
	result = tx.Model(&User{}).Where("id = ?", userID).Update("quota", gorm.Expr("quota + ?", amount))
	if result.Error != nil {
		return false, result.Error
	}
	if result.RowsAffected != 1 {
		return false, gorm.ErrRecordNotFound
	}
	return true, nil
}

type GameRank struct {
	UserID int    `json:"-"`
	Name   string `json:"name"`
	Score  int    `json:"score"`
	Runs   int    `json:"runs"`
	Rank   int    `json:"rank"`
	IsMe   bool   `gorm:"-" json:"is_me"`
}

func gameRanking(tx *gorm.DB, period string, weekly bool) ([]GameRank, error) {
	rows := []GameRank{}
	column := "day"
	if weekly {
		column = "week"
	}
	err := tx.Table("game_runs").Select("game_runs.user_id, COALESCE(NULLIF(users.display_name, ''), 'Player') AS name, SUM(game_runs.score) AS score, COUNT(*) AS runs").Joins("JOIN users ON users.id = game_runs.user_id AND users.deleted_at IS NULL AND users.status = ?", common.UserStatusEnabled).Where("game_runs."+column+" = ? AND game_runs.status IN ?", period, []string{"survived", "defeated"}).Group("game_runs.user_id, users.display_name").Order("SUM(game_runs.score) DESC, MAX(game_runs.finished_at) ASC, game_runs.user_id ASC").Limit(100).Scan(&rows).Error
	for i := range rows {
		rows[i].Rank = i + 1
	}
	return rows, err
}
func GetGameRanking(userID int, weekly bool, now time.Time) ([]GameRank, error) {
	day, week, _ := GameCalendar(now)
	period := day
	if weekly {
		period = week
	}
	rows, err := gameRanking(DB, period, weekly)
	for i := range rows {
		rows[i].IsMe = rows[i].UserID == userID
	}
	return rows, err
}
func SettleGameWeek(week string, now time.Time) error {
	start, err := time.ParseInLocation("2006-01-02", week, gameZone)
	if err != nil {
		return err
	}
	if now.Before(start.AddDate(0, 0, 7).Add(5 * time.Minute)) {
		return nil
	}
	credits := map[int]int{}
	err = DB.Transaction(func(tx *gorm.DB) error {
		var period GamePeriod
		if err := lockForUpdate(tx).First(&period, "id = ?", "week:"+week).Error; err != nil {
			return err
		}
		if period.Settled {
			return nil
		}
		rows, err := gameRanking(tx, week, true)
		if err != nil {
			return err
		}
		prizes := period.weeklyPrizes()
		for i, row := range rows {
			if i >= len(prizes) {
				break
			}
			amount := prizes[i]
			if amount == 0 {
				continue
			}
			ok, err := creditGameReward(tx, fmt.Sprintf("week:%s:%d", week, row.UserID), row.UserID, amount, now)
			if err != nil {
				return err
			}
			if ok {
				period.Spent += amount
				credits[row.UserID] += amount
			}
		}
		period.Settled = true
		return tx.Save(&period).Error
	})
	if err == nil {
		for userID, amount := range credits {
			syncCreditUserQuotaCache(userID, amount, "weekly game")
			RecordLog(userID, LogTypeSystem, common.NewMessage("Weekly game reward: {{quota}}", map[string]any{"quota": logger.FormatQuota(amount)}))
		}
	}
	return err
}
func MaintainGames(now time.Time) error {
	var maintenanceErrors []error
	var runs []GameRun
	if err := DB.Where("status = ? AND started_at < ?", "running", now.Add(-time.Duration(tokengame.SprintDuration*tokengame.TickMillis)*time.Millisecond).UnixMilli()).Order("started_at ASC").Limit(200).Find(&runs).Error; err != nil {
		return err
	}
	for _, run := range runs {
		view, err := gameView(&run, now)
		if err != nil {
			maintenanceErrors = append(maintenanceErrors, fmt.Errorf("decode game run %s (user %d, week %s): %w", run.ID, run.UserID, run.Week, err))
			continue
		}
		deadline := run.StartedAt + int64(view.State.ClockLimit()+tokengame.MaxInputBatch)*tokengame.TickMillis
		if now.UnixMilli() < deadline {
			continue
		}
		if _, err := AdvanceGame(run.UserID, run.ID, -1, nil, false, now); err != nil {
			maintenanceErrors = append(maintenanceErrors, fmt.Errorf("advance expired game run %s (user %d, week %s): %w", run.ID, run.UserID, run.Week, err))
		}
	}
	// Do not settle a week until every outstanding run has been finalized.
	var periods []GamePeriod
	if err := DB.Where("id LIKE ? AND settled = ?", "week:%", false).Find(&periods).Error; err != nil {
		maintenanceErrors = append(maintenanceErrors, fmt.Errorf("list unsettled game weeks: %w", err))
		return errors.Join(maintenanceErrors...)
	}
	for _, p := range periods {
		week := p.ID[5:]
		var count int64
		if err := DB.Model(&GameRun{}).Where("week = ? AND status = ?", week, "running").Count(&count).Error; err != nil {
			maintenanceErrors = append(maintenanceErrors, fmt.Errorf("count running games for week %s: %w", week, err))
			continue
		}
		if count == 0 {
			if err := SettleGameWeek(week, now); err != nil {
				maintenanceErrors = append(maintenanceErrors, fmt.Errorf("settle game week %s: %w", week, err))
			}
		}
	}
	return errors.Join(maintenanceErrors...)
}
func RunGameMaintenance() {
	for {
		if err := MaintainGames(time.Now()); err != nil {
			common.SysError(common.LogText("game maintenance failed: %s", err.Error()))
		}
		time.Sleep(time.Minute)
	}
}
