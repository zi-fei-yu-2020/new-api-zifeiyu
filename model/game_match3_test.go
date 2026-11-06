package model

import (
	"fmt"
	"hash/crc32"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/tokengame"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

type matchReplay struct {
	Seed    uint32               `json:"seed"`
	Mode    int                  `json:"mode"`
	Unlocks int                  `json:"unlocks"`
	Inputs  []int                `json:"inputs"`
	State   tokengame.MatchState `json:"state"`
}

// The replay fixtures are shared with the engine and web tests. Indexes: 0 and 1
// daily wins, 2 and 3 short endless runs, 4 a running mixed run, 5 an endless
// loss, 6 a rejection scenario, 7 a full endless run to level 30.
func loadMatchReplays(t *testing.T) []matchReplay {
	t.Helper()
	data, err := os.ReadFile("../pkg/tokengame/testdata/match3-replays.json")
	require.NoError(t, err)
	var replays []matchReplay
	require.NoError(t, common.Unmarshal(data, &replays))
	require.Len(t, replays, 8)
	return replays
}

func matchTestUsers(t *testing.T, db *gorm.DB, from, to int) {
	t.Helper()
	for id := from; id <= to; id++ {
		require.NoError(t, db.Create(&User{Id: id, Username: fmt.Sprintf("match%d", id), DisplayName: fmt.Sprintf("Tiler %d", id), Password: "unusable", AffCode: fmt.Sprintf("match%d", id), Status: common.UserStatusEnabled}).Error)
	}
}

// insertMatchReplayRun stores a fresh run whose seed and unlocks come from a
// fixture, so the fixture inputs can be replayed through AdvanceMatch.
func insertMatchReplayRun(t *testing.T, db *gorm.DB, userID int, replay matchReplay, startedAt time.Time) MatchRun {
	t.Helper()
	day, week, _ := GameCalendar(startedAt)
	state := tokengame.NewMatch(replay.Seed, replay.Mode, replay.Unlocks)
	raw, err := common.Marshal(state)
	require.NoError(t, err)
	run := MatchRun{ID: common.GetUUID(), UserID: userID, Slot: "endless:active", Mode: matchModeEndless, Day: day, Week: week, Status: matchRunning, Seed: int64(replay.Seed), Unlocks: replay.Unlocks, Level: state.Level, StartedAt: startedAt.UnixMilli(), UpdatedAt: startedAt.UnixMilli(), StateJSON: string(raw)}
	if replay.Mode == tokengame.MatchModeDaily {
		run.Slot, run.Mode = "daily:"+day, matchModeDaily
	}
	require.NoError(t, db.Create(&run).Error)
	return run
}

// playMatchReplay feeds a whole fixture to a stored run in server sized batches
// at the earliest wall clock time that allows it.
func playMatchReplay(t *testing.T, db *gorm.DB, userID int, replay matchReplay, startedAt time.Time, quit bool) (MatchRun, *MatchView) {
	t.Helper()
	run := insertMatchReplayRun(t, db, userID, replay, startedAt)
	now := startedAt.Add(time.Duration(replay.State.Clock) * tokengame.TickMillis * time.Millisecond)
	view := &MatchView{}
	var err error
	clock := 0
	for from := 0; from < len(replay.Inputs); from += tokengame.MaxInputBatch {
		batch := replay.Inputs[from:min(len(replay.Inputs), from+tokengame.MaxInputBatch)]
		for _, input := range batch {
			clock += input >> 10
		}
		// An honest client sends each batch about when its clock was reached.
		view, err = AdvanceMatch(userID, run.ID, from, batch, false, startedAt.Add(time.Duration(clock)*tokengame.TickMillis*time.Millisecond))
		require.NoError(t, err)
	}
	if quit {
		view, err = AdvanceMatch(userID, run.ID, len(replay.Inputs), nil, true, now)
		require.NoError(t, err)
	}
	return run, view
}

func matchRankScore(t *testing.T, db *gorm.DB, board string, userID int) MatchRank {
	t.Helper()
	var rank MatchRank
	require.NoError(t, db.Where("board = ? AND user_id = ?", board, userID).First(&rank).Error)
	return rank
}

func verifyMatch(t *testing.T, db *gorm.DB) {
	t.Helper()
	replays := loadMatchReplays(t)
	now := time.Date(2026, 12, 7, 12, 0, 0, 0, gameZone)
	day, week, _ := GameCalendar(now)
	matchTestUsers(t, db, 8501, 8540)
	open := GameSettings{Enabled: true, RewardVersion: 2, Match3Enabled: true}
	require.NoError(t, SaveGameSettings(open))
	require.NoError(t, db.Create(&GameRun{ID: "match-token-board", UserID: 8501, Day: day, Week: week, Status: "survived", Score: 777, FinishedAt: now.UnixMilli(), StateJSON: "{}"}).Error)
	resetGameCaches()
	tokenBefore, err := GetGameRanking(8501, true, now)
	require.NoError(t, err)
	require.Len(t, tokenBefore, 1)

	t.Run("settings", func(t *testing.T) {
		for _, bad := range []GameSettings{{Enabled: true, Match3WeeklyFirst: -1}, {Enabled: true, Match3WeeklyThird: 1000000001}, {Enabled: true, Match3WeeklyFirst: 600000000, Match3WeeklySecond: 400000001}} {
			assert.ErrorIs(t, ValidateGameSettings(bad), ErrGameSettings)
		}
		require.NoError(t, ValidateGameSettings(GameSettings{Enabled: true, Match3WeeklyFirst: 600000000, Match3WeeklySecond: 400000000}))
		// A stored document from before the tile game keeps it open.
		require.NoError(t, db.Model(&Option{}).Where(&Option{Key: "game_center"}).Update("value", `{"enabled":true,"reward_version":2}`).Error)
		resetGameCaches()
		stored, err := GetGameSettings()
		require.NoError(t, err)
		assert.True(t, stored.Match3Enabled)
		assert.False(t, stored.Match3RewardsEnabled)
		patched, err := PatchGameSettings([]byte(`{"match3_weekly_first_quota":5}`))
		require.NoError(t, err)
		assert.True(t, patched.Match3Enabled)
		patched, err = PatchGameSettings([]byte(`{"match3_rewards_enabled":true,"match3_weekly_second_quota":3}`))
		require.NoError(t, err)
		assert.True(t, patched.Match3RewardsEnabled)
		assert.Equal(t, 5, patched.Match3WeeklyFirst, "an omitted prize keeps its stored value")
		assert.Equal(t, 3, patched.Match3WeeklySecond)
		_, err = PatchGameSettings([]byte(`{"match3_weekly_third_quota":-5}`))
		assert.ErrorIs(t, err, ErrGameSettings)
		require.NoError(t, SaveGameSettings(open))
	})

	t.Run("start", func(t *testing.T) {
		closed := open
		closed.Match3Enabled = false
		require.NoError(t, SaveGameSettings(closed))
		_, err := StartMatch(8504, "daily", now)
		require.ErrorIs(t, err, ErrMatchClosed)
		status, err := GetMatchStatus(8504, now)
		require.NoError(t, err)
		assert.False(t, status.Settings.Enabled)
		require.NoError(t, SaveGameSettings(open))
		_, err = StartMatch(8504, "chess", now)
		require.ErrorIs(t, err, ErrMatchInput)
		status, err = GetMatchStatus(8504, now)
		require.NoError(t, err)
		assert.Nil(t, status.DailyRun)
		assert.Nil(t, status.EndlessRun)
		var runs int64
		require.NoError(t, db.Model(&MatchRun{}).Where("user_id = ?", 8504).Count(&runs).Error)
		require.Zero(t, runs, "reading the status must not create a run")

		var wg sync.WaitGroup
		ids := make(chan string, 6)
		for range 6 {
			wg.Go(func() {
				if view, err := StartMatch(8504, "daily", now); err == nil {
					ids <- view.ID
				}
			})
		}
		wg.Wait()
		close(ids)
		require.NotEmpty(t, ids)
		daily, err := StartMatch(8504, "daily", now)
		require.NoError(t, err)
		for id := range ids {
			require.Equal(t, daily.ID, id)
		}
		require.NoError(t, db.Model(&MatchRun{}).Where("user_id = ? AND slot = ?", 8504, "daily:"+day).Count(&runs).Error)
		require.EqualValues(t, 1, runs)
		assert.Equal(t, tokengame.NewMatch(crc32.ChecksumIEEE([]byte("match3-daily-v1:"+day)), tokengame.MatchModeDaily, 7), daily.State)
		token, err := StartGame(8504, now)
		require.NoError(t, err)
		assert.NotEqual(t, daily.ID, token.ID, "a token survivor run and a tile game daily coexist")
		var tokenRuns int64
		require.NoError(t, db.Model(&GameRun{}).Where("user_id = ? AND day = ?", 8504, day).Count(&tokenRuns).Error)
		assert.EqualValues(t, 1, tokenRuns)

		finished, err := AdvanceMatch(8504, daily.ID, 0, nil, true, now.Add(time.Second))
		require.NoError(t, err)
		assert.Equal(t, "abandoned", finished.Status)
		again, err := StartMatch(8504, "daily", now.Add(time.Minute))
		require.NoError(t, err)
		assert.Equal(t, daily.ID, again.ID, "the daily attempt is spent once")
		assert.Equal(t, "abandoned", again.Status)

		// A daily still running after midnight stays the current run.
		yesterday, err := StartMatch(8502, "daily", now.AddDate(0, 0, -1))
		require.NoError(t, err)
		carried, err := StartMatch(8502, "daily", now)
		require.NoError(t, err)
		assert.Equal(t, yesterday.ID, carried.ID)

		ids = make(chan string, 6)
		for range 6 {
			wg.Go(func() {
				if view, err := StartMatch(8503, "endless", now); err == nil {
					ids <- view.ID
				}
			})
		}
		wg.Wait()
		close(ids)
		require.NotEmpty(t, ids)
		endless, err := StartMatch(8503, "endless", now)
		require.NoError(t, err)
		for id := range ids {
			require.Equal(t, endless.ID, id)
		}
		require.NoError(t, db.Model(&MatchRun{}).Where("user_id = ? AND slot = ?", 8503, "endless:active").Count(&runs).Error)
		require.EqualValues(t, 1, runs)
		assert.Equal(t, tokengame.MatchUnlockReveal, endless.Unlocks)
		_, err = AdvanceMatch(8503, endless.ID, 0, nil, true, now.Add(time.Second))
		require.NoError(t, err)
		var rewritten MatchRun
		require.NoError(t, db.First(&rewritten, "id = ?", endless.ID).Error)
		assert.Equal(t, "endless:"+endless.ID, rewritten.Slot)
		next, err := StartMatch(8503, "endless", now.Add(time.Minute))
		require.NoError(t, err)
		assert.NotEqual(t, endless.ID, next.ID, "a finished endless run frees the slot")
		_, err = AdvanceMatch(8503, next.ID, 0, nil, true, now.Add(time.Minute))
		require.NoError(t, err)
	})

	t.Run("advance", func(t *testing.T) {
		replay := replays[2]
		run := insertMatchReplayRun(t, db, 8505, replay, now)
		for _, forged := range [][]int{{5}, {1 << 18}, {-1}, {7}, make([]int, tokengame.MaxInputBatch+1)} {
			_, err := AdvanceMatch(8505, run.ID, 0, forged, false, now.Add(time.Hour))
			assert.ErrorIs(t, err, ErrMatchInput)
		}
		_, err := AdvanceMatch(8505, run.ID, -1, nil, false, now)
		assert.ErrorIs(t, err, ErrMatchInput)
		_, err = AdvanceMatch(8506, run.ID, 0, nil, false, now)
		assert.ErrorIs(t, err, gorm.ErrRecordNotFound, "another account cannot touch the run")
		// A claimed clock beyond elapsed+2 ticks is refused and leaves no trace.
		_, err = AdvanceMatch(8505, run.ID, 0, []int{255 << 10}, false, now)
		require.ErrorIs(t, err, ErrMatchInput)
		var stored MatchRun
		require.NoError(t, db.First(&stored, "id = ?", run.ID).Error)
		assert.Equal(t, run.StateJSON, stored.StateJSON)
		view, err := AdvanceMatch(8505, run.ID, 5, replay.Inputs[:1], false, now.Add(time.Hour))
		require.NoError(t, err)
		assert.Zero(t, view.State.Inputs, "a gap in the acknowledged prefix is a no-op")
		// An illegal action is a deterministic rejection, not an error.
		view, err = AdvanceMatch(8505, run.ID, 0, []int{1 | 127<<3 | 2<<10}, false, now.Add(time.Second))
		require.NoError(t, err)
		assert.Equal(t, 1, view.State.Inputs)
		assert.Equal(t, 1, view.State.Rejected)

		// A claimed clock may not trail the wall clock either: picks made an hour
		// apart cannot be presented as 200ms apart, the server waits out the lag.
		lag := insertMatchReplayRun(t, db, 8509, replays[4], now)
		early := tokengame.NewMatch(replays[4].Seed, replays[4].Mode, replays[4].Unlocks)
		split, clock := 0, 0
		for split < len(replays[4].Inputs) && early.Combo < 2 {
			early.Apply(replays[4].Inputs[split])
			clock += replays[4].Inputs[split] >> 10
			split++
		}
		require.GreaterOrEqual(t, early.Combo, 2, "the fixture builds a combo before the split")
		_, err = AdvanceMatch(8509, lag.ID, 0, replays[4].Inputs[:split], false, now.Add(time.Duration(clock)*tokengame.TickMillis*time.Millisecond))
		require.NoError(t, err)
		lagged, err := AdvanceMatch(8509, lag.ID, split, replays[4].Inputs[split:], false, now.Add(time.Hour))
		require.NoError(t, err)
		assert.GreaterOrEqual(t, lagged.State.Clock, int(time.Hour/(tokengame.TickMillis*time.Millisecond))-matchClockSlackTicks)
		assert.Less(t, lagged.State.BestCombo, replays[4].State.BestCombo, "a stalled client cannot keep its combo alive")

		retry := insertMatchReplayRun(t, db, 8507, replay, now)
		at := now.Add(time.Duration(replay.State.Clock) * tokengame.TickMillis * time.Millisecond)
		first, err := AdvanceMatch(8507, retry.ID, 0, replay.Inputs[:4], false, at)
		require.NoError(t, err)
		assert.Equal(t, 4, first.State.Inputs)
		repeated, err := AdvanceMatch(8507, retry.ID, 0, replay.Inputs[:4], false, at)
		require.NoError(t, err)
		assert.Equal(t, first.State, repeated.State)
		overlap, err := AdvanceMatch(8507, retry.ID, 2, replay.Inputs[2:], false, at)
		require.NoError(t, err)
		assert.Equal(t, replay.State, overlap.State)
		assert.Equal(t, replay.State.Score, overlap.Score)

		concurrent := insertMatchReplayRun(t, db, 8508, replay, now)
		var wg sync.WaitGroup
		for range 4 {
			wg.Go(func() { _, _ = AdvanceMatch(8508, concurrent.ID, 0, replay.Inputs, false, at) })
		}
		wg.Wait()
		settled, err := AdvanceMatch(8508, concurrent.ID, 0, nil, false, at)
		require.NoError(t, err)
		assert.Equal(t, replay.State, settled.State, "identical concurrent batches apply once")

		for i, status := range map[int]string{0: "completed", 1: "completed", 4: "running", 5: "lost", 6: "running"} {
			day := now.AddDate(0, 0, 1+i)
			_, view := playMatchReplay(t, db, 8510+i, replays[i], day, false)
			assert.Equal(t, replays[i].State, view.State, "replay %d", i)
			assert.Equal(t, status, view.Status, "replay %d", i)
			assert.Equal(t, replays[i].State.Score, view.Score, "replay %d", i)
		}
		// Past the end the run keeps its result and ignores more input.
		_, final := playMatchReplay(t, db, 8520, replays[7], now, false)
		assert.Equal(t, replays[7].State, final.State)
		assert.Equal(t, "completed", final.Status)
		over, err := AdvanceMatch(8520, final.ID, 0, replays[7].Inputs[:3], false, now.Add(time.Hour))
		require.NoError(t, err)
		assert.Equal(t, replays[7].State, over.State)
		status, err := GetMatchStatus(8520, now)
		require.NoError(t, err)
		assert.Equal(t, 30, status.Profile.BestLevel)
		assert.Equal(t, 2925, status.Profile.XP)
		assert.Equal(t, 7, status.Profile.Rank)
		assert.Equal(t, 7, status.Profile.Unlocks)
		assert.Nil(t, status.EndlessRun, "a finished endless run is no longer current")
	})

	t.Run("bank_and_ranking", func(t *testing.T) {
		// The best endless score of the week is kept, whatever order runs finish.
		endlessWeek := now.AddDate(0, 0, 14)
		_, weekly, _ := GameCalendar(endlessWeek)
		board := "weekly:" + weekly
		for i, step := range []struct{ replay, score int }{{2, 300}, {3, 300}, {4, 10100}, {2, 10100}} {
			playMatchReplay(t, db, 8530, replays[step.replay], endlessWeek.Add(time.Duration(i)*time.Hour), true)
			assert.Equal(t, step.score, matchRankScore(t, db, board, 8530).Score)
		}
		assert.Equal(t, 4, matchRankScore(t, db, board, 8530).Level)
		var profile MatchProfile
		require.NoError(t, db.First(&profile, "user_id = ?", 8530).Error)
		assert.Equal(t, MatchProfile{UserID: 8530, BestLevel: 3, XP: 90, Runs: 4}, profile)
		unlocked, err := GetMatchStatus(8530, endlessWeek)
		require.NoError(t, err)
		assert.Equal(t, tokengame.MatchUnlockReveal|tokengame.MatchUnlockUndo, unlocked.Profile.Unlocks)
		var ranks int64
		require.NoError(t, db.Model(&MatchRank{}).Where("board = ? AND user_id = ?", board, 8530).Count(&ranks).Error)
		assert.EqualValues(t, 1, ranks)

		// Ties go to the earlier achievement, then to the lower user id.
		for _, rank := range []MatchRank{{Board: board, UserID: 8531, Score: 10100, AchievedAt: 5}, {Board: board, UserID: 8532, Score: 10100, AchievedAt: 5}, {Board: board, UserID: 8533, Score: 10100, AchievedAt: 1 << 50}, {Board: board, UserID: 8534, Score: 50000, AchievedAt: 1}} {
			require.NoError(t, db.Create(&rank).Error)
		}
		require.NoError(t, db.Model(&User{}).Where("id = ?", 8534).Update("status", common.UserStatusDisabled).Error)
		resetGameCaches()
		rows, err := GetMatchRanking(8533, "endless", endlessWeek)
		require.NoError(t, err)
		order := []int{}
		for _, row := range rows {
			order = append(order, row.Rank)
		}
		require.Equal(t, []int{1, 2, 3, 4}, order)
		assert.Equal(t, []string{"Tiler 8531", "Tiler 8532", "Tiler 8530", "Tiler 8533"}, []string{rows[0].Name, rows[1].Name, rows[2].Name, rows[3].Name}, "a disabled player is not listed")
		assert.True(t, rows[3].IsMe)
		assert.Equal(t, 4, rows[2].Level)
		serialized, err := common.Marshal(rows)
		require.NoError(t, err)
		assert.NotContains(t, string(serialized), "user_id")
		assert.NotContains(t, string(serialized), "email")

		dailyRows, err := GetMatchRanking(0, "daily", now.AddDate(0, 0, 1))
		require.NoError(t, err)
		assert.Equal(t, 17300, dailyRows[0].Score)
		_, err = GetMatchRanking(0, "weekly", now)
		assert.ErrorIs(t, err, ErrMatchInput)

		// A player below the cached top 100 gets an extra row with the true rank.
		crowded := now.AddDate(0, 0, 21)
		_, crowdedWeek, _ := GameCalendar(crowded)
		crowd := make([]User, 0, 101)
		crowdRanks := make([]MatchRank, 0, 101)
		for i := range 101 {
			crowd = append(crowd, User{Id: 9000 + i, Username: fmt.Sprintf("crowd%d", i), DisplayName: fmt.Sprintf("Crowd %d", i), Password: "unusable", AffCode: fmt.Sprintf("crowd%d", i), Status: common.UserStatusEnabled})
			crowdRanks = append(crowdRanks, MatchRank{Board: "weekly:" + crowdedWeek, UserID: 9000 + i, Score: 1000 - i, AchievedAt: 1})
		}
		require.NoError(t, db.CreateInBatches(crowd, 50).Error)
		require.NoError(t, db.CreateInBatches(crowdRanks, 50).Error)
		resetGameCaches()
		last, err := GetMatchRanking(9100, "endless", crowded)
		require.NoError(t, err)
		require.Len(t, last, 101)
		assert.True(t, last[100].IsMe)
		assert.Equal(t, 101, last[100].Rank)
		top, err := GetMatchRanking(9000, "endless", crowded)
		require.NoError(t, err)
		require.Len(t, top, 100)
		assert.True(t, top[0].IsMe)

		resetGameCaches()
		tokenAfter, err := GetGameRanking(8501, true, now)
		require.NoError(t, err)
		assert.Equal(t, tokenBefore, tokenAfter, "tile game rows never reach the token survivor ranking")
	})

	t.Run("prizes", func(t *testing.T) {
		prizes := open
		prizes.Match3RewardsEnabled = true
		prizes.Match3WeeklyFirst, prizes.Match3WeeklySecond, prizes.Match3WeeklyThird = 100, 50, 25
		matchTestUsers(t, db, 8541, 8600)
		require.NoError(t, SaveGameSettings(prizes))
		weekStart := time.Date(2027, 1, 4, 12, 0, 0, 0, gameZone)
		_, settleWeek, _ := GameCalendar(weekStart)
		require.NoError(t, db.Create(&GamePeriod{ID: "match3:" + settleWeek, WeeklyRewardVersion: 2, WeeklyFirstQuota: 100, WeeklySecondQuota: 50, WeeklyThirdQuota: 25, Budget: 175, RewardsInitialized: true}).Error)
		for i, score := range []int{900, 800, 700, 600} {
			require.NoError(t, db.Create(&MatchRank{Board: "weekly:" + settleWeek, UserID: 8540 + i, Score: score, AchievedAt: int64(i + 1)}).Error)
		}
		end := time.Date(2027, 1, 11, 0, 5, 0, 0, gameZone)
		require.NoError(t, SettleMatchWeek(settleWeek, end.Add(-time.Second)))
		var rewards int64
		require.NoError(t, db.Model(&GameReward{}).Where("id LIKE ?", "match3:%").Count(&rewards).Error)
		require.Zero(t, rewards, "no payout before Monday 00:05")
		var wg sync.WaitGroup
		for range 4 {
			wg.Go(func() { _ = SettleMatchWeek(settleWeek, end) })
		}
		wg.Wait()
		require.NoError(t, SettleMatchWeek(settleWeek, end))
		require.NoError(t, db.Model(&GameReward{}).Where("id LIKE ?", "match3:%").Count(&rewards).Error)
		assert.EqualValues(t, 3, rewards)
		var ledger GameReward
		require.NoError(t, db.First(&ledger, "id = ?", fmt.Sprintf("match3:%s:%d", settleWeek, 8541)).Error)
		assert.Equal(t, 50, ledger.Quota)
		quotas := map[int]int{}
		var winners []User
		require.NoError(t, db.Where("id BETWEEN ? AND ?", 8540, 8543).Find(&winners).Error)
		for _, user := range winners {
			quotas[user.Id] = user.Quota
		}
		assert.Equal(t, map[int]int{8540: 100, 8541: 50, 8542: 25, 8543: 0}, quotas)
		var period GamePeriod
		require.NoError(t, db.First(&period, "id = ?", "match3:"+settleWeek).Error)
		assert.True(t, period.Settled)
		assert.Equal(t, 175, period.Spent)
		late := prizes
		late.Match3WeeklyFirst = 999
		require.NoError(t, saveGameSettingsAt(late, weekStart))
		require.NoError(t, db.First(&period, "id = ?", "match3:"+settleWeek).Error)
		assert.Equal(t, 100, period.WeeklyFirstQuota, "a settled week ignores a late settings save")

		// The wallet cap and disabled accounts are skipped, never paid later.
		capWeek := weekStart.AddDate(0, 0, 7)
		_, capID, _ := GameCalendar(capWeek)
		require.NoError(t, db.Create(&GamePeriod{ID: "match3:" + capID, WeeklyRewardVersion: 2, WeeklyFirstQuota: 100, WeeklySecondQuota: 50, WeeklyThirdQuota: 25, Budget: 175, RewardsInitialized: true}).Error)
		for i, score := range []int{900, 800, 700, 600, 500} {
			require.NoError(t, db.Create(&MatchRank{Board: "weekly:" + capID, UserID: 8550 + i, Score: score, AchievedAt: 1}).Error)
		}
		require.NoError(t, db.Model(&User{}).Where("id = ?", 8550).Update("quota", common.MaxWalletQuota-1).Error)
		require.NoError(t, db.Model(&User{}).Where("id = ?", 8551).Update("status", common.UserStatusDisabled).Error)
		require.NoError(t, SettleMatchWeek(capID, end.AddDate(0, 0, 7)))
		require.NoError(t, db.Model(&GameReward{}).Where("id LIKE ?", "match3:"+capID+":%").Count(&rewards).Error)
		assert.EqualValues(t, 2, rewards)
		period = GamePeriod{}
		require.NoError(t, db.First(&period, "id = ?", "match3:"+capID).Error)
		assert.Equal(t, 75, period.Spent)

		// Closing the game or switching rewards off defers the payout rather than
		// voiding it, and stops a run that is still in flight.
		pausedWeek := capWeek.AddDate(0, 0, 7)
		_, pausedID, _ := GameCalendar(pausedWeek)
		require.NoError(t, db.Create(&GamePeriod{ID: "match3:" + pausedID, WeeklyRewardVersion: 2, WeeklyFirstQuota: 100, Budget: 100, RewardsInitialized: true}).Error)
		require.NoError(t, db.Create(&MatchRank{Board: "weekly:" + pausedID, UserID: 8560, Score: 900, AchievedAt: 1}).Error)
		inFlight := insertMatchReplayRun(t, db, 8561, replays[2], pausedWeek)
		rewardsOff := prizes
		rewardsOff.Match3RewardsEnabled = false
		require.NoError(t, SaveGameSettings(rewardsOff))
		require.NoError(t, SettleMatchWeek(pausedID, end.AddDate(0, 0, 14)))
		period = GamePeriod{}
		require.NoError(t, db.First(&period, "id = ?", "match3:"+pausedID).Error)
		assert.False(t, period.Settled, "rewards switched off keep the week unsettled")
		status, err := GetMatchStatus(8561, pausedWeek)
		require.NoError(t, err)
		assert.False(t, status.WeeklyRewardsEnabled)
		closed := prizes
		closed.Match3Enabled = false
		require.NoError(t, SaveGameSettings(closed))
		_, err = AdvanceMatch(8561, inFlight.ID, 0, replays[2].Inputs[:1], false, pausedWeek.Add(time.Second))
		assert.ErrorIs(t, err, ErrMatchClosed)
		view, err := AdvanceMatch(8561, inFlight.ID, 0, nil, true, pausedWeek.Add(time.Second))
		require.NoError(t, err)
		assert.Equal(t, "abandoned", view.Status, "a closed game still lets a player resign")
		require.NoError(t, SaveGameSettings(prizes))
		require.NoError(t, SettleMatchWeek(pausedID, end.AddDate(0, 0, 14)))
		require.NoError(t, db.First(&period, "id = ?", "match3:"+pausedID).Error)
		assert.True(t, period.Settled, "the deferred week is paid once rewards are back on")

		// Switching rewards on mid-week creates the week's snapshot by itself.
		lateOn := time.Date(2027, 3, 3, 12, 0, 0, 0, gameZone)
		_, lateWeek, _ := GameCalendar(lateOn)
		require.NoError(t, SaveGameSettings(open))
		require.NoError(t, saveGameSettingsAt(prizes, lateOn))
		period = GamePeriod{}
		require.NoError(t, db.First(&period, "id = ?", "match3:"+lateWeek).Error)
		assert.True(t, period.rewardRulesInitialized())
		assert.Equal(t, []int{100, 50, 25}, period.weeklyPrizes())

		// Before anyone is paid an administrator can still reprice the week.
		hookTime := time.Date(2027, 2, 3, 12, 0, 0, 0, gameZone)
		_, hookWeek, _ := GameCalendar(hookTime)
		require.NoError(t, SaveGameSettings(open))
		off, err := GetMatchStatus(8560, hookTime)
		require.NoError(t, err)
		assert.False(t, off.WeeklyRewardsEnabled)
		assert.Equal(t, []int{0, 0, 0}, off.WeeklyPrizes)
		prizes.Match3WeeklyFirst, prizes.Match3WeeklySecond, prizes.Match3WeeklyThird = 10, 5, 2
		require.NoError(t, SaveGameSettings(prizes))
		_, err = StartMatch(8560, "endless", hookTime)
		require.NoError(t, err)
		period = GamePeriod{}
		require.NoError(t, db.First(&period, "id = ?", "match3:"+hookWeek).Error)
		assert.Equal(t, []int{10, 5, 2}, period.weeklyPrizes())
		prizes.Match3WeeklyFirst = 20
		require.NoError(t, saveGameSettingsAt(prizes, hookTime))
		on, err := GetMatchStatus(8560, hookTime)
		require.NoError(t, err)
		assert.Equal(t, []int{20, 5, 2}, on.WeeklyPrizes)
		assert.Equal(t, 27, on.WeeklyTotal)
		assert.True(t, on.WeeklyRewardsEnabled)
		require.NoError(t, db.Model(&GamePeriod{}).Where("id = ?", "match3:"+hookWeek).Update("spent", 1).Error)
		prizes.Match3WeeklyFirst = 30
		require.NoError(t, saveGameSettingsAt(prizes, hookTime), "a paid week must not block saving the game settings")
		period = GamePeriod{}
		require.NoError(t, db.First(&period, "id = ?", "match3:"+hookWeek).Error)
		assert.Equal(t, 20, period.WeeklyFirstQuota)
		require.NoError(t, SaveGameSettings(open))
	})

	t.Run("maintenance", func(t *testing.T) {
		paying := open
		paying.Match3RewardsEnabled = true
		require.NoError(t, SaveGameSettings(paying))
		started := time.Date(2027, 2, 15, 12, 0, 0, 0, gameZone)
		_, maintainWeek, _ := GameCalendar(started)
		require.NoError(t, db.Create(&GamePeriod{ID: "match3:" + maintainWeek, WeeklyRewardVersion: 2, WeeklyFirstQuota: 100, Budget: 100, RewardsInitialized: true}).Error)
		stale := insertMatchReplayRun(t, db, 8570, replays[4], started)
		raw, err := common.Marshal(replays[4].State)
		require.NoError(t, err)
		require.NoError(t, db.Model(&MatchRun{}).Where("id = ?", stale.ID).Update("state_json", string(raw)).Error)
		require.NoError(t, MaintainMatch(started.Add(time.Hour)))
		var current MatchRun
		current = MatchRun{}
		require.NoError(t, db.First(&current, "id = ?", stale.ID).Error)
		assert.Equal(t, matchRunning, current.Status, "a fresh run is left alone")
		abandonedAt := started.Add(25 * time.Hour)
		require.NoError(t, MaintainMatch(abandonedAt))
		current = MatchRun{}
		require.NoError(t, db.First(&current, "id = ?", stale.ID).Error)
		assert.Equal(t, "abandoned", current.Status)
		assert.Equal(t, "endless:"+stale.ID, current.Slot)
		banked := matchRankScore(t, db, "weekly:"+maintainWeek, 8570)
		assert.Equal(t, replays[4].State.Score, banked.Score)
		assert.Equal(t, started.UnixMilli(), banked.AchievedAt, "a swept run keeps the time the player last acted")

		// A week is only paid once none of its endless runs is still running.
		blocker := insertMatchReplayRun(t, db, 8571, replays[2], started.AddDate(0, 0, 6).Add(8*time.Hour))
		weekEnd := time.Date(2027, 2, 22, 0, 6, 0, 0, gameZone)
		require.NoError(t, MaintainMatch(weekEnd))
		var period GamePeriod
		period = GamePeriod{}
		require.NoError(t, db.First(&period, "id = ?", "match3:"+maintainWeek).Error)
		assert.False(t, period.Settled)
		require.NoError(t, MaintainMatch(weekEnd.Add(24*time.Hour)))
		current = MatchRun{}
		require.NoError(t, db.First(&current, "id = ?", blocker.ID).Error)
		assert.Equal(t, "abandoned", current.Status)
		period = GamePeriod{}
		require.NoError(t, db.First(&period, "id = ?", "match3:"+maintainWeek).Error)
		assert.True(t, period.Settled)
		var winner User
		winner = User{}
		require.NoError(t, db.First(&winner, 8570).Error)
		assert.Equal(t, 100, winner.Quota)
		require.NoError(t, MaintainMatch(weekEnd.Add(48*time.Hour)))
		winner = User{}
		require.NoError(t, db.First(&winner, 8570).Error)
		assert.Equal(t, 100, winner.Quota, "settlement is idempotent")
	})
}
