package model

import (
	"fmt"
	"gorm.io/gorm"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/tokengame"
	"github.com/stretchr/testify/require"
)

func TestGameDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			dsn := "local"
			if dialect == "mysql" {
				dsn = os.Getenv("TEST_MYSQL_DSN")
			}
			if dialect == "postgres" {
				dsn = os.Getenv("TEST_POSTGRES_DSN")
			}
			if dsn == "" {
				t.Skip("test database DSN not configured")
			}
			if dialect != "sqlite" && !strings.Contains(dsn, "newapi_game_test") {
				t.Fatal("game tests require the isolated newapi_game_test database")
			}
			oldPath := common.SQLitePath
			common.SQLitePath = filepath.Join(t.TempDir(), "game.db")
			defer func() { common.SQLitePath = oldPath }()
			t.Setenv("GAME_TEST_DSN", dsn)
			db, kind, err := chooseDB("GAME_TEST_DSN", false)
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			defer sqlDB.Close()
			oldOptions := common.OptionMap
			common.OptionMap = map[string]string{}
			defer func() { common.OptionMap = oldOptions }()
			oldDB, oldLog, oldKind, oldRedis := DB, LOG_DB, common.MainDatabaseType(), common.RedisEnabled
			DB, LOG_DB = db, db
			common.SetMainDatabaseType(kind)
			common.RedisEnabled = false
			defer func() {
				DB, LOG_DB = oldDB, oldLog
				common.SetMainDatabaseType(oldKind)
				common.RedisEnabled = oldRedis
			}()
			var version string
			if dialect == "sqlite" {
				require.NoError(t, db.Raw("select sqlite_version()").Scan(&version).Error)
			} else {
				require.NoError(t, db.Raw("select version()").Scan(&version).Error)
			}
			t.Log(dialect, version)
			models := []any{&GameReward{}, &GameRun{}, &GamePeriod{}, &Log{}, &User{}, &Option{}}
			for _, scenario := range []string{"fresh", "upgrade"} {
				t.Run(scenario, func(t *testing.T) {
					require.NoError(t, db.Migrator().DropTable(models...))
					t.Cleanup(func() { require.NoError(t, db.Migrator().DropTable(models...)) })
					if scenario == "upgrade" {
						// These tables and rows are unchanged from the previous application revision.
						require.NoError(t, db.AutoMigrate(&User{}, &Option{}))
						require.NoError(t, db.Create(&User{Id: 90, Username: "legacy", Password: "unusable", Quota: 4321, DisplayName: "Existing user"}).Error)
						require.NoError(t, db.Create(&Option{Key: "game_test_existing", Value: "preserve"}).Error)
						require.NoError(t, db.AutoMigrate(&legacyGameRunSchema{}, &legacyGamePeriodSchema{}))
						require.NoError(t, db.Create(&legacyGameRunSchema{ID: "legacy-game", UserID: 90, Day: "2026-10-01", Week: "2026-09-28", Status: "survived", StateJSON: "{}", Score: 1234, QuotaAwarded: 42}).Error)
						require.NoError(t, db.Create(&legacyGamePeriodSchema{ID: "day:2026-10-01", Budget: 100, Spent: 42, DailyQuota: 42}).Error)
					}
					for range 2 {
						require.NoError(t, db.AutoMigrate(models...))
					}
					require.True(t, db.Migrator().HasIndex(&GameRun{}, "idx_game_daily_attempt"))
					if scenario == "upgrade" {
						var user User
						require.NoError(t, db.First(&user, 90).Error)
						require.Equal(t, 4321, user.Quota)
						var option Option
						require.NoError(t, db.Where(&Option{Key: "game_test_existing"}).First(&option).Error)
						require.Equal(t, "preserve", option.Value)
						var legacy GameRun
						require.NoError(t, db.First(&legacy, "id = ?", "legacy-game").Error)
						require.Equal(t, 1234, legacy.Score)
						require.Equal(t, 42, legacy.QuotaAwarded)
						require.Zero(t, legacy.RewardVersion)
						var legacyPeriod GamePeriod
						require.NoError(t, db.First(&legacyPeriod, "id = ?", "day:2026-10-01").Error)
						require.Equal(t, 42, legacyPeriod.Spent)
						require.Zero(t, legacyPeriod.Reserved)
					}
					testGameUpgradeClock(t, time.Date(2026, 11, 20, 12, 0, 0, 0, gameZone))
					t.Run("network_recovery", func(t *testing.T) {
						testGameNetworkRecovery(t, time.Date(2026, 11, 21, 12, 0, 0, 0, gameZone))
					})
					// Retiring studio controls must not rewrite or delete legacy option data.
					require.NoError(t, db.Create(&Option{Key: "studio_setting.image_studio_enabled", Value: "false"}).Error)
					require.NoError(t, SaveGameSettings(GameSettings{Enabled: true, RewardVersion: 1, RewardsEnabled: true, DailyQuota: 200, DailyBudget: 300, WeeklyBudget: 1000}))
					var legacyStudio Option
					require.NoError(t, db.Where(&Option{Key: "studio_setting.image_studio_enabled"}).First(&legacyStudio).Error)
					require.Equal(t, "false", legacyStudio.Value)
					for i := 1; i <= 3; i++ {
						require.NoError(t, db.Create(&User{Id: i, Username: []string{"one", "two", "three"}[i-1], Password: "unusable", AffCode: []string{"affone", "afftwo", "affthree"}[i-1], DisplayName: []string{"Alpha", "Beta", "Gamma"}[i-1], Quota: 1000}).Error)
					}
					now := time.Date(2026, 10, 18, 12, 0, 0, 0, gameZone)
					var wg sync.WaitGroup
					ids := make(chan string, 6)
					for range 6 {
						wg.Add(1)
						go func() {
							defer wg.Done()
							r, e := StartGame(1, now)
							if e == nil {
								ids <- r.ID
							}
						}()
					}
					wg.Wait()
					close(ids)
					require.NotEmpty(t, ids, "at least one concurrent start must succeed")
					run, err := StartGame(1, now)
					require.NoError(t, err)
					for id := range ids {
						require.Equal(t, run.ID, id)
					}
					var count int64
					require.NoError(t, db.Model(&GameRun{}).Where("user_id = ?", 1).Count(&count).Error)
					require.EqualValues(t, 1, count)
					require.NoError(t, SaveGameSettings(GameSettings{Enabled: true, RewardVersion: 1, RewardsEnabled: true, DailyQuota: 999, DailyBudget: 10000, WeeklyBudget: 9999}))
					settings, e := GetGameSettings()
					require.NoError(t, e)
					budgets, e := GetGameBudgets(settings, now)
					require.NoError(t, e)
					require.Equal(t, GameBudgetView{DailyQuota: 200, DailyRemaining: 300, WeeklyPool: 650, CanStart: true, WeeklyRewardVersion: 1, WeeklyFirstQuota: 300, WeeklySecondQuota: 200, WeeklyThirdQuota: 150, WeeklyRewardsEnabled: true}, budgets)

					_, err = AdvanceGame(2, run.ID, 0, []int{1}, false, now)
					require.Error(t, err, "cannot submit another user's run")
					_, err = AdvanceGame(1, run.ID, 0, []int{15}, false, now)
					require.ErrorIs(t, err, ErrGameInput)
					_, err = AdvanceGame(1, run.ID, 0, make([]int, 50), false, now)
					require.ErrorIs(t, err, ErrGameInput, "cannot speed up the clock")
					progress, err := AdvanceGame(1, run.ID, 0, make([]int, 10), false, now.Add(time.Second))
					require.NoError(t, err)
					require.Equal(t, 10, progress.State.Tick)
					repeated, err := AdvanceGame(1, run.ID, 0, make([]int, 10), false, now.Add(time.Second))
					require.NoError(t, err)
					require.Equal(t, progress.State, repeated.State)
					resumed, err := GetTodayGame(1, now.Add(8*time.Second))
					require.NoError(t, err)
					require.Equal(t, run.ID, resumed.ID)
					require.Equal(t, 80, resumed.State.Tick)
					// Finish real server simulations from a controlled late-game checkpoint.
					for userID := 1; userID <= 2; userID++ {
						r, e := StartGame(userID, now)
						require.NoError(t, e)
						s := tokengame.New(42)
						s.Version = 1
						s.Tick = 1790
						s.Kills = 5
						s.Score = 1000 - userID
						bytes, e := common.Marshal(s)
						require.NoError(t, e)
						require.NoError(t, db.Model(&GameRun{}).Where("id = ?", r.ID).Update("state_json", string(bytes)).Error)
						for range 4 {
							wg.Add(1)
							go func() {
								defer wg.Done()
								_, _ = AdvanceGame(userID, r.ID, 1790, make([]int, 10), false, now.Add(180*time.Second))
							}()
						}
						wg.Wait()
						finished, e := AdvanceGame(userID, r.ID, 1790, make([]int, 10), false, now.Add(180*time.Second))
						require.NoError(t, e)
						require.Equal(t, "survived", finished.Status)
						expected := 200
						if userID == 2 {
							expected = 100
						}
						require.Equal(t, expected, finished.QuotaAwarded)
						var user User
						require.NoError(t, db.First(&user, userID).Error)
						require.Equal(t, 1000+expected, user.Quota)
					}
					var period GamePeriod
					require.NoError(t, db.First(&period, "id = ?", "day:2026-10-18").Error)
					require.Equal(t, 300, period.Spent)
					rows, err := GetGameRanking(1, false, now)
					require.NoError(t, err)
					require.Len(t, rows, 2)
					require.True(t, rows[0].IsMe)
					require.Equal(t, "Alpha", rows[0].Name)
					serialized, err := common.Marshal(rows)
					require.NoError(t, err)
					require.NotContains(t, string(serialized), "user_id")
					require.NotContains(t, string(serialized), "email")
					abandoned, err := StartGame(3, now)
					require.NoError(t, err)
					abandoned, err = AdvanceGame(3, abandoned.ID, 0, nil, true, now.Add(time.Second))
					require.NoError(t, err)
					require.Equal(t, "abandoned", abandoned.Status)
					require.Zero(t, abandoned.QuotaAwarded)
					weekEnd := time.Date(2026, 10, 19, 0, 5, 0, 0, gameZone)
					require.NoError(t, SettleGameWeek("2026-10-12", weekEnd.Add(-time.Second)))
					var rewards int64
					require.NoError(t, db.Model(&GameReward{}).Count(&rewards).Error)
					require.EqualValues(t, 2, rewards)
					for range 4 {
						wg.Add(1)
						go func() { defer wg.Done(); _ = SettleGameWeek("2026-10-12", weekEnd) }()
					}
					wg.Wait()
					require.NoError(t, SettleGameWeek("2026-10-12", weekEnd))
					require.NoError(t, db.Model(&GameReward{}).Count(&rewards).Error)
					require.EqualValues(t, 4, rewards)
					var a, b User
					require.NoError(t, db.First(&a, 1).Error)
					require.NoError(t, db.First(&b, 2).Error)
					require.Equal(t, 1500, a.Quota)
					require.Equal(t, 1300, b.Quota)
					period = GamePeriod{}
					require.NoError(t, db.First(&period, "id = ?", "week:2026-10-12").Error)
					require.True(t, period.Settled)
					require.Equal(t, 500, period.Spent)
					next, err := StartGame(1, weekEnd)
					require.NoError(t, err)
					require.NotEqual(t, run.ID, next.ID)
					// Expired sessions are finalized and cannot block a later calendar day.
					require.NoError(t, MaintainGames(weekEnd.Add(24*time.Hour)))
					next, err = GetTodayGame(1, weekEnd.Add(24*time.Hour))
					require.NoError(t, err)
					require.Nil(t, next)
					verifyTokenGameRewards(t, db)
					verifyGameRewardActivation(t, db)
					verifyWeeklyPodiumRewards(t, db)
				})
			}
		})
	}
}
func TestGameCalendarAndReplay(t *testing.T) {
	for _, tc := range []struct{ at, day, week string }{{"2026-10-18T15:59:59Z", "2026-10-18", "2026-10-12"}, {"2026-10-18T16:00:00Z", "2026-10-19", "2026-10-19"}} {
		at, err := time.Parse(time.RFC3339, tc.at)
		require.NoError(t, err)
		day, week, reset := GameCalendar(at)
		require.Equal(t, tc.day, day)
		require.Equal(t, tc.week, week)
		require.Greater(t, reset, at.UnixMilli())
	}
	data, err := os.ReadFile("../pkg/tokengame/testdata/replays.json")
	require.NoError(t, err)
	var cases []struct {
		Seed   uint32          `json:"seed"`
		Inputs []int           `json:"inputs"`
		State  tokengame.State `json:"state"`
	}
	require.NoError(t, common.Unmarshal(data, &cases))
	for _, tc := range cases {
		s := tokengame.New(tc.Seed)
		s.Version = tc.State.Version
		for _, input := range tc.Inputs {
			require.True(t, tokengame.ValidInput(input))
			s.Step(input)
		}
		require.Equal(t, tc.State, s)
	}
}

