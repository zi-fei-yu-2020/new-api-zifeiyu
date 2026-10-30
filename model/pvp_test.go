package model

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/tokengame"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// The matrix mirrors TestGameDatabaseMatrix: SQLite always runs, MySQL and
// PostgreSQL require an isolated TEST_MYSQL_DSN / TEST_POSTGRES_DSN database.
func TestPvPDatabaseMatrix(t *testing.T) {
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
				t.Fatal("pvp tests require the isolated newapi_game_test database")
			}
			oldPath := common.SQLitePath
			common.SQLitePath = filepath.Join(t.TempDir(), "pvp.db")
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
			models := []any{&PvPMatch{}, &PvPInput{}, &PvPQueueEntry{}, &PvPLedger{}, &Log{}, &User{}, &Option{}}
			require.NoError(t, db.Migrator().DropTable(models...))
			for range 2 {
				require.NoError(t, db.AutoMigrate(models...))
			}
			require.True(t, db.Migrator().HasIndex(&PvPInput{}, "idx_pvp_input_batch"))

			t.Run("matchmaking", func(t *testing.T) { testPvPMatchmaking(t, db) })
			t.Run("inputs", func(t *testing.T) { testPvPInputs(t, db) })
			t.Run("friendly", func(t *testing.T) { testPvPFriendly(t, db) })
			t.Run("maintenance", func(t *testing.T) { testPvPMaintenance(t, db) })
			t.Run("deleted-payee", func(t *testing.T) { testPvPDeletedPayee(t, db) })
			t.Run("replay-gate", func(t *testing.T) { testPvPReplayGate(t, db) })
			t.Run("maintenance-resilience", func(t *testing.T) { testPvPMaintenanceResilience(t, db) })
			t.Run("settings", func(t *testing.T) { testPvPSettings(t, db) })
			t.Run("hardening", func(t *testing.T) { testPvPHardening(t, db) })
			t.Run("timing", func(t *testing.T) { testPvPTiming(t, db) })
			require.NoError(t, db.Migrator().DropTable(models...))
		})
	}
}

func pvpTestUser(t *testing.T, db *gorm.DB, id, quota int) {
	t.Helper()
	require.NoError(t, db.Create(&User{Id: id, Username: "pvp" + strings.Repeat("a", id%3) + strconv.Itoa(id), Password: "unusable", Status: common.UserStatusEnabled, Quota: quota, AffCode: "pvpaff" + strconv.Itoa(id), DisplayName: "Duelist " + strconv.Itoa(id)}).Error)
}

func pvpPair(t *testing.T, db *gorm.DB, first, second, stake int, now time.Time) (*PvPMatchView, *PvPMatchView) {
	t.Helper()
	_, queued, err := JoinPvPQueue(first, stake, now)
	require.NoError(t, err)
	require.True(t, queued)
	view, queued, err := JoinPvPQueue(second, stake, now.Add(time.Second))
	require.NoError(t, err)
	require.False(t, queued, "a compatible waiter must be paired immediately")
	require.NotNil(t, view)
	other, err := GetPvPMatchView(first, now.Add(2*time.Second))
	require.NoError(t, err)
	require.NotNil(t, other)
	return other, view
}

func pvpSigned(secret, matchID string, slot, seq, from int, inputs []int, quit bool) string {
	return pvpSignature(secret, matchID, slot, seq, from, quit, inputs)
}

func testPvPMatchmaking(t *testing.T, db *gorm.DB) {
	t.Helper()
	base := time.Date(2026, 12, 1, 12, 0, 0, 0, gameZone)
	pvpTestUser(t, db, 1, 100000)
	pvpTestUser(t, db, 2, 100000)
	pvpTestUser(t, db, 3, 49999)
	pvpTestUser(t, db, 4, 100000)

	// Stake bounds and wallet checks never leave partial state behind.
	_, _, err := JoinPvPQueue(1, 49999, base)
	require.ErrorIs(t, err, ErrPvPStake)
	_, _, err = JoinPvPQueue(3, 50000, base)
	require.ErrorIs(t, err, ErrPvPQuota, "a wallet below the stake must be rejected atomically")
	var entries int64
	require.NoError(t, db.Model(&PvPQueueEntry{}).Count(&entries).Error)
	require.Zero(t, entries)

	// Equal balances pair immediately; both stakes are escrowed exactly once.
	first, second := pvpPair(t, db, 1, 2, 50000, base)
	require.Equal(t, "ranked", first.Mode)
	require.Equal(t, "playing", first.Status)
	require.Equal(t, 1, first.You.Slot)
	require.Equal(t, 2, second.You.Slot)
	require.Equal(t, 50000, first.Stake)
	var a, b User
	require.NoError(t, db.First(&a, 1).Error)
	require.NoError(t, db.First(&b, 2).Error)
	require.Equal(t, 50000, a.Quota)
	require.Equal(t, 50000, b.Quota)
	var stakes int64
	require.NoError(t, db.Model(&PvPLedger{}).Where("kind = ?", "stake").Count(&stakes).Error)
	require.EqualValues(t, 2, stakes)

	// One active PvP state per account.
	_, _, err = JoinPvPQueue(1, 50000, base.Add(3*time.Second))
	require.ErrorIs(t, err, ErrPvPBusy)

	// A large balance gap queues instead of matching until the band widens.
	pvpTestUser(t, db, 5, 500000)
	pvpTestUser(t, db, 6, 60000)
	_, queued, err := JoinPvPQueue(5, 50000, base)
	require.NoError(t, err)
	require.True(t, queued)
	view, queued, err := JoinPvPQueue(6, 50000, base.Add(time.Second))
	require.NoError(t, err)
	require.True(t, queued)
	require.Nil(t, view)
	// Waiting 60s widens the tolerance band past the gap.
	require.NoError(t, db.Model(&PvPQueueEntry{}).Where("user_id = ?", 5).Update("enqueued_at", base.Add(-60*time.Second).UnixMilli()).Error)
	require.NoError(t, matchPvPQueue(base.Add(2*time.Second)))
	var waiting int64
	require.NoError(t, db.Model(&PvPQueueEntry{}).Where("status = ?", "waiting").Count(&waiting).Error)
	require.Zero(t, waiting)
	var matches int64
	require.NoError(t, db.Model(&PvPMatch{}).Count(&matches).Error)
	require.EqualValues(t, 2, matches)

	// Leaving the queue refunds the escrow; re-queueing afterwards must work
	// (one ticket row per account) and every waiting stint is refunded once.
	pvpTestUser(t, db, 7, 100000)
	for stint := range 2 {
		at := base.Add(time.Duration(stint) * 2 * time.Second)
		_, queued, err = JoinPvPQueue(7, 50000, at)
		require.NoError(t, err)
		require.True(t, queued)
		require.NoError(t, LeavePvPQueue(7, at.Add(time.Second)))
	}
	var refunded User
	require.NoError(t, db.First(&refunded, 7).Error)
	require.Equal(t, 100000, refunded.Quota)
	var refunds int64
	require.NoError(t, db.Model(&PvPLedger{}).Where("kind = ?", "refund").Count(&refunds).Error)
	require.EqualValues(t, 2, refunds)
	var tickets int64
	require.NoError(t, db.Model(&PvPQueueEntry{}).Where("user_id = ?", 7).Count(&tickets).Error)
	require.EqualValues(t, 1, tickets, "a re-queue reuses the same ticket row")
	var entry PvPQueueEntry
	require.NoError(t, db.Where("user_id = ?", 7).First(&entry).Error)
	require.Equal(t, "cancelled", entry.Status)

	// A maintenance snapshot from an already refunded stint must not cancel the
	// reused row after the player queues again, nor swallow the new escrow.
	staleAt := base.Add(4 * time.Second)
	_, queued, err = JoinPvPQueue(7, 50000, staleAt)
	require.NoError(t, err)
	require.True(t, queued)
	var stale PvPQueueEntry
	require.NoError(t, db.Where("user_id = ?", 7).First(&stale).Error)
	require.NoError(t, LeavePvPQueue(7, staleAt.Add(time.Second)))
	_, queued, err = JoinPvPQueue(7, 50000, staleAt.Add(2*time.Second))
	require.NoError(t, err)
	require.True(t, queued)
	var current PvPQueueEntry
	require.NoError(t, db.Where("user_id = ?", 7).First(&current).Error)
	require.Equal(t, stale.ID, current.ID)
	require.NotEqual(t, stale.EnqueuedAt, current.EnqueuedAt)
	require.NoError(t, refundQueueEntry(&stale, staleAt.Add(3*time.Second)))
	require.NoError(t, db.First(&current, current.ID).Error)
	assert.Equal(t, "waiting", current.Status)
	assert.Equal(t, staleAt.Add(2*time.Second).UnixMilli(), current.EnqueuedAt)
	require.NoError(t, db.First(&refunded, 7).Error)
	assert.Equal(t, 50000, refunded.Quota, "the current stake remains escrowed")
	require.NoError(t, db.Model(&PvPLedger{}).Where("user_id = ? AND kind = ?", 7, "refund").Count(&refunds).Error)
	assert.EqualValues(t, 3, refunds, "the stale refund adds no ledger entry")
	require.NoError(t, LeavePvPQueue(7, staleAt.Add(4*time.Second)))
	require.NoError(t, db.First(&refunded, 7).Error)
	require.Equal(t, 100000, refunded.Quota)
}

