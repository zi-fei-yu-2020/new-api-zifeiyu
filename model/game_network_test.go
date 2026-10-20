package model

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/tokengame"
	"github.com/stretchr/testify/require"
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
