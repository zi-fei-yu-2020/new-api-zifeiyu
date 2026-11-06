package model

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/tokengame"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func testGameNetworkRecovery(t *testing.T, now time.Time) {
	require.NoError(t, DB.Create(&User{Id: 778, Username: "network-recovery", Status: common.UserStatusEnabled, AffCode: "network-recovery"}).Error)
	require.NoError(t, SaveGameSettings(GameSettings{Enabled: true, RewardVersion: 2}))
	run, err := StartGame(778, now)
	require.NoError(t, err)
	t.Cleanup(func() {
		require.NoError(t, DB.Delete(&GameRun{}, "user_id = ?", 778).Error)
		require.NoError(t, DB.Delete(&User{}, 778).Error)
		require.NoError(t, DB.Delete(&GamePeriod{}, "id IN ?", []string{"token:2026-11-21", "week:2026-11-16"}).Error)
	})
	initial := run.State
	initial.HP, initial.MaxHP = 100000, 100000
	raw, err := common.Marshal(initial)
	require.NoError(t, err)
	require.NoError(t, DB.Model(&GameRun{}).Where("id = ?", run.ID).Update("state_json", string(raw)).Error)
	inputs := make([]int, 80)
	for index := range inputs {
		inputs[index] = 3
	}
	expected := initial
	for _, input := range inputs[:50] {
		expected.Step(input)
	}
	delayed, err := AdvanceGame(778, run.ID, 0, inputs[:50], false, now.Add(8*time.Second))
	require.NoError(t, err)
	require.Equal(t, expected, delayed.State, "a delayed valid input batch must not become idle ticks")
	for _, input := range inputs[50:] {
		expected.Step(input)
	}
	retried, err := AdvanceGame(778, run.ID, 0, inputs, false, now.Add(8*time.Second))
	require.NoError(t, err)
	require.Equal(t, expected, retried.State, "only the unacknowledged suffix is replayed after a lost response")
	repeated, err := AdvanceGame(778, run.ID, 0, inputs, false, now.Add(9*time.Second))
	require.NoError(t, err)
	require.Equal(t, expected, repeated.State)
	gap, err := AdvanceGame(778, run.ID, 85, []int{3}, false, now.Add(9*time.Second))
	require.NoError(t, err)
	require.Equal(t, expected, gap.State, "missing input ticks cannot be skipped")
	_, err = AdvanceGame(778, run.ID, 80, inputs[:50], false, now.Add(8*time.Second))
	require.ErrorIs(t, err, ErrGameInput, "buffering cannot speed up the game clock")
	_, err = AdvanceGame(778, run.ID, 80, make([]int, tokengame.MaxInputBatch+1), false, now.Add(time.Minute))
	require.ErrorIs(t, err, ErrGameInput)

	require.NoError(t, DB.Create(&User{Id: 779, Username: "network-quit", Status: common.UserStatusEnabled, AffCode: "network-quit"}).Error)
	quitting, err := StartGame(779, now)
	require.NoError(t, err)
	t.Cleanup(func() {
		require.NoError(t, DB.Delete(&GameRun{}, "user_id = ?", 779).Error)
		require.NoError(t, DB.Delete(&User{}, 779).Error)
	})
	quitState := quitting.State
	for _, input := range inputs[:10] {
		quitState.Step(input)
	}
	quit, err := AdvanceGame(779, quitting.ID, 0, inputs[:10], true, now.Add(time.Second))
	require.NoError(t, err)
	require.Equal(t, quitState, quit.State, "quitting applies recorded inputs before finalizing")
	require.Equal(t, "abandoned", quit.Status)
	duplicateQuit, err := AdvanceGame(779, quitting.ID, 0, inputs[:10], true, now.Add(2*time.Second))
	require.NoError(t, err)
	require.Equal(t, quit.State, duplicateQuit.State)
	sameDailyRun, err := StartGame(779, now.Add(2*time.Second))
	require.NoError(t, err)
	require.Equal(t, quitting.ID, sameDailyRun.ID)

	initial.Tick, initial.ClockTick, initial.Upgrades = 850, 900, 3
	raw, err = common.Marshal(initial)
	require.NoError(t, err)
	require.NoError(t, DB.Model(&GameRun{}).Where("id = ?", run.ID).Update("state_json", string(raw)).Error)
	require.NoError(t, MaintainGames(now.Add(91*time.Second)))
	var active GameRun
	require.NoError(t, DB.First(&active, "id = ?", run.ID).Error)
	require.Equal(t, "running", active.Status)
	require.Equal(t, string(raw), active.StateJSON, "maintenance must not fast-forward a live sprint during upgrade pauses")
	expiredAt := now.Add(time.Duration(initial.ClockLimit()+tokengame.MaxInputBatch) * tokengame.TickMillis * time.Millisecond)
	require.NoError(t, MaintainGames(expiredAt))
	require.NoError(t, DB.First(&active, "id = ?", run.ID).Error)
	require.Equal(t, "survived", active.Status)
	finishedAt := active.FinishedAt
	require.NoError(t, MaintainGames(expiredAt.Add(time.Minute)))
	require.NoError(t, DB.First(&active, "id = ?", run.ID).Error)
	require.Equal(t, finishedAt, active.FinishedAt)
}