func testPvPInputs(t *testing.T, db *gorm.DB) {
	t.Helper()
	started := time.Date(2026, 12, 2, 12, 0, 0, 0, gameZone)
	pvpTestUser(t, db, 11, 100000)
	pvpTestUser(t, db, 12, 100000)
	pvpTestUser(t, db, 13, 100000)
	pvpTestUser(t, db, 14, 100000)
	first, second := pvpPair(t, db, 11, 12, 50000, started)
	matchID := first.ID
	require.Equal(t, matchID, second.ID)
	require.NotEqual(t, first.You.Secret, second.You.Secret)
	require.Contains(t, first.Opponent.DisplayName, "Duelist")

	now := started.Add(11 * time.Second) // the clock starts after the 4s countdown that follows the pairing at +1s, so 60 ticks are allowed
	batch := make([]int, 10)
	// Forged signatures, sequence replays and window violations all reject
	// before any state changes.
	_, err := SubmitPvPInput(12, matchID, 1, 0, batch, false, pvpSigned(second.You.Secret, matchID, 2, 1, 1, batch, false), now)
	require.ErrorIs(t, err, ErrPvPInput)
	_, err = SubmitPvPInput(12, matchID, 1, 0, batch, false, strings.Repeat("0", 64), now)
	require.ErrorIs(t, err, ErrPvPInput)
	_, err = SubmitPvPInput(12, matchID, 0, 0, batch, false, pvpSigned(second.You.Secret, matchID, 2, 0, 0, batch, false), now)
	require.ErrorIs(t, err, ErrPvPInput, "sequence numbers start at one")
	view, err := SubmitPvPInput(12, matchID, 1, 0, batch, false, pvpSigned(second.You.Secret, matchID, 2, 1, 0, batch, false), now)
	require.NoError(t, err)
	require.NotNil(t, view.State)
	require.Equal(t, 60, view.State.Tick, "server time alone advances the duel")
	require.Equal(t, 10, view.You.Cursor)
	var stored PvPInput
	require.NoError(t, db.Where("match_id = ? AND player = 2", matchID).First(&stored).Error)
	require.Equal(t, now.UnixMilli(), stored.ReceivedAt, "replays need the arrival time to rebuild the server's execution order")
	require.False(t, stored.Quit)
	// Replaying the acknowledged batch cannot advance twice.
	_, err = SubmitPvPInput(12, matchID, 1, 0, batch, false, pvpSigned(second.You.Secret, matchID, 2, 1, 0, batch, false), now)
	require.ErrorIs(t, err, ErrPvPInput)
	_, err = SubmitPvPInput(12, matchID, 2, 10, make([]int, 300), false, pvpSigned(second.You.Secret, matchID, 2, 2, 10, make([]int, 300), false), now)
	require.ErrorIs(t, err, ErrPvPInput, "batches may not outrun the server clock")
	// Only participants can submit.
	_, err = SubmitPvPInput(99, matchID, 1, 0, batch, false, pvpSigned(second.You.Secret, matchID, 2, 1, 0, batch, false), now)
	require.ErrorIs(t, err, ErrPvPNotFound)

	// Anti-hindsight: the opponent's submit committed the simulation up to tick
	// 40 (60 allowed minus the 20 tick grace). A batch reaching back into those
	// ticks is accepted for sequencing but stored as neutral, so it cannot
	// rewrite history.
	moves := []int{3, 3, 3, 3, 3, 3, 3, 3, 3, 3}
	stale, err := SubmitPvPInput(11, matchID, 1, 0, moves, false, pvpSigned(first.You.Secret, matchID, 1, 1, 0, moves, false), now)
	require.NoError(t, err)
	require.Equal(t, 10, stale.You.Cursor)
	require.Equal(t, 2500, stale.State.Players[0].X, "stale input must not move the player")
	var staleRow PvPInput
	require.NoError(t, db.Where("match_id = ? AND player = 1 AND seq = 1", matchID).First(&staleRow).Error)
	require.Equal(t, "[0,0,0,0,0,0,0,0,0,0]", staleRow.Inputs)

	// A client that is only slightly late still counts: catch up to tick 40 with
	// neutral ticks, then deliver real input that lands inside the grace window.
	catchUp := make([]int, 30)
	_, err = SubmitPvPInput(11, matchID, 2, 10, catchUp, false, pvpSigned(first.You.Secret, matchID, 1, 2, 10, catchUp, false), now)
	require.NoError(t, err)
	nextAt := now.Add(600 * time.Millisecond) // 66 allowed, committed to 46
	_, err = SubmitPvPInput(12, matchID, 2, 10, make([]int, 5), false, pvpSigned(second.You.Secret, matchID, 2, 2, 10, make([]int, 5), false), nextAt)
	require.NoError(t, err)
	moved, err := SubmitPvPInput(11, matchID, 3, 40, moves, false, pvpSigned(first.You.Secret, matchID, 1, 3, 40, moves, false), nextAt)
	require.NoError(t, err)
	require.Greater(t, moved.State.Players[0].X, 2500, "inputs inside the grace window take effect")
	require.Less(t, moved.State.Tick, 67)

	// A resignation loses on the spot and pays the whole pot to the winner.
	final, err := SubmitPvPInput(11, matchID, 4, 50, nil, true, pvpSigned(first.You.Secret, matchID, 1, 4, 50, nil, true), nextAt)
	require.NoError(t, err)
	require.Equal(t, "finished", final.Status)
	require.Equal(t, 2, final.WinnerSlot)
	require.NotNil(t, final.YouDeltaQuota)
	require.Equal(t, -50000, *final.YouDeltaQuota)
	var a, b User
	require.NoError(t, db.First(&a, 11).Error)
	require.NoError(t, db.First(&b, 12).Error)
	require.Equal(t, 50000, a.Quota, "the resigned player forfeits the stake")
	require.Equal(t, 150000, b.Quota, "winner takes the whole pot")
	var payouts int64
	require.NoError(t, db.Model(&PvPLedger{}).Where("kind = ?", "payout").Count(&payouts).Error)
	require.EqualValues(t, 1, payouts)
	// Settlement is idempotent: late duplicate packets pay nothing again.
	repeat, err := SubmitPvPInput(11, matchID, 4, 50, nil, true, pvpSigned(first.You.Secret, matchID, 1, 4, 50, nil, true), nextAt)
	require.NoError(t, err)
	require.Equal(t, "finished", repeat.Status)
	require.NoError(t, db.First(&b, 12).Error)
	require.Equal(t, 150000, b.Quota)

	// A timeout with equal scores refunds both stakes.
	third, _ := pvpPair(t, db, 13, 14, 50000, started)
	var match PvPMatch
	require.NoError(t, db.First(&match, "id = ?", third.ID).Error)
	state := tokengame.NewDuel(uint32(match.Seed))
	state.Tick = 899
	state.Players[0].Score = 42
	state.Players[1].Score = 42
	state.Enemies = []tokengame.DuelEnemy{}
	state.Tokens = []tokengame.DuelToken{}
	encoded, err := common.Marshal(state)
	require.NoError(t, err)
	require.NoError(t, db.Model(&PvPMatch{}).Where("id = ?", match.ID).Updates(map[string]any{"state_json": string(encoded), "player1_cursor": 899, "player2_cursor": 899, "seq1": 1, "seq2": 1}).Error)
	draw, err := SubmitPvPInput(13, match.ID, 2, 899, nil, false, pvpSigned(third.You.Secret, match.ID, 1, 2, 899, nil, false), started.Add(100*time.Second))
	require.NoError(t, err)
	require.Equal(t, 3, draw.WinnerSlot)
	require.True(t, draw.Status == "finished")
	var c, d User
	require.NoError(t, db.First(&c, 13).Error)
	require.NoError(t, db.First(&d, 14).Error)
	require.Equal(t, 100000, c.Quota, "a draw refunds both stakes")
	require.Equal(t, 100000, d.Quota)

	// Opponent views never leak the other side's signing secret.
	jsonView, err := common.Marshal(draw)
	require.NoError(t, err)
	var fresh PvPMatch
	require.NoError(t, db.First(&fresh, "id = ?", match.ID).Error)
	require.NotContains(t, string(jsonView), fresh.Secret2)
	opponentView, err := buildPvPMatchView(DB, &fresh, 14, started)
	require.NoError(t, err)
	opponentJSON, err := common.Marshal(opponentView)
	require.NoError(t, err)
	require.NotContains(t, string(opponentJSON), fresh.Secret1)
	require.Contains(t, string(opponentJSON), fresh.Secret2)
}

