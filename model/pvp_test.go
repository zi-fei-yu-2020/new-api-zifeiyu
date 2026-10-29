package model

import (
	"errors"
	"os"
	"path/filepath"
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
			require.NoError(t, db.Migrator().DropTable(models...))
		})
	}
}

func pvpTestUser(t *testing.T, db *gorm.DB, id, quota int) {
	t.Helper()
	require.NoError(t, db.Create(&User{Id: id, Username: "pvp" + strings.Repeat("a", id%3) + string(rune('0'+id)), Password: "unusable", Status: common.UserStatusEnabled, Quota: quota, AffCode: "pvpaff" + string(rune('0'+id)), DisplayName: "Duelist " + string(rune('0'+id))}).Error)
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

	now := started.Add(11 * time.Second) // match starts at +1s, so 100 ticks are allowed
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
	require.Equal(t, 100, view.State.Tick, "server time alone advances the duel")
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

	// The opponent has already advanced the shared clock past these ticks. An
	// accepted late batch must still move the left player instead of being
	// acknowledged as neutral input and snapping the client back on sync.
	moves := []int{3, 3, 3, 3, 3, 3, 3, 3, 3, 3}
	moved, err := SubmitPvPInput(11, matchID, 1, 0, moves, false, pvpSigned(first.You.Secret, matchID, 1, 1, 0, moves, false), now)
	require.NoError(t, err)
	require.NotNil(t, moved.State)
	require.Greater(t, moved.State.Players[0].X, 2500)

	// Repeat the normal alternating submission order: the opponent advances
	// first, then the left player's next rightward batch must still take effect.
	previousX := moved.State.Players[0].X
	nextAt := now.Add(600 * time.Millisecond)
	_, err = SubmitPvPInput(12, matchID, 2, 10, make([]int, 5), false, pvpSigned(second.You.Secret, matchID, 2, 2, 10, make([]int, 5), false), nextAt)
	require.NoError(t, err)
	moved, err = SubmitPvPInput(11, matchID, 2, 10, moves[:5], false, pvpSigned(first.You.Secret, matchID, 1, 2, 10, moves[:5], false), nextAt)
	require.NoError(t, err)
	require.Greater(t, moved.State.Players[0].X, previousX)

	// A resignation loses on the spot and pays the whole pot to the winner.
	final, err := SubmitPvPInput(11, matchID, 3, 15, nil, true, pvpSigned(first.You.Secret, matchID, 1, 3, 15, nil, true), nextAt)
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
	repeat, err := SubmitPvPInput(11, matchID, 3, 15, nil, true, pvpSigned(first.You.Secret, matchID, 1, 3, 15, nil, true), nextAt)
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
	draw, err := SubmitPvPInput(13, match.ID, 2, 899, nil, false, pvpSigned(third.You.Secret, match.ID, 1, 2, 899, nil, false), started.Add(95*time.Second))
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
	require.NotEmpty(t, *created.InviteCode)
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

	late := base.Add(125 * time.Second) // started_at+1s plus the 123s input window
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
	require.Positive(t, match.WinnerSlot)
	var winner, loser User
	require.NoError(t, db.First(&winner, match.playerID(match.WinnerSlot)).Error)
	require.NoError(t, db.First(&loser, match.playerID(3-match.WinnerSlot)).Error)
	require.Equal(t, 150000, winner.Quota)
	require.Equal(t, 50000, loser.Quota)
	// Repeated maintenance never double-settles a finished match.
	require.NoError(t, MaintainPvP(late.Add(time.Minute)))
	require.NoError(t, db.First(&winner, match.playerID(match.WinnerSlot)).Error)
	require.Equal(t, 150000, winner.Quota)
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

	require.NoError(t, MaintainPvP(base.Add(125*time.Second)), "a per-item failure must not abort the maintenance run")
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
	require.Positive(t, match.WinnerSlot)

	// With the poison gone the very next cycle settles the leftover ticket.
	armed = false
	require.NoError(t, MaintainPvP(base.Add(126*time.Second)))
	require.NoError(t, db.Where("user_id = ?", 18).First(&ticket).Error)
	require.Equal(t, "cancelled", ticket.Status)
	var refunded User
	require.NoError(t, db.First(&refunded, 18).Error)
	require.Equal(t, 100000, refunded.Quota)
}