func testGameMaintenanceIsolation(t *testing.T) {
	// Failure counts are process-wide and keyed by run ID; earlier dialect and
	// fresh/upgrade passes must not push these runs toward abandonment.
	gameRunFailures.Lock()
	clear(gameRunFailures.counts)
	gameRunFailures.Unlock()
	userIDs := []int{780, 781, 782, 783}
	for _, user := range []User{
		{Id: 780, Username: "maintenance-future", Status: common.UserStatusEnabled, AffCode: "maintenance-future"},
		{Id: 781, Username: "maintenance-advance", Status: common.UserStatusEnabled, AffCode: "maintenance-advance"},
		{Id: 782, Username: "maintenance-valid", Status: common.UserStatusEnabled, AffCode: "maintenance-valid"},
		{Id: 783, Username: "maintenance-winner", Status: common.UserStatusEnabled, AffCode: "maintenance-winner"},
	} {
		require.NoError(t, DB.Create(&user).Error)
	}
	t.Cleanup(func() {
		require.NoError(t, DB.Where("user_id IN ?", userIDs).Delete(&GameReward{}).Error)
		require.NoError(t, DB.Where("user_id IN ?", userIDs).Delete(&GameRun{}).Error)
		require.NoError(t, DB.Where("id IN ?", []int{780, 781, 782, 783}).Delete(&User{}).Error)
		require.NoError(t, DB.Where("id IN ?", []string{"day:2027-02-01", "week:2027-01-25", "week:not-a-date"}).Delete(&GamePeriod{}).Error)
	})

	started := time.Date(2027, 2, 1, 12, 0, 0, 0, gameZone)
	finalState := tokengame.New(42)
	finalState.Tick = tokengame.SprintDuration - 1
	finalState.ClockTick = finalState.ClockLimit() - 1
	finalState.Upgrades = 3
	finalState.HP, finalState.MaxHP = 1000, 1000
	validJSON, err := common.Marshal(finalState)
	require.NoError(t, err)
	futureState := finalState
	futureState.Version = tokengame.Version + 1
	futureJSON, err := common.Marshal(futureState)
	require.NoError(t, err)
	for _, run := range []GameRun{
		{ID: "maintenance-future-run", UserID: 780, Day: "2027-02-01", Week: "2027-02-01", StartedAt: started.UnixMilli(), Status: "running", StateJSON: string(futureJSON), RewardVersion: 1},
		{ID: "maintenance-advance-run", UserID: 781, Day: "2027-02-01", Week: "2027-02-01", StartedAt: started.Add(time.Second).UnixMilli(), Status: "running", StateJSON: string(validJSON), RewardVersion: 2},
		{ID: "maintenance-valid-run", UserID: 782, Day: "2027-02-01", Week: "2027-02-01", StartedAt: started.Add(2 * time.Second).UnixMilli(), Status: "running", StateJSON: string(validJSON), RewardVersion: 1},
		{ID: "maintenance-weekly-winner", UserID: 783, Day: "2027-01-25", Week: "2027-01-25", StartedAt: started.AddDate(0, 0, -7).UnixMilli(), FinishedAt: started.AddDate(0, 0, -7).UnixMilli(), Status: "survived", StateJSON: "{}", Score: 100, RewardVersion: 1},
	} {
		require.NoError(t, DB.Create(&run).Error)
	}
	// The version-two run has no token period, forcing AdvanceGame to roll back.
	// The invalid week independently forces one settlement failure.
	require.NoError(t, DB.Create(&GamePeriod{ID: "day:2027-02-01"}).Error)
	require.NoError(t, DB.Create(&GamePeriod{ID: "week:2027-01-25", Budget: 1000}).Error)
	require.NoError(t, DB.Create(&GamePeriod{ID: "week:not-a-date", Budget: 1000}).Error)

	err = MaintainGames(started.AddDate(0, 0, 14))
	require.Error(t, err)
	require.ErrorIs(t, err, ErrGameInput)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound)
	require.Contains(t, err.Error(), "maintenance-future-run")
	require.Contains(t, err.Error(), "maintenance-advance-run")
	require.Contains(t, err.Error(), "not-a-date")

	var valid GameRun
	require.NoError(t, DB.First(&valid, "id = ?", "maintenance-valid-run").Error)
	require.Equal(t, "survived", valid.Status, "earlier bad runs must not block a later expired run")
	for _, id := range []string{"maintenance-future-run", "maintenance-advance-run"} {
		var poisoned GameRun
		require.NoError(t, DB.First(&poisoned, "id = ?", id).Error)
		require.Equal(t, "running", poisoned.Status, "failed runs must remain available for diagnosis and retry")
	}
	var settled GamePeriod
	require.NoError(t, DB.First(&settled, "id = ?", "week:2027-01-25").Error)
	require.True(t, settled.Settled, "run and other-period failures must not block an eligible week")
	require.Equal(t, 300, settled.Spent)
	var winner User
	require.NoError(t, DB.First(&winner, 783).Error)
	require.Equal(t, 300, winner.Quota)
}