func testPvPFriendly(t *testing.T, db *gorm.DB) {
	t.Helper()
	base := time.Date(2026, 12, 3, 12, 0, 0, 0, gameZone)
	pvpTestUser(t, db, 21, 200000)
	pvpTestUser(t, db, 22, 40000)
	pvpTestUser(t, db, 23, 200000)

	created, err := CreatePvPFriendly(21, 50000, base)
	require.NoError(t, err)
	require.Equal(t, "invited", created.Status)
	require.NotNil(t, created.InviteCode)
	require.Len(t, *created.InviteCode, 16)
	assert.Regexp(t, "^[0-9a-f]{16}$", *created.InviteCode)
	require.Empty(t, created.Opponent.ID, "no opponent until the code is redeemed")
	var host User
	require.NoError(t, db.First(&host, 21).Error)
	require.Equal(t, 150000, host.Quota)
	_, err = CreatePvPFriendly(21, 50000, base.Add(time.Second))
	require.ErrorIs(t, err, ErrPvPBusy)

	// The joiner must afford the stake the host already escrowed.
	_, err = JoinPvPFriendly(22, *created.InviteCode, base.Add(2*time.Second))
	require.ErrorIs(t, err, ErrPvPQuota)
	_, err = JoinPvPFriendly(23, "deadbeef", base.Add(2*time.Second))
	require.ErrorIs(t, err, ErrPvPInvite)
	_, err = JoinPvPFriendly(21, *created.InviteCode, base.Add(2*time.Second))
	require.ErrorIs(t, err, ErrPvPInvite, "the creator cannot join their own room")

	joined, err := JoinPvPFriendly(23, *created.InviteCode, base.Add(3*time.Second))
	require.NoError(t, err)
	require.Equal(t, "playing", joined.Status)
	require.Equal(t, 2, joined.You.Slot)
	require.NotEmpty(t, joined.You.Secret)
	var guest User
	require.NoError(t, db.First(&guest, 23).Error)
	require.Equal(t, 150000, guest.Quota)
	_, err = JoinPvPFriendly(22, *created.InviteCode, base.Add(4*time.Second))
	require.ErrorIs(t, err, ErrPvPInvite, "a redeemed code cannot be reused")

	// History lists both sides with correct results and replay stays private.
	final, err := SubmitPvPInput(21, joined.ID, 1, 0, nil, true, pvpSigned(created.You.Secret, joined.ID, 1, 1, 0, nil, true), base.Add(30*time.Second))
	require.NoError(t, err)
	require.Equal(t, 2, final.WinnerSlot)
	items, total, err := ListPvPMatches(23, 1, 20)
	require.NoError(t, err)
	require.EqualValues(t, 1, total)
	require.Len(t, items, 1)
	assert.Equal(t, "win", items[0].Result)
	assert.Equal(t, 50000, items[0].DeltaQuota)
	lost, total, err := ListPvPMatches(21, 1, 20)
	require.NoError(t, err)
	require.EqualValues(t, 1, total)
	assert.Equal(t, "lose", lost[0].Result)
	replay, err := GetPvPReplay(23, joined.ID)
	require.NoError(t, err)
	require.Equal(t, 21, replay.Players[0].UserID)
	require.Len(t, replay.Inputs, 1)
	require.Positive(t, replay.Inputs[0].ID)
	require.True(t, replay.Inputs[0].Quit, "the deciding resignation must be replayable")
	require.Equal(t, base.Add(30*time.Second).UnixMilli(), replay.Inputs[0].ReceivedAt)
	_, err = GetPvPReplay(22, joined.ID)
	require.ErrorIs(t, err, ErrPvPNotFound)
	status, err := GetPvPStatus(23, base.Add(10*time.Second))
	require.NoError(t, err)
	require.True(t, status.Enabled)
	require.Nil(t, status.Queue)
	require.NotNil(t, status.Match)
	require.Equal(t, "finished", status.Match.Status)

	// Expiry is enforced at redemption time, not only by the asynchronous
	// maintenance loop, and remains a distinct error after cancellation.
	pvpTestUser(t, db, 24, 100000)
	pvpTestUser(t, db, 25, 100000)
	expired, err := CreatePvPFriendly(24, 50000, base)
	require.NoError(t, err)
	_, err = JoinPvPFriendly(25, *expired.InviteCode, base.Add(pvpInviteTimeout))
	require.ErrorIs(t, err, ErrPvPInviteExpired)
	var expiredGuest User
	require.NoError(t, db.First(&expiredGuest, 25).Error)
	require.Equal(t, 100000, expiredGuest.Quota, "an expired invite must not debit the joiner")

	expiresAt := base.Add(pvpInviteTimeout + time.Second)
	require.NoError(t, MaintainPvP(expiresAt))
	var cancelled PvPMatch
	require.NoError(t, db.First(&cancelled, "id = ?", expired.ID).Error)
	require.Equal(t, "cancelled", cancelled.Status)
	_, err = JoinPvPFriendly(25, *expired.InviteCode, expiresAt)
	require.ErrorIs(t, err, ErrPvPInviteExpired)
	var expiredHost User
	require.NoError(t, db.First(&expiredHost, 24).Error)
	require.Equal(t, 100000, expiredHost.Quota)
}

