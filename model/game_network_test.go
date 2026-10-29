package model

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/tokengame"
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