func verifyTokenGameRewards(t *testing.T, db *gorm.DB) {
	t.Helper()
	for id := 201; id <= 206; id++ {
		require.NoError(t, db.Create(&User{Id: id, Username: fmt.Sprintf("pickup%d", id), DisplayName: fmt.Sprintf("Player %d", id), Password: "unusable", AffCode: fmt.Sprintf("pickup%d", id)}).Error)
	}
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, gameZone)
	settings := GameSettings{Enabled: true, RewardsEnabled: true, RewardVersion: 2, FirstTokenQuota: 2500000, SubsequentTokenQuota: 250000, DailyBudget: 34500000}
	require.NoError(t, SaveGameSettings(settings))
	run, err := StartGame(201, now)
	require.NoError(t, err)
	require.Equal(t, 34500000, run.ReservedQuota)
	_, err = StartGame(202, now)
	require.ErrorIs(t, err, ErrGameBudget)
	var attempts int64
	require.NoError(t, db.Model(&GameRun{}).Where("user_id = ?", 202).Count(&attempts).Error)
	require.Zero(t, attempts, "an unavailable budget must not consume the attempt")
	budgets, err := GetGameBudgets(settings, now)
	require.NoError(t, err)
	require.False(t, budgets.CanStart)
	require.Equal(t, 34500000, budgets.DailyReserved)
	// One boss pickup has value 100, but is still exactly one rewarded item.
	state := tokengame.New(42)
	state.Tick = 1
	state.ClockTick = 1
	state.Kills = 1
	state.PickedTokens = 1
	state.Collected = 100
	encoded, err := common.Marshal(state)
	require.NoError(t, err)
	require.NoError(t, db.Model(&GameRun{}).Where("id = ?", run.ID).Update("state_json", string(encoded)).Error)
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = AdvanceGame(201, run.ID, 1, nil, true, now.Add(time.Second)) }()
	}
	wg.Wait()
	finished, err := AdvanceGame(201, run.ID, 1, nil, true, now.Add(time.Second))
	require.NoError(t, err)
	require.Equal(t, 2500000, finished.QuotaAwarded)
	require.Equal(t, "abandoned", finished.Status)
	var user User
	require.NoError(t, db.First(&user, 201).Error)
	require.Equal(t, 2500000, user.Quota)
	var count int64
	require.NoError(t, db.Model(&GameReward{}).Where("user_id = ?", 201).Count(&count).Error)
	require.EqualValues(t, 1, count)
	var period GamePeriod
	require.NoError(t, db.First(&period, "id = ?", "token:2026-11-02").Error)
	require.Equal(t, 2500000, period.Spent)
	require.Zero(t, period.Reserved)
	settings.FirstTokenQuota = 3000000
	settings.DailyBudget = 0
	require.NoError(t, SaveGameSettings(settings))
	budgets, err = GetGameBudgets(settings, now)
	require.NoError(t, err)
	require.Equal(t, 2500000, budgets.FirstTokenQuota)
	require.False(t, budgets.Unlimited, "an existing period keeps its cap")
	_, err = StartGame(202, now)
	require.ErrorIs(t, err, ErrGameBudget)
	now = now.AddDate(0, 0, 1)
	settings.FirstTokenQuota = 2500000
	require.NoError(t, SaveGameSettings(settings))
	for _, tc := range []struct {
		id, picked, value, expected int
		quit                        bool
	}{{202, 3, 120, 3000000, true}, {203, 0, 0, 0, true}, {204, 1, 10, 2500000, false}, {205, 129, 1470, 34500000, true}} {
		r, e := StartGame(tc.id, now)
		require.NoError(t, e)
		require.Zero(t, r.ReservedQuota)
		checkpoint := tokengame.New(42)
		checkpoint.Tick = 1
		checkpoint.ClockTick = 1
		checkpoint.Kills = tc.picked
		checkpoint.PickedTokens = tc.picked
		checkpoint.Collected = tc.value
		if !tc.quit {
			checkpoint.HP = 0
		}
		raw, e := common.Marshal(checkpoint)
		require.NoError(t, e)
		require.NoError(t, db.Model(&GameRun{}).Where("id = ?", r.ID).Update("state_json", string(raw)).Error)
		result, e := AdvanceGame(tc.id, r.ID, 1, nil, tc.quit, now.Add(time.Second))
		require.NoError(t, e)
		require.Equal(t, tc.expected, result.QuotaAwarded)
	}
	settings.Enabled = false
	require.NoError(t, SaveGameSettings(settings))
	_, err = StartGame(206, now)
	require.ErrorIs(t, err, ErrGameClosed)
	require.Error(t, UpdateOptionsBulk(map[string]string{"game_center": `{"enabled":true,"first_token_quota":-1}`}))
	settings.Enabled = true
	settings.DailyBudget = 34500000
	require.NoError(t, SaveGameSettings(settings))
	reserveTime := now.AddDate(0, 0, 2)
	for _, id := range []int{201, 202} {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = StartGame(id, reserveTime) }()
	}
	wg.Wait()
	var reservedRuns []GameRun
	require.NoError(t, db.Where("day = ?", reserveTime.Format("2006-01-02")).Find(&reservedRuns).Error)
	require.Len(t, reservedRuns, 1)
	require.Equal(t, 34500000, reservedRuns[0].ReservedQuota)
	_, err = AdvanceGame(reservedRuns[0].UserID, reservedRuns[0].ID, 0, nil, true, reserveTime)
	require.NoError(t, err)
	other := 201
	if reservedRuns[0].UserID == 201 {
		other = 202
	}
	_, err = StartGame(other, reserveTime)
	require.NoError(t, err, "unused reservation must be released")
	// The engine counts each item once regardless of its internal score value.
	example := tokengame.New(42)
	example.Enemies = []tokengame.Enemy{{ID: 1, X: 5000, Y: 3500, Kind: 3, HP: 0}, {ID: 2, X: 5000, Y: 3500, Kind: 0, HP: 0}}
	example.Step(0)
	require.Equal(t, 2, example.PickedTokens)
	require.Equal(t, 110, example.Collected)
	require.Equal(t, 2750000, GameTokenReward(example.PickedTokens, 2500000, 250000))
	slots := 0
	for tick := 1; tick <= tokengame.Duration; tick++ {
		interval := max(5, 15-tick/180)
		if tick%interval == 0 || tick == 600 || tick == 1200 || tick == 1650 {
			slots++
		}
	}
	require.Equal(t, tokengame.MaxTokens, slots, "budget reservation must cover every possible drop")
}