func testPvPMaintenance(t *testing.T, db *gorm.DB) {
	t.Helper()
	base := time.Date(2026, 12, 4, 12, 0, 0, 0, gameZone)
	pvpTestUser(t, db, 31, 100000)
	pvpTestUser(t, db, 32, 100000)
	pvpTestUser(t, db, 33, 100000)
	pvpTestUser(t, db, 34, 100000)

	// A duel abandoned past its deadline is force-settled with neutral inputs.
	first, second := pvpPair(t, db, 33, 34, 50000, base)
	require.Equal(t, first.ID, second.ID)

	// Stale queue entries and invites are refunded automatically; created
	// after the pair so the waiting ticket has nobody left to match.
	_, queued, err := JoinPvPQueue(31, 50000, base.Add(2*time.Second))
	require.NoError(t, err)
	require.True(t, queued)
	require.NoError(t, db.Model(&PvPQueueEntry{}).Where("user_id = ?", 31).Update("enqueued_at", base.Add(-11*time.Minute).UnixMilli()).Error)
	created, err := CreatePvPFriendly(32, 50000, base)
	require.NoError(t, err)
	require.NoError(t, db.Model(&PvPMatch{}).Where("id = ?", created.ID).Update("created_at", base.Add(-11*time.Minute).UnixMilli()).Error)

	late := base.Add(130 * time.Second) // countdown ends at +5s, plus the 123s input window
	require.NoError(t, MaintainPvP(late))
	var entry PvPQueueEntry
	require.NoError(t, db.Where("user_id = ?", 31).First(&entry).Error)
	require.Equal(t, "cancelled", entry.Status)
	var refunded31, refunded32 User
	require.NoError(t, db.First(&refunded31, 31).Error)
	require.Equal(t, 100000, refunded31.Quota)
	var invite PvPMatch
	require.NoError(t, db.First(&invite, "id = ?", created.ID).Error)
	require.Equal(t, "cancelled", invite.Status)
	require.NoError(t, db.First(&refunded32, 32).Error)
	require.Equal(t, 100000, refunded32.Quota)

	var match PvPMatch
	require.NoError(t, db.First(&match, "id = ?", first.ID).Error)
	require.Equal(t, "finished", match.Status)
	require.Equal(t, 3, match.WinnerSlot, "a double no-show voids the duel instead of picking an arbitrary winner")
	var a, b User
	require.NoError(t, db.First(&a, 33).Error)
	require.NoError(t, db.First(&b, 34).Error)
	require.Equal(t, 100000, a.Quota)
	require.Equal(t, 100000, b.Quota)
	// Repeated maintenance never double-settles a finished match.
	require.NoError(t, MaintainPvP(late.Add(time.Minute)))
	require.NoError(t, db.First(&a, 33).Error)
	require.Equal(t, 100000, a.Quota)
}

func testPvPSettings(t *testing.T, db *gorm.DB) {
	t.Helper()
	now := time.Date(2026, 12, 5, 12, 0, 0, 0, gameZone)
	settings, err := GetGameSettings()
	require.NoError(t, err)
	require.True(t, settings.PvpEnabled, "a fresh install enables PvP")
	require.Equal(t, common.QuotaRound(common.QuotaPerUnit/10), settings.PvpMinStake)
	require.Equal(t, common.QuotaRound(100*common.QuotaPerUnit), settings.PvpMaxStake)

	require.NoError(t, SaveGameSettings(GameSettings{Enabled: true, RewardVersion: 2, PvpEnabled: false, PvpMinStake: 1000, PvpMaxStake: 9000}))
	settings, err = GetGameSettings()
	require.NoError(t, err)
	require.False(t, settings.PvpEnabled)
	require.Equal(t, 1000, settings.PvpMinStake)
	require.Equal(t, 9000, settings.PvpMaxStake)
	pvpTestUser(t, db, 41, 100000)
	_, _, err = JoinPvPQueue(41, 5000, now)
	require.ErrorIs(t, err, ErrPvPDisabled)

	require.Error(t, SaveGameSettings(GameSettings{Enabled: true, RewardVersion: 2, PvpEnabled: true, PvpMinStake: 10000, PvpMaxStake: 9000}))
	require.Error(t, UpdateOptionsBulk(map[string]string{"game_center": `{"enabled":true,"pvp_min_stake":-1,"pvp_max_stake":9000}`}))
	require.NoError(t, SaveGameSettings(GameSettings{Enabled: true, RewardVersion: 2, PvpEnabled: true, PvpMinStake: 0, PvpMaxStake: 0}))
	settings, err = GetGameSettings()
	require.NoError(t, err)
	require.Equal(t, common.QuotaRound(common.QuotaPerUnit/10), settings.PvpMinStake, "zero stakes fall back to defaults")
	require.Equal(t, common.QuotaRound(100*common.QuotaPerUnit), settings.PvpMaxStake)

	// Disabled PvP also stops the background pairing loop, while the wait
	// limit keeps refunding tickets that were queued before the switch.
	pvpTestUser(t, db, 42, 1000000)
	pvpTestUser(t, db, 43, 60000)
	_, queued, err := JoinPvPQueue(42, 50000, now)
	require.NoError(t, err)
	require.True(t, queued)
	_, queued, err = JoinPvPQueue(43, 50000, now.Add(time.Second))
	require.NoError(t, err)
	require.True(t, queued)
	require.NoError(t, db.Model(&PvPQueueEntry{}).Where("user_id = ?", 42).Update("enqueued_at", now.Add(-120*time.Second).UnixMilli()).Error)
	require.NoError(t, SaveGameSettings(GameSettings{Enabled: true, RewardVersion: 2, PvpEnabled: false, PvpMinStake: 1000, PvpMaxStake: 9000}))
	var before int64
	require.NoError(t, db.Model(&PvPMatch{}).Count(&before).Error)
	require.NoError(t, matchPvPQueue(now.Add(2*time.Second)))
	var matches int64
	require.NoError(t, db.Model(&PvPMatch{}).Count(&matches).Error)
	require.Equal(t, before, matches, "the maintenance loop must not pair while PvP is disabled")
	require.NoError(t, db.Model(&PvPQueueEntry{}).Where("user_id IN ?", []int{42, 43}).Update("enqueued_at", now.Add(-11*time.Minute).UnixMilli()).Error)
	require.NoError(t, MaintainPvP(now.Add(3*time.Second)))
	var refunded42, refunded43 User
	require.NoError(t, db.First(&refunded42, 42).Error)
	require.NoError(t, db.First(&refunded43, 43).Error)
	require.Equal(t, 1000000, refunded42.Quota, "stale tickets still refund while disabled")
	require.Equal(t, 60000, refunded43.Quota)
}