// Regression coverage for status reads, quit handling, maintenance isolation,
// legacy weekly backfill, settings validation and ranking visibility.
func testGameAuditRegressions(t *testing.T) {
	resetGameCaches()
	day := time.Date(2027, 3, 1, 12, 0, 0, 0, gameZone)
	for id := 790; id <= 794; id++ {
		require.NoError(t, DB.Create(&User{Id: id, Username: fmt.Sprintf("audit%d", id), Status: common.UserStatusEnabled, AffCode: fmt.Sprintf("audit%d", id), DisplayName: fmt.Sprintf("Audit %d", id)}).Error)
	}
	t.Cleanup(func() {
		require.NoError(t, DB.Where("user_id BETWEEN ? AND ?", 790, 794).Delete(&GameRun{}).Error)
		require.NoError(t, DB.Where("id BETWEEN ? AND ?", 790, 794).Delete(&User{}).Error)
		require.NoError(t, DB.Where("id LIKE ? OR id LIKE ?", "token:2027-03-%", "week:2027-03-%").Delete(&GamePeriod{}).Error)
		resetGameCaches()
	})
	require.NoError(t, SaveGameSettings(GameSettings{Enabled: true, RewardVersion: 2}))

	// A status read leaves the stored run alone, so an input batch that was in
	// flight during the read is still applied instead of becoming idle ticks.
	run, err := StartGame(790, day)
	require.NoError(t, err)
	read, err := GetTodayGame(790, day.Add(5*time.Second))
	require.NoError(t, err)
	require.Zero(t, read.State.Tick)
	var stored GameRun
	require.NoError(t, DB.First(&stored, "id = ?", run.ID).Error)
	require.Equal(t, run.StateJSON, stored.StateJSON)
	applied, err := AdvanceGame(790, run.ID, 0, make([]int, 30), false, day.Add(5*time.Second))
	require.NoError(t, err)
	require.Equal(t, 30, applied.State.Tick)

	// A defeat reached before the quit request keeps its result and ranking.
	defeated := tokengame.New(42)
	defeated.Tick, defeated.ClockTick, defeated.HP, defeated.Score = 1, 1, 0, 777
	raw, err := common.Marshal(defeated)
	require.NoError(t, err)
	require.NoError(t, DB.Model(&GameRun{}).Where("id = ?", run.ID).Update("state_json", string(raw)).Error)
	finished, err := AdvanceGame(790, run.ID, 1, nil, true, day.Add(6*time.Second))
	require.NoError(t, err)
	assert.Equal(t, "defeated", finished.Status)
	resetGameCaches()
	rows, err := GetGameRanking(790, false, day)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, 777, rows[0].Score)

	// Maintenance survives a panic and abandons a run that never recovers.
	assert.Error(t, guardGameMaintenance("test", func() error { panic("boom") }))
	assert.NoError(t, guardGameMaintenance("test", func() error { return nil }))
	started := time.Date(2027, 3, 2, 12, 0, 0, 0, gameZone)
	broken := GameRun{ID: "audit-broken-run", UserID: 791, Day: "2027-03-02", Week: "2027-03-01", StartedAt: started.UnixMilli(), Status: "running", StateJSON: raw2(t, tokengame.New(42)), RewardVersion: 2, ReservedQuota: 500}
	require.NoError(t, DB.Create(&broken).Error)
	gameRunFailures.Lock()
	delete(gameRunFailures.counts, broken.ID)
	gameRunFailures.Unlock()
	soon := started.Add(2 * time.Hour)
	for range gameRunMaxFailures {
		require.Error(t, MaintainGames(soon), "a young failing run keeps being retried")
	}
	var still GameRun
	require.NoError(t, DB.First(&still, "id = ?", broken.ID).Error)
	assert.Equal(t, "running", still.Status)
	late := started.Add(gameRunAbandonGrace + 6*time.Hour)
	var maintenanceErr error
	for range gameRunMaxFailures {
		maintenanceErr = MaintainGames(late)
	}
	assert.NoError(t, maintenanceErr, "the run is abandoned on the last allowed failure")
	var gone GameRun
	require.NoError(t, DB.First(&gone, "id = ?", broken.ID).Error)
	assert.Equal(t, "abandoned", gone.Status)
	assert.Zero(t, gone.ReservedQuota)

	// A weekly row created while rewards were off picks up later v1 rules.
	weekDay := time.Date(2027, 3, 8, 12, 0, 0, 0, gameZone)
	v1 := GameSettings{Enabled: true, RewardVersion: 2, WeeklyRewardVersion: 1, WeeklyBudget: 1000}
	require.NoError(t, SaveGameSettings(v1))
	_, err = StartGame(792, weekDay)
	require.NoError(t, err)
	var week GamePeriod
	require.NoError(t, DB.First(&week, "id = ?", "week:2027-03-08").Error)
	require.Zero(t, week.Budget)
	v1.RewardsEnabled = true
	require.NoError(t, SaveGameSettings(v1))
	_, err = StartGame(793, weekDay)
	require.NoError(t, err)
	require.NoError(t, DB.First(&week, "id = ?", "week:2027-03-08").Error)
	assert.Equal(t, 1000, week.Budget)
	assert.Equal(t, []int{300, 200, 150}, week.weeklyPrizes())

	// Settings that would block every run are rejected on save.
	blocking := GameSettings{Enabled: true, RewardVersion: 2, RewardsEnabled: true, FirstTokenQuota: 2500000, SubsequentTokenQuota: 250000, DailyBudget: 1}
	assert.ErrorIs(t, ValidateGameSettings(blocking), ErrGameSettings)
	blocking.DailyBudget = 0
	assert.NoError(t, ValidateGameSettings(blocking), "zero keeps meaning no daily cap")
	blocking.DailyBudget = GameTokenReward(tokengame.SprintMaxTokens, blocking.FirstTokenQuota, blocking.SubsequentTokenQuota)
	assert.NoError(t, ValidateGameSettings(blocking))

	// A partial update keeps omitted fields and returns the stored value.
	require.NoError(t, SaveGameSettings(GameSettings{Enabled: true, RewardVersion: 2, PvpEnabled: false, PvpMinStake: 1000, PvpMaxStake: 9000, DailyQuota: 5}))
	patched, err := PatchGameSettings([]byte(`{"daily_quota":7}`))
	require.NoError(t, err)
	assert.True(t, patched.Enabled)
	assert.False(t, patched.PvpEnabled)
	assert.Equal(t, 1000, patched.PvpMinStake)
	assert.Equal(t, 7, patched.DailyQuota)
	loaded, err := GetGameSettings()
	require.NoError(t, err)
	assert.Equal(t, patched, loaded)
	_, err = PatchGameSettings([]byte(`{"first_token_quota":-1}`))
	assert.ErrorIs(t, err, ErrGameSettings)
	_, err = PatchGameSettings([]byte(`not json`))
	assert.ErrorIs(t, err, ErrGameSettings)
	// Saving invalidates the cached settings immediately.
	require.NoError(t, SaveGameSettings(GameSettings{Enabled: false, RewardVersion: 2}))
	loaded, err = GetGameSettings()
	require.NoError(t, err)
	assert.False(t, loaded.Enabled)

	// A player outside the visible top rows still sees their own rank.
	rankDay := time.Date(2027, 3, 20, 12, 0, 0, 0, gameZone)
	var crowd []User
	var runs []GameRun
	for i := range gameRankingLimit + 1 {
		id := 20000 + i
		crowd = append(crowd, User{Id: id, Username: fmt.Sprintf("crowd%d", id), Status: common.UserStatusEnabled, AffCode: fmt.Sprintf("crowd%d", id)})
		runs = append(runs, GameRun{ID: fmt.Sprintf("crowd-run-%d", id), UserID: id, Day: "2027-03-20", Week: "2027-03-15", Status: "survived", Score: 1000 - i, FinishedAt: rankDay.UnixMilli(), StateJSON: "{}"})
	}
	require.NoError(t, DB.CreateInBatches(&crowd, 50).Error)
	require.NoError(t, DB.CreateInBatches(&runs, 50).Error)
	t.Cleanup(func() {
		require.NoError(t, DB.Where("user_id >= ?", 20000).Delete(&GameRun{}).Error)
		require.NoError(t, DB.Where("id >= ?", 20000).Delete(&User{}).Error)
		resetGameCaches()
	})
	resetGameCaches()
	last := 20000 + gameRankingLimit
	ranking, err := GetGameRanking(last, false, rankDay)
	require.NoError(t, err)
	require.Len(t, ranking, gameRankingLimit+1)
	assert.Equal(t, gameRankingLimit+1, ranking[gameRankingLimit].Rank)
	assert.True(t, ranking[gameRankingLimit].IsMe)
	for _, row := range ranking[:gameRankingLimit] {
		assert.False(t, row.IsMe)
	}
	top, err := GetGameRanking(20000, false, rankDay)
	require.NoError(t, err)
	require.Len(t, top, gameRankingLimit)
	assert.True(t, top[0].IsMe)
	assert.False(t, errors.Is(err, gorm.ErrRecordNotFound))
}

func raw2(t *testing.T, state tokengame.State) string {
	t.Helper()
	raw, err := common.Marshal(state)
	require.NoError(t, err)
	return string(raw)
}