// The published pre-pickup schema: exercise adding columns without rewriting history.
type legacyGameRunSchema struct {
	ID           string `gorm:"type:varchar(40);primaryKey"`
	UserID       int    `gorm:"uniqueIndex:idx_game_daily_attempt;index"`
	Day          string `gorm:"type:varchar(10);uniqueIndex:idx_game_daily_attempt;index"`
	Week         string `gorm:"type:varchar(10);index"`
	StartedAt    int64  `gorm:"index"`
	FinishedAt   int64
	Status       string `gorm:"type:varchar(16);index"`
	StateJSON    string `gorm:"type:text"`
	Score        int
	QuotaAwarded int
}

func (legacyGameRunSchema) TableName() string { return "game_runs" }

type legacyGamePeriodSchema struct {
	ID         string `gorm:"type:varchar(20);primaryKey"`
	Budget     int
	Spent      int
	DailyQuota int
	Settled    bool
}

func (legacyGamePeriodSchema) TableName() string { return "game_periods" }

// Enabling rewards must activate a disabled day's empty snapshot, without
// rewriting existing runs or unlocking another attempt for those players.
func verifyGameRewardActivation(t *testing.T, db *gorm.DB) {
	t.Helper()
	for id := 301; id <= 310; id++ {
		require.NoError(t, db.Create(&User{Id: id, Username: fmt.Sprintf("activation%d", id), Password: "unusable", AffCode: fmt.Sprintf("activation%d", id)}).Error)
	}
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, gameZone)
	settings := GameSettings{Enabled: true, RewardVersion: 2, FirstTokenQuota: 2500000, SubsequentTokenQuota: 250000, DailyBudget: 34500000}
	require.NoError(t, SaveGameSettings(settings))
	oldFinished, err := StartGame(301, now)
	require.NoError(t, err)
	oldRunning, err := StartGame(302, now)
	require.NoError(t, err)
	oldFinished = finishRewardTestRun(t, db, oldFinished, 101, now.Add(time.Second))
	require.Zero(t, oldFinished.QuotaAwarded)
	var history GameRun
	require.NoError(t, db.First(&history, "id = ?", oldFinished.ID).Error)
	settings.RewardsEnabled = true
	require.NoError(t, SaveGameSettings(settings))
	budgets, err := GetGameBudgets(settings, now)
	require.NoError(t, err)
	require.Equal(t, 2500000, budgets.FirstTokenQuota, "the empty disabled period must not override the newly enabled reward")
	require.Equal(t, 250000, budgets.SubsequentTokenQuota)
	require.Equal(t, 34500000, budgets.DailyRemaining)
	require.True(t, budgets.CanStart)
	var wg sync.WaitGroup
	for _, id := range []int{303, 304} {
		wg.Go(func() { _, _ = StartGame(id, now.Add(2*time.Second)) })
	}
	wg.Wait()
	var newRuns []GameRun
	require.NoError(t, db.Where("user_id IN ?", []int{303, 304}).Find(&newRuns).Error)
	require.Len(t, newRuns, 1, "concurrent activation may reserve the daily budget only once")
	winner := newRuns[0]
	require.Equal(t, 2500000, winner.FirstTokenQuota)
	require.Equal(t, 250000, winner.SubsequentTokenQuota)
	require.Equal(t, 34500000, winner.ReservedQuota)
	var period GamePeriod
	require.NoError(t, db.First(&period, "id = ?", "token:2026-11-09").Error)
	require.Equal(t, 34500000, period.Reserved)
	require.True(t, period.RewardsInitialized)
	var unchanged GameRun
	require.NoError(t, db.First(&unchanged, "id = ?", history.ID).Error)
	require.Equal(t, history, unchanged, "completed history must remain byte-for-byte unchanged")
	oldRunning = finishRewardTestRun(t, db, oldRunning, 1, now.Add(3*time.Second))
	require.Zero(t, oldRunning.QuotaAwarded, "an existing zero-reward run retains its starting rules")
	current, err := gameView(&winner, now)
	require.NoError(t, err)
	finished := finishRewardTestRun(t, db, current, 3, now.Add(4*time.Second))
	require.Equal(t, 3000000, finished.QuotaAwarded)
	for range 3 {
		repeated, err := AdvanceGame(winner.UserID, winner.ID, 1, nil, true, now.Add(5*time.Second))
		require.NoError(t, err)
		require.Equal(t, 3000000, repeated.QuotaAwarded)
	}
	repeated, err := StartGame(301, now.Add(5*time.Second))
	require.NoError(t, err)
	require.Equal(t, history.ID, repeated.ID)
	require.Zero(t, repeated.QuotaAwarded)
	var ledgerCount int64
	require.NoError(t, db.Model(&GameReward{}).Where("user_id BETWEEN ? AND ?", 301, 304).Count(&ledgerCount).Error)
	require.EqualValues(t, 1, ledgerCount)
	var wallet User
	require.NoError(t, db.First(&wallet, winner.UserID).Error)
	require.Equal(t, 3000000, wallet.Quota)
	require.NoError(t, db.First(&period, "id = ?", "token:2026-11-09").Error)
	require.Equal(t, 3000000, period.Spent)
	require.Zero(t, period.Reserved)
	// Switching off/on must never refill a used budget or change its reward rates.
	settings.RewardsEnabled = false
	require.NoError(t, SaveGameSettings(settings))
	settings.RewardsEnabled = true
	settings.FirstTokenQuota = 5000000
	settings.DailyBudget = 0
	require.NoError(t, SaveGameSettings(settings))
	budgets, err = GetGameBudgets(settings, now)
	require.NoError(t, err)
	require.Equal(t, 2500000, budgets.FirstTokenQuota)
	require.Equal(t, 31500000, budgets.DailyRemaining)
	require.False(t, budgets.Unlimited)
	// Intentionally enabled zero-valued rewards are different from disabled rewards.
	zeroDay := now.AddDate(0, 0, 1)
	settings.FirstTokenQuota, settings.SubsequentTokenQuota = 0, 0
	require.NoError(t, SaveGameSettings(settings))
	_, err = StartGame(305, zeroDay)
	require.NoError(t, err)
	settings.FirstTokenQuota, settings.SubsequentTokenQuota = 2500000, 250000
	require.NoError(t, SaveGameSettings(settings))
	budgets, err = GetGameBudgets(settings, zeroDay)
	require.NoError(t, err)
	require.Zero(t, budgets.FirstTokenQuota)
	require.Zero(t, budgets.SubsequentTokenQuota)
	// A pre-upgrade positive snapshot remains frozen even without the new marker.
	legacyDay := now.AddDate(0, 0, 2)
	require.NoError(t, db.Create(&GamePeriod{ID: "token:2026-11-11", Budget: 34500000, FirstTokenQuota: 1000000, SubsequentTokenQuota: 100000}).Error)
	budgets, err = GetGameBudgets(settings, legacyDay)
	require.NoError(t, err)
	require.Equal(t, 1000000, budgets.FirstTokenQuota)
	legacy, err := StartGame(306, legacyDay)
	require.NoError(t, err)
	require.Equal(t, 1000000, legacy.FirstTokenQuota)
	// Insufficient funding rolls back activation as well as the daily attempt.
	limitedDay := now.AddDate(0, 0, 3)
	settings.RewardsEnabled = false
	require.NoError(t, SaveGameSettings(settings))
	_, err = StartGame(307, limitedDay)
	require.NoError(t, err)
	settings.RewardsEnabled = true
	settings.DailyBudget = 1
	require.NoError(t, SaveGameSettings(settings))
	_, err = StartGame(308, limitedDay)
	require.ErrorIs(t, err, ErrGameBudget)
	var attempts int64
	require.NoError(t, db.Model(&GameRun{}).Where("user_id = ?", 308).Count(&attempts).Error)
	require.Zero(t, attempts)
	var failedPeriod GamePeriod
	require.NoError(t, db.First(&failedPeriod, "id = ?", "token:2026-11-12").Error)
	require.Zero(t, failedPeriod.FirstTokenQuota)
	require.Zero(t, failedPeriod.Reserved)
	require.False(t, failedPeriod.RewardsInitialized)
}