// A waiting ticket can only ever be claimed once: the second pairing attempt
// over the same rows must be a no-op even if both racers saw it as waiting.
func TestPvPTicketClaimIsSingleUse(t *testing.T) {
	oldPath := common.SQLitePath
	common.SQLitePath = filepath.Join(t.TempDir(), "pvp-claim.db")
	defer func() { common.SQLitePath = oldPath }()
	t.Setenv("GAME_TEST_DSN", "local")
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
	models := []any{&PvPMatch{}, &PvPInput{}, &PvPQueueEntry{}, &PvPLedger{}, &Log{}, &User{}, &Option{}}
	require.NoError(t, db.AutoMigrate(models...))
	// Balances far enough apart that neither join pairs the other instantly.
	pvpTestUser(t, db, 51, 1000000)
	pvpTestUser(t, db, 52, 60000)
	now := time.Date(2026, 12, 6, 12, 0, 0, 0, gameZone)
	for _, id := range []int{51, 52} {
		_, queued, err := JoinPvPQueue(id, 50000, now)
		require.NoError(t, err)
		require.True(t, queued)
	}
	var first, second PvPQueueEntry
	require.NoError(t, DB.Where("user_id = ?", 51).First(&first).Error)
	require.NoError(t, DB.Where("user_id = ?", 52).First(&second).Error)
	created, err := pairPvPQueueEntries(&first, &second, now.Add(time.Second))
	require.NoError(t, err)
	require.True(t, created)
	created, err = pairPvPQueueEntries(&first, &second, now.Add(2*time.Second))
	require.NoError(t, err)
	require.False(t, created, "a redeemed ticket cannot pair again")
	var matches int64
	require.NoError(t, db.Model(&PvPMatch{}).Count(&matches).Error)
	require.EqualValues(t, 1, matches)
	var stakes int64
	require.NoError(t, db.Model(&PvPLedger{}).Where("kind = ?", "stake").Count(&stakes).Error)
	require.EqualValues(t, 2, stakes)
	balances := map[int]int{51: 950000, 52: 10000}
	for id, expected := range balances {
		var user User
		require.NoError(t, db.First(&user, id).Error)
		require.Equal(t, expected, user.Quota)
	}

	// A pair whose second ticket was claimed concurrently (here: by another
	// maintainer between the two UPDATEs) must roll back the first claim so
	// the ticket stays waiting and refundable instead of stranding its stake.
	pvpTestUser(t, db, 53, 1000000)
	pvpTestUser(t, db, 54, 60000)
	for _, id := range []int{53, 54} {
		_, queued, err := JoinPvPQueue(id, 50000, now)
		require.NoError(t, err)
		require.True(t, queued)
	}
	var third, fourth PvPQueueEntry
	require.NoError(t, db.Where("user_id = ?", 53).First(&third).Error)
	require.NoError(t, db.Where("user_id = ?", 54).First(&fourth).Error)
	require.NoError(t, db.Model(&PvPQueueEntry{}).Where("id = ?", fourth.ID).Update("status", "matched").Error)
	created, err = pairPvPQueueEntries(&third, &fourth, now.Add(3*time.Second))
	require.NoError(t, err, "losing a concurrent claim is a benign race, not a failure")
	require.False(t, created)
	require.NoError(t, db.First(&third, third.ID).Error)
	require.Equal(t, "waiting", third.Status, "the first claim must roll back with the pair")
	require.NoError(t, db.Model(&PvPMatch{}).Count(&matches).Error)
	require.EqualValues(t, 1, matches)
	require.NoError(t, db.Model(&PvPLedger{}).Where("kind = ?", "stake").Count(&stakes).Error)
	require.EqualValues(t, 2, stakes)
	require.NoError(t, db.Migrator().DropTable(models...))
}

// Matchmaking tolerance doubles every 15 seconds of waiting.
func TestPvPToleranceWidening(t *testing.T) {
	for _, tc := range []struct {
		a, b, waitSeconds int
		tolerated         bool
	}{
		{100000, 100000, 0, true},
		{100000, 90000, 0, true},
		{1000000, 0, 0, false},
		{1000000, 0, 60, false},
		{1000000, 0, 75, true},
	} {
		if tc.tolerated {
			require.True(t, pvpTolerated(tc.a, tc.b, tc.waitSeconds), "%d vs %d after %ds", tc.a, tc.b, tc.waitSeconds)
		} else {
			require.False(t, pvpTolerated(tc.a, tc.b, tc.waitSeconds), "%d vs %d after %ds", tc.a, tc.b, tc.waitSeconds)
		}
	}
}

// A payee deleted mid-duel must not trap the escrowed pot: settlement still
// finishes the match, the un-creditable payout is recorded as an overflow
// ledger row, and the survivor is never left blocked or unrenderable.
func testPvPDeletedPayee(t *testing.T, db *gorm.DB) {
	t.Helper()
	base := time.Date(2026, 12, 7, 12, 0, 0, 0, gameZone)
	pvpTestUser(t, db, 61, 100000)
	pvpTestUser(t, db, 62, 100000)
	first, _ := pvpPair(t, db, 61, 62, 50000, base)
	now := base.Add(11 * time.Second)
	// The winner soft-deletes between escrow and settlement; First can no
	// longer see the row, exactly like a hard-deleted account.
	require.NoError(t, db.Delete(&User{}, 62).Error)
	var gone User
	require.ErrorIs(t, db.First(&gone, 62).Error, gorm.ErrRecordNotFound)
	final, err := SubmitPvPInput(61, first.ID, 1, 0, nil, true, pvpSigned(first.You.Secret, first.ID, 1, 1, 0, nil, true), now)
	require.NoError(t, err, "settlement must not depend on the payee row existing")
	require.Equal(t, "finished", final.Status)
	require.Equal(t, 2, final.WinnerSlot)
	var stored PvPMatch
	require.NoError(t, db.First(&stored, "id = ?", first.ID).Error)
	require.Equal(t, "finished", stored.Status)
	var survivor User
	require.NoError(t, db.First(&survivor, 61).Error)
	require.Equal(t, 50000, survivor.Quota, "the resigner still forfeits the stake")
	var vanished User
	require.NoError(t, db.Unscoped().First(&vanished, 62).Error)
	require.Equal(t, 50000, vanished.Quota, "the deleted winner's wallet is untouched")
	var payout, overflow PvPLedger
	require.NoError(t, db.Where("id = ?", "payout:"+first.ID).First(&payout).Error)
	require.Equal(t, 100000, payout.Amount)
	require.NoError(t, db.Where("id = ?", "overflow:"+first.ID).First(&overflow).Error)
	require.Equal(t, "overflow", overflow.Kind)
	require.Equal(t, 100000, overflow.Amount, "the un-creditable pot is recorded as overflow instead of vanishing")
	// The vanished opponent renders as a placeholder instead of failing views.
	status, err := GetPvPStatus(61, now)
	require.NoError(t, err)
	require.NotNil(t, status.Match)
	require.Equal(t, "finished", status.Match.Status)
	require.Equal(t, 62, status.Match.Opponent.ID)
	require.Equal(t, "Deleted account", status.Match.Opponent.DisplayName)
	replay, err := GetPvPReplay(61, first.ID)
	require.NoError(t, err)
	require.Len(t, replay.Players, 2)
	assert.Equal(t, "Deleted account", replay.Players[1].Name)
	assert.Equal(t, survivor.DisplayName, replay.Players[0].Name, "existing participants keep their names")
	// The survivor is free to duel again: no permanent active-duel lock.
	_, queued, err := JoinPvPQueue(61, 50000, now.Add(time.Second))
	require.NoError(t, err)
	require.True(t, queued)
	require.NoError(t, LeavePvPQueue(61, now.Add(2*time.Second)))
	require.NoError(t, db.First(&survivor, 61).Error)
	require.Equal(t, 50000, survivor.Quota, "the forfeited stake stays lost; the new ticket refunds cleanly")
}

// Live inputs are secrets: a participant polling the replay endpoint mid-duel
// must be rejected until the duel has finished.
func testPvPReplayGate(t *testing.T, db *gorm.DB) {
	t.Helper()
	base := time.Date(2026, 12, 8, 12, 0, 0, 0, gameZone)
	pvpTestUser(t, db, 71, 100000)
	pvpTestUser(t, db, 72, 100000)
	first, second := pvpPair(t, db, 71, 72, 50000, base)
	now := base.Add(11 * time.Second)
	batch := make([]int, 10)
	view, err := SubmitPvPInput(72, second.ID, 1, 0, batch, false, pvpSigned(second.You.Secret, second.ID, 2, 1, 0, batch, false), now)
	require.NoError(t, err)
	require.Equal(t, "playing", view.Status)
	for _, participant := range []int{71, 72} {
		_, err = GetPvPReplay(participant, first.ID)
		require.ErrorIs(t, err, ErrPvPReplayNotReady, "participant %d must not read live inputs", participant)
	}
	final, err := SubmitPvPInput(72, second.ID, 2, 10, nil, true, pvpSigned(second.You.Secret, second.ID, 2, 2, 10, nil, true), now.Add(time.Second))
	require.NoError(t, err)
	require.Equal(t, "finished", final.Status)
	replay, err := GetPvPReplay(71, final.ID)
	require.NoError(t, err)
	require.Len(t, replay.Inputs, 2)
	require.True(t, replay.Inputs[1].Quit)
	_, err = GetPvPReplay(73, final.ID)
	require.ErrorIs(t, err, ErrPvPNotFound, "outsiders stay rejected even after the duel finishes")
}

// One poisoned stale-refund row must not starve the later maintenance phases:
// expired invites are still cancelled and past-deadline duels still settle,
// and once the poison is gone the next cycle clears the leftover ticket.
func testPvPMaintenanceResilience(t *testing.T, db *gorm.DB) {
	t.Helper()
	base := time.Date(2026, 12, 9, 12, 0, 0, 0, gameZone)
	pvpTestUser(t, db, 8, 100000)
	pvpTestUser(t, db, 9, 100000)
	pvpTestUser(t, db, 17, 100000)
	pvpTestUser(t, db, 18, 100000)
	duel, mirror := pvpPair(t, db, 8, 9, 50000, base)
	require.Equal(t, duel.ID, mirror.ID)
	created, err := CreatePvPFriendly(17, 50000, base)
	require.NoError(t, err)
	require.NoError(t, db.Model(&PvPMatch{}).Where("id = ?", created.ID).Update("created_at", base.Add(-11*time.Minute).UnixMilli()).Error)
	_, queued, err := JoinPvPQueue(18, 50000, base.Add(2*time.Second))
	require.NoError(t, err)
	require.True(t, queued)
	require.NoError(t, db.Model(&PvPQueueEntry{}).Where("user_id = ?", 18).Update("enqueued_at", base.Add(-11*time.Minute).UnixMilli()).Error)

	// Poison only the stale ticket's claim UPDATE, mirroring a permanently
	// failing refund; the loop must log it and keep processing later phases.
	armed := true
	require.NoError(t, db.Callback().Update().Before("gorm:update").Register("test:fail_poisoned_pvp_refund", func(tx *gorm.DB) {
		if armed {
			if _, ok := tx.Statement.Model.(*PvPQueueEntry); ok {
				tx.AddError(errors.New("poisoned pvp queue refund"))
			}
		}
	}))
	t.Cleanup(func() { require.NoError(t, db.Callback().Update().Remove("test:fail_poisoned_pvp_refund")) })

	require.NoError(t, MaintainPvP(base.Add(130*time.Second)), "a per-item failure must not abort the maintenance run")
	var ticket PvPQueueEntry
	require.NoError(t, db.Where("user_id = ?", 18).First(&ticket).Error)
	require.Equal(t, "waiting", ticket.Status, "the poisoned refund rolls back and stays retryable")
	var invite PvPMatch
	require.NoError(t, db.First(&invite, "id = ?", created.ID).Error)
	require.Equal(t, "cancelled", invite.Status, "expired invites are still cancelled after a failed refund")
	var host User
	require.NoError(t, db.First(&host, 17).Error)
	require.Equal(t, 100000, host.Quota)
	var match PvPMatch
	require.NoError(t, db.First(&match, "id = ?", duel.ID).Error)
	require.Equal(t, "finished", match.Status, "past-deadline duels are still force-settled")
	require.Equal(t, 3, match.WinnerSlot)

	// With the poison gone the very next cycle settles the leftover ticket.
	armed = false
	require.NoError(t, MaintainPvP(base.Add(131*time.Second)))
	require.NoError(t, db.Where("user_id = ?", 18).First(&ticket).Error)
	require.Equal(t, "cancelled", ticket.Status)
	var refunded User
	require.NoError(t, db.First(&refunded, 18).Error)
	require.Equal(t, 100000, refunded.Quota)
}