func finishRewardTestRun(t *testing.T, db *gorm.DB, run *GameView, picked int, now time.Time) *GameView {
	t.Helper()
	state := tokengame.New(42)
	state.Tick, state.HP, state.Kills, state.PickedTokens, state.Collected = 1, 0, picked, picked, picked*10
	state.ClockTick = 1
	state.Score = 5677
	raw, err := common.Marshal(state)
	require.NoError(t, err)
	require.NoError(t, db.Model(&GameRun{}).Where("id = ?", run.ID).Update("state_json", string(raw)).Error)
	result, err := AdvanceGame(run.UserID, run.ID, 1, nil, false, now)
	require.NoError(t, err)
	return result
}

func testGameUpgradeClock(t *testing.T, now time.Time) {
	require.NoError(t, DB.Create(&User{Id: 777, Username: "pause-clock", Password: "unusable", Status: common.UserStatusEnabled, AffCode: "pause-clock"}).Error)
	require.NoError(t, SaveGameSettings(GameSettings{Enabled: true, RewardVersion: 2}))
	view, err := StartGame(777, now)
	require.NoError(t, err)
	state := view.State
	state.Tick = 200
	state.ClockTick = 200
	raw, err := common.Marshal(state)
	require.NoError(t, err)
	require.NoError(t, DB.Model(&GameRun{}).Where("id = ?", view.ID).Update("state_json", string(raw)).Error)
	paused, err := AdvanceGame(777, view.ID, 200, make([]int, 20), false, now.Add(22*time.Second))
	require.NoError(t, err)
	require.Equal(t, 200, paused.State.Tick)
	require.Equal(t, 220, paused.State.Cursor())
	resumed, err := GetTodayGame(777, now.Add(24*time.Second))
	require.NoError(t, err)
	require.Equal(t, 200, resumed.State.Tick)
	require.Equal(t, 40, resumed.State.PauseTicks)
	selected, err := AdvanceGame(777, view.ID, 240, []int{32}, false, now.Add(24100*time.Millisecond))
	require.NoError(t, err)
	require.Equal(t, 200, selected.State.Tick)
	require.Equal(t, 1, selected.State.Upgrades)
	replay, err := AdvanceGame(777, view.ID, 240, []int{32}, false, now.Add(24100*time.Millisecond))
	require.NoError(t, err)
	require.Equal(t, selected.State, replay.State, "repeated input must not grant another upgrade")
	_, err = AdvanceGame(777, view.ID, 241, make([]int, 50), false, now.Add(24100*time.Millisecond))
	require.ErrorIs(t, err, ErrGameInput)
	finished, err := GetTodayGame(777, now.Add(2*time.Minute))
	require.NoError(t, err)
	require.NotEqual(t, "running", finished.Status)
	require.NoError(t, DB.Delete(&GameRun{}, "user_id = ?", 777).Error)
	require.NoError(t, DB.Delete(&User{}, 777).Error)
	require.NoError(t, DB.Delete(&GamePeriod{}, "id IN ?", []string{"token:2026-11-20", "week:2026-11-16"}).Error)
}