func pvpLogCount(t *testing.T, db *gorm.DB, userID int, fragment string) int64 {
	t.Helper()
	var count int64
	require.NoError(t, db.Model(&Log{}).Where("user_id = ? AND content LIKE ?", userID, "%"+fragment+"%").Count(&count).Error)
	return count
}

// Regression coverage for the queue-claim race, independent maintenance
// phases, creator-side invite cancellation, invite-code normalisation, the
// forfeit log gate, the finished-duel window and escrow logging.
func testPvPHardening(t *testing.T, db *gorm.DB) {
	t.Helper()
	base := time.Date(2026, 12, 10, 12, 0, 0, 0, gameZone)
	require.NoError(t, SaveGameSettings(GameSettings{Enabled: true, RewardVersion: 2, PvpEnabled: true}))

	// A maintenance snapshot taken before a cancel + re-queue at another stake
	// (same ticket row id) must neither pair nor strand any escrow.
	pvpTestUser(t, db, 81, 1000000)
	pvpTestUser(t, db, 82, 60000)
	for _, id := range []int{81, 82} {
		_, queued, err := JoinPvPQueue(id, 50000, base)
		require.NoError(t, err)
		require.True(t, queued)
	}
	require.EqualValues(t, 1, pvpLogCount(t, db, 81, "stake locked"), "queue escrow is logged")
	var first, second PvPQueueEntry
	require.NoError(t, db.Where("user_id = ?", 81).First(&first).Error)
	require.NoError(t, db.Where("user_id = ?", 82).First(&second).Error)
	require.NoError(t, LeavePvPQueue(82, base.Add(time.Second)))
	_, queued, err := JoinPvPQueue(82, 60000, base.Add(2*time.Second))
	require.NoError(t, err)
	require.True(t, queued)
	created, err := pairPvPQueueEntries(&first, &second, base.Add(3*time.Second))
	require.NoError(t, err, "losing the claim to a re-queue is a benign race")
	require.False(t, created)
	var matches int64
	require.NoError(t, db.Model(&PvPMatch{}).Where("player1_id = ? OR player2_id = ?", 81, 81).Count(&matches).Error)
	require.Zero(t, matches)
	var ticket81, ticket82 PvPQueueEntry
	require.NoError(t, db.Where("user_id = ?", 81).First(&ticket81).Error)
	require.Equal(t, "waiting", ticket81.Status)
	require.NoError(t, db.Where("user_id = ?", 82).First(&ticket82).Error)
	require.Equal(t, "waiting", ticket82.Status)
	require.Equal(t, 60000, ticket82.Stake)
	mismatched := second
	mismatched.Stake = 60000
	created, err = pairPvPQueueEntries(&first, &mismatched, base.Add(4*time.Second))
	require.NoError(t, err)
	require.False(t, created, "different stakes never pair")
	require.NoError(t, LeavePvPQueue(81, base.Add(5*time.Second)))
	require.NoError(t, LeavePvPQueue(82, base.Add(5*time.Second)))
	var wallet User
	require.NoError(t, db.First(&wallet, 82).Error)
	require.Equal(t, 60000, wallet.Quota)

	// Friendly rooms: the creator can cancel, once; codes are case-insensitive.
	pvpTestUser(t, db, 83, 200000)
	pvpTestUser(t, db, 84, 200000)
	room, err := CreatePvPFriendly(83, 50000, base)
	require.NoError(t, err)
	require.EqualValues(t, 1, pvpLogCount(t, db, 83, "stake locked"))
	require.NoError(t, CancelPvPFriendly(83, base.Add(time.Second)))
	require.NoError(t, CancelPvPFriendly(83, base.Add(2*time.Second)), "cancelling twice is a no-op")
	wallet = User{}
	require.NoError(t, db.First(&wallet, 83).Error)
	require.Equal(t, 200000, wallet.Quota)
	var cancelled PvPMatch
	require.NoError(t, db.First(&cancelled, "id = ?", room.ID).Error)
	require.Equal(t, "cancelled", cancelled.Status)
	var refunds int64
	require.NoError(t, db.Model(&PvPLedger{}).Where("match_id = ? AND kind = ?", room.ID, "refund").Count(&refunds).Error)
	require.EqualValues(t, 1, refunds)
	_, err = JoinPvPFriendly(84, *room.InviteCode, base.Add(3*time.Second))
	require.ErrorIs(t, err, ErrPvPInviteExpired)
	room, err = CreatePvPFriendly(83, 50000, base.Add(4*time.Second))
	require.NoError(t, err, "a cancelled room frees the creator")
	joined, err := JoinPvPFriendly(84, "  "+strings.ToUpper(*room.InviteCode)+" ", base.Add(5*time.Second))
	require.NoError(t, err, "invite codes are normalised before lookup")
	require.Equal(t, "playing", joined.Status)
	require.NoError(t, CancelPvPFriendly(83, base.Add(6*time.Second)))
	wallet = User{}
	require.NoError(t, db.First(&wallet, 83).Error)
	require.Equal(t, 150000, wallet.Quota, "a joined room can no longer be cancelled")

	// An early resignation logs the forfeit; a resignation that arrives after
	// the clock already ended the duel does not.
	pvpTestUser(t, db, 85, 100000)
	pvpTestUser(t, db, 86, 100000)
	pvpTestUser(t, db, 87, 100000)
	pvpTestUser(t, db, 88, 100000)
	early, _ := pvpPair(t, db, 85, 86, 50000, base)
	quitAt := base.Add(30 * time.Second)
	done, err := SubmitPvPInput(85, early.ID, 1, 0, nil, true, pvpSigned(early.You.Secret, early.ID, 1, 1, 0, nil, true), quitAt)
	require.NoError(t, err)
	require.Equal(t, 2, done.WinnerSlot)
	require.EqualValues(t, 1, pvpLogCount(t, db, 86, "opponent forfeited"))
	late, _ := pvpPair(t, db, 87, 88, 50000, base)
	lateAt := base.Add(100 * time.Second)
	done, err = SubmitPvPInput(87, late.ID, 1, 0, nil, true, pvpSigned(late.You.Secret, late.ID, 1, 1, 0, nil, true), lateAt)
	require.NoError(t, err)
	require.Equal(t, "finished", done.Status)
	require.Zero(t, pvpLogCount(t, db, 87, "opponent forfeited")+pvpLogCount(t, db, 88, "opponent forfeited"), "the clock decided this duel, not the resignation")

	// A settled duel only stays the caller's current match for a short window.
	status, err := GetPvPStatus(87, lateAt.Add(time.Minute))
	require.NoError(t, err)
	require.NotNil(t, status.Match)
	require.Equal(t, "finished", status.Match.Status)
	require.Positive(t, status.Match.FinishedAt)
	status, err = GetPvPStatus(87, lateAt.Add(pvpFinishedViewWindow+time.Second))
	require.NoError(t, err)
	require.Nil(t, status.Match)

	// Refunds and force-settlement never depend on the settings option.
	pvpTestUser(t, db, 89, 100000)
	pvpTestUser(t, db, 90, 100000)
	_, queued, err = JoinPvPQueue(89, 50000, base)
	require.NoError(t, err)
	require.True(t, queued)
	require.NoError(t, db.Model(&PvPQueueEntry{}).Where("user_id = ?", 89).Update("enqueued_at", base.Add(-11*time.Minute).UnixMilli()).Error)
	stale, err := CreatePvPFriendly(90, 50000, base)
	require.NoError(t, err)
	require.NoError(t, db.Model(&PvPMatch{}).Where("id = ?", stale.ID).Update("created_at", base.Add(-11*time.Minute).UnixMilli()).Error)
	require.NoError(t, db.Model(&Option{}).Where(&Option{Key: "game_center"}).Update("value", "{broken").Error)
	resetGameCaches()
	require.Error(t, MaintainPvP(base.Add(time.Second)), "the broken settings are reported")
	wallet = User{}
	require.NoError(t, db.First(&wallet, 89).Error)
	require.Equal(t, 100000, wallet.Quota, "stale tickets refund without readable settings")
	wallet = User{}
	require.NoError(t, db.First(&wallet, 90).Error)
	require.Equal(t, 100000, wallet.Quota, "expired invites refund without readable settings")
	require.NoError(t, SaveGameSettings(GameSettings{Enabled: true, RewardVersion: 2, PvpEnabled: true}))
}

// Start countdown, the late-input grace window that keeps speculative neutral
// ticks from deciding a duel, and presence-based force-finish.
func testPvPTiming(t *testing.T, db *gorm.DB) {
	t.Helper()
	base := time.Date(2026, 12, 11, 12, 0, 0, 0, gameZone)
	for id := 91; id <= 96; id++ {
		pvpTestUser(t, db, id, 100000)
	}

	// The clock stays at zero until the countdown has elapsed.
	first, second := pvpPair(t, db, 91, 92, 50000, base)
	startsAt := base.Add(time.Second + pvpStartCountdown)
	require.Equal(t, startsAt.UnixMilli(), first.StartedAt, "started_at is the future first tick")
	require.Greater(t, first.StartedAt, first.ServerTime)
	var match PvPMatch
	require.NoError(t, db.First(&match, "id = ?", first.ID).Error)
	assert.Zero(t, pvpAllowedTicks(&match, startsAt.Add(-time.Millisecond)))
	assert.Equal(t, 10, pvpAllowedTicks(&match, startsAt.Add(time.Second)))
	early := base.Add(3 * time.Second)
	three := []int{0, 0, 0}
	_, err := SubmitPvPInput(92, second.ID, 1, 0, three, false, pvpSigned(second.You.Secret, second.ID, 2, 1, 0, three, false), early)
	require.ErrorIs(t, err, ErrPvPInput, "ticks beyond the barrier cannot be pre-submitted")
	two := []int{0, 0}
	view, err := SubmitPvPInput(92, second.ID, 1, 0, two, false, pvpSigned(second.You.Secret, second.ID, 2, 1, 0, two, false), early)
	require.NoError(t, err)
	require.Zero(t, view.State.Tick, "the duel does not advance during the countdown")

	// Player two is one hit from death and an enemy stands on them. Under
	// neutral fill they die on tick one, but inside the grace window the late
	// batch could still dodge, so nothing may settle until the tick is final.
	doomed := tokengame.NewDuel(uint32(match.Seed))
	doomed.Players[1].HP = 1
	doomed.Enemies = []tokengame.DuelEnemy{{ID: 1, X: doomed.Players[1].X, Y: doomed.Players[1].Y, HP: 4}}
	doomed.NextID = 1
	encoded, err := common.Marshal(doomed)
	require.NoError(t, err)
	require.NoError(t, db.Model(&PvPMatch{}).Where("id = ?", match.ID).Update("state_json", string(encoded)).Error)
	idle := []int{0}
	pending, err := SubmitPvPInput(91, first.ID, 1, 0, idle, false, pvpSigned(first.You.Secret, first.ID, 1, 1, 0, idle, false), startsAt.Add(1500*time.Millisecond))
	require.NoError(t, err)
	require.Equal(t, "playing", pending.Status, "an opponent tick still inside the grace window cannot decide the duel")
	require.Zero(t, pending.You.Cursor-1)
	settled, err := SubmitPvPInput(91, first.ID, 2, 1, idle, false, pvpSigned(first.You.Secret, first.ID, 1, 2, 1, idle, false), startsAt.Add(3*time.Second))
	require.NoError(t, err)
	require.Equal(t, "finished", settled.Status, "once the grace has elapsed the neutral ticks are final")
	require.Equal(t, 1, settled.WinnerSlot)

	// Double no-show voids the duel (covered by the maintenance tests); a single
	// silent player forfeits to the one who is still present.
	third, _ := pvpPair(t, db, 93, 94, 50000, base)
	require.NoError(t, db.Create(&PvPInput{MatchID: third.ID, Player: 1, Seq: 1, FromTick: 0, Inputs: "[]", ReceivedAt: startsAt.Add(100 * time.Second).UnixMilli()}).Error)
	require.NoError(t, db.Model(&PvPMatch{}).Where("id = ?", third.ID).Updates(map[string]any{"seq1": 1}).Error)
	sweep := startsAt.Add(124 * time.Second)
	require.NoError(t, MaintainPvP(sweep))
	match = PvPMatch{}
	require.NoError(t, db.First(&match, "id = ?", third.ID).Error)
	require.Equal(t, "finished", match.Status)
	require.Equal(t, 1, match.WinnerSlot, "the present player wins against the one who left")
	var present, absent User
	require.NoError(t, db.First(&present, 93).Error)
	require.NoError(t, db.First(&absent, 94).Error)
	require.Equal(t, 150000, present.Quota)
	require.Equal(t, 50000, absent.Quota)
	require.EqualValues(t, 1, pvpLogCount(t, db, 93, "opponent forfeited"))
	require.NoError(t, MaintainPvP(sweep.Add(time.Minute)))
	require.NoError(t, db.First(&present, 93).Error)
	require.Equal(t, 150000, present.Quota, "force-finish is idempotent")
}
