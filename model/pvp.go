package model

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/pkg/tokengame"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrPvPDisabled = errors.New("PvP duels are currently disabled")
	ErrPvPStake    = errors.New("Invalid PvP stake")
	ErrPvPBusy     = errors.New("You already have an active PvP duel or queue entry")
	ErrPvPQuota    = errors.New("Insufficient quota for the stake")
	ErrPvPInput    = errors.New("PvP input rejected")
	ErrPvPNotFound = errors.New("PvP match not found")
	ErrPvPInvite   = errors.New("PvP invite is no longer available")
)

const pvpQueueWaitLimit = 10 * time.Minute
const pvpInviteTimeout = 10 * time.Minute

// PvPMatch is one 1v1 duel. Escrowed stakes, the authoritative state and the
// per-player sequencing/signing secrets live here; inputs live in PvPInput so
// the whole duel can be replayed from seed plus batches.
type PvPMatch struct {
	ID            string  `gorm:"type:varchar(40);primaryKey" json:"id"`
	Mode          string  `gorm:"type:varchar(16)" json:"mode"` // ranked | friendly
	Status        string  `gorm:"type:varchar(16);index" json:"status"`
	Seed          int     `json:"seed"`
	Stake         int     `json:"stake"`
	Player1ID     int     `gorm:"index" json:"player1_id"`
	Player2ID     int     `gorm:"index" json:"player2_id"`
	WinnerSlot    int     `json:"winner_slot"`
	Draw          bool    `json:"draw"`
	Player1Score  int     `json:"player1_score"`
	Player2Score  int     `json:"player2_score"`
	Player1Cursor int     `json:"player1_cursor"`
	Player2Cursor int     `json:"player2_cursor"`
	Seq1          int     `json:"seq1"`
	Seq2          int     `json:"seq2"`
	InviteCode    *string `gorm:"type:varchar(16);uniqueIndex" json:"invite_code"`
	Secret1       string  `gorm:"type:varchar(64)" json:"-"`
	Secret2       string  `gorm:"type:varchar(64)" json:"-"`
	StateJSON     string  `gorm:"type:text" json:"-"`
	CreatedAt     int64   `gorm:"index" json:"created_at"`
	StartedAt     int64   `json:"started_at"`
	FinishedAt    int64   `json:"finished_at"`
}

func (m *PvPMatch) playerID(slot int) int {
	if slot == 1 {
		return m.Player1ID
	}
	return m.Player2ID
}

// PvPInput stores one accepted input batch. (match_id, player, seq) is unique,
// which makes the stored stream strictly sequential and replay-unambiguous.
// ReceivedAt plus the insertion-ordered ID reproduce the server's exact
// processing order, and Quit marks the resignation batch that ended the duel.
type PvPInput struct {
	ID         uint   `gorm:"primaryKey" json:"id"`
	MatchID    string `gorm:"type:varchar(40);uniqueIndex:idx_pvp_input_batch" json:"match_id"`
	Player     int    `gorm:"uniqueIndex:idx_pvp_input_batch" json:"player"`
	Seq        int    `gorm:"uniqueIndex:idx_pvp_input_batch" json:"seq"`
	FromTick   int    `json:"from_tick"`
	Inputs     string `gorm:"type:text" json:"-"`
	Quit       bool   `json:"quit"`
	ReceivedAt int64  `json:"received_at"`
}

// PvPQueueEntry is an escrowed matchmaking ticket; Balance is the wallet
// balance remaining after the stake was locked.
type PvPQueueEntry struct {
	ID         uint   `gorm:"primaryKey" json:"id"`
	UserID     int    `gorm:"uniqueIndex" json:"user_id"`
	Balance    int    `json:"balance"`
	Stake      int    `json:"stake"`
	EnqueuedAt int64  `json:"enqueued_at"`
	Status     string `gorm:"type:varchar(16);index" json:"status"`
}

// PvPLedger records every PvP quota movement exactly once. Stake rows document
// escrow consumption when a match binds; payout/refund/overflow rows accompany
// actual credits and are the idempotency keys of settlement.
type PvPLedger struct {
	ID        string `gorm:"type:varchar(80);primaryKey" json:"id"`
	MatchID   string `gorm:"type:varchar(40);index" json:"match_id"`
	UserID    int    `gorm:"index" json:"user_id"`
	Amount    int    `json:"amount"`
	Kind      string `gorm:"type:varchar(16)" json:"kind"`
	CreatedAt int64  `json:"created_at"`
}

// pvpLogEvent defers cache sync and log writes until the money transaction
// has committed, mirroring the daily-game reward flow.
type pvpLogEvent struct {
	userID int
	kind   string // payout | refund | forfeit
	amount int
}

func applyPvPEvents(events []pvpLogEvent) {
	for _, event := range events {
		switch event.kind {
		case "payout":
			syncCreditUserQuotaCache(event.userID, event.amount, "pvp duel")
			RecordLog(event.userID, LogTypeSystem, common.NewMessage("PvP duel payout: {{quota}}", map[string]any{"quota": logger.FormatQuota(event.amount)}))
		case "refund":
			syncCreditUserQuotaCache(event.userID, event.amount, "pvp refund")
			RecordLog(event.userID, LogTypeSystem, common.NewMessage("PvP stake refunded: {{quota}}", map[string]any{"quota": logger.FormatQuota(event.amount)}))
		case "forfeit":
			RecordLog(event.userID, LogTypeSystem, common.NewMessage("PvP duel opponent forfeited"))
		}
	}
}

func pvpSecret() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		sum := sha256.Sum256([]byte(common.GetUUID() + common.GetUUID()))
		return hex.EncodeToString(sum[:])
	}
	return hex.EncodeToString(buf)
}

func pvpSeed() int {
	buf := make([]byte, 4)
	_, _ = rand.Read(buf)
	return int(binary.BigEndian.Uint32(buf) & 0x7fffffff)
}

func pvpInviteCode() string {
	buf := make([]byte, 4)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

// pvpSignature is the anti-tamper tag over every client-authoritative field of
// an input batch. Clients build the identical string; a constant-time
// comparison on the server rejects forged or replayed packets.
func pvpSignature(secret, matchID string, slot, seq, from int, quit bool, inputs []int) string {
	quitBit := 0
	if quit {
		quitBit = 1
	}
	var message strings.Builder
	message.WriteString("pvp1|")
	message.WriteString(matchID)
	for _, part := range []int{slot, seq, from, quitBit} {
		message.WriteByte('|')
		message.WriteString(strconv.Itoa(part))
	}
	message.WriteByte('|')
	for i, input := range inputs {
		if i > 0 {
			message.WriteByte(',')
		}
		message.WriteString(strconv.Itoa(input))
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(message.String()))
	return hex.EncodeToString(mac.Sum(nil))
}

// pvpDebitStake escrows a stake with a conditional atomic update, so a
// concurrent spend can never drive the wallet negative.
func pvpDebitStake(tx *gorm.DB, userID, stake int) error {
	result := tx.Model(&User{}).Where("id = ? AND quota >= ? AND status = ?", userID, stake, common.UserStatusEnabled).Update("quota", gorm.Expr("quota - ?", stake))
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrPvPQuota
	}
	return nil
}

// creditPvP credits quota inside a transaction behind an idempotent ledger
// row. The wallet cap can truncate a credit; the missing remainder lands in a
// separate overflow ledger row with a loud log line instead of vanishing.
func creditPvP(tx *gorm.DB, key, overflowKey, matchID string, userID, amount int, kind string, now time.Time) (int, error) {
	ledger := PvPLedger{ID: key, MatchID: matchID, UserID: userID, Amount: amount, Kind: kind, CreatedAt: now.UnixMilli()}
	result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&ledger)
	if result.Error != nil {
		return 0, result.Error
	}
	if result.RowsAffected == 0 {
		return 0, nil // already settled by an earlier run
	}
	var user User
	if err := lockForUpdate(tx).First(&user, userID).Error; err != nil {
		return 0, err
	}
	credit := min(amount, max(0, common.MaxWalletQuota-user.Quota))
	if credit > 0 {
		result = tx.Model(&User{}).Where("id = ? AND quota <= ?", userID, common.MaxWalletQuota-credit).Update("quota", gorm.Expr("quota + ?", credit))
		if result.Error != nil {
			return 0, result.Error
		}
		if result.RowsAffected != 1 {
			return 0, ErrPvPQuota
		}
	}
	if overflow := amount - credit; overflow > 0 {
		row := PvPLedger{ID: overflowKey, MatchID: matchID, UserID: userID, Amount: overflow, Kind: "overflow", CreatedAt: now.UnixMilli()}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; err != nil {
			return 0, err
		}
		common.SysError(common.LogText("pvp credit %d truncated to %d for user %d: wallet quota cap reached", amount, credit, userID))
	}
	return credit, nil
}

// pvpTolerated reports whether two post-escrow balances may pair after the
// longer-waiting player has waited waitSeconds. The band doubles every 15
// seconds and, once it covers any possible balance gap, matches everyone.
func pvpTolerated(balanceA, balanceB, waitSeconds int) bool {
	diff := balanceA - balanceB
	if diff < 0 {
		diff = -diff
	}
	base := max(int(common.QuotaPerUnit/10), min(balanceA, balanceB)/10)
	gap := int64(base)
	for range min(waitSeconds/15, 62) {
		if gap >= int64(common.MaxWalletQuota) {
			return true
		}
		gap <<= 1
	}
	return int64(diff) <= gap
}

// One active PvP state per account: either a waiting queue entry or a match
// that has not finished.
func pvpActiveConflict(tx *gorm.DB, userID int) (bool, error) {
	var count int64
	if err := tx.Model(&PvPQueueEntry{}).Where("user_id = ? AND status = ?", userID, "waiting").Count(&count).Error; err != nil {
		return false, err
	}
	if count > 0 {
		return true, nil
	}
	if err := tx.Model(&PvPMatch{}).Where("status IN ? AND (player1_id = ? OR player2_id = ?)", []string{"invited", "playing"}, userID, userID).Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

func pvpStakeLedger(tx *gorm.DB, matchID string, slot, userID, stake int, now time.Time) error {
	row := PvPLedger{ID: "stake:" + matchID + ":" + strconv.Itoa(slot), MatchID: matchID, UserID: userID, Amount: stake, Kind: "stake", CreatedAt: now.UnixMilli()}
	return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error
}

func pvpStartMatch(tx *gorm.DB, mode string, stake, player1, player2 int, now time.Time) (*PvPMatch, error) {
	seed := pvpSeed()
	state := tokengame.NewDuel(uint32(seed))
	encoded, err := common.Marshal(state)
	if err != nil {
		return nil, err
	}
	match := PvPMatch{
		ID: common.GetUUID(), Mode: mode, Status: "playing", Seed: seed, Stake: stake,
		Player1ID: player1, Player2ID: player2,
		Secret1: pvpSecret(), Secret2: pvpSecret(),
		StateJSON: string(encoded), CreatedAt: now.UnixMilli(), StartedAt: now.UnixMilli(),
	}
	if err := tx.Create(&match).Error; err != nil {
		return nil, err
	}
	return &match, nil
}

// JoinPvPQueue escrows the stake and pairs with the earliest same-stake
// waiter inside the current tolerance band; otherwise the caller waits and the
// maintenance loop retries pairing as the band widens.
func JoinPvPQueue(userID, stake int, now time.Time) (*PvPMatchView, bool, error) {
	settings, err := GetGameSettings()
	if err != nil {
		return nil, false, err
	}
	if !settings.PvpEnabled {
		return nil, false, ErrPvPDisabled
	}
	if stake < settings.PvpMinStake || stake > settings.PvpMaxStake {
		return nil, false, ErrPvPStake
	}
	var view *PvPMatchView
	queued := false
	escrowed := false
	err = DB.Transaction(func(tx *gorm.DB) error {
		var user User
		if err := lockForUpdate(tx).First(&user, userID).Error; err != nil {
			return err
		}
		busy, err := pvpActiveConflict(tx, userID)
		if err != nil {
			return err
		}
		if busy {
			return ErrPvPBusy
		}
		var entry PvPQueueEntry
		err = tx.Where("status = ? AND stake = ? AND user_id <> ?", "waiting", stake, userID).Order("enqueued_at ASC").First(&entry).Error
		if err == nil {
			waitSeconds := int((now.UnixMilli() - entry.EnqueuedAt) / 1000)
			if pvpTolerated(entry.Balance, user.Quota-stake, waitSeconds) {
				claim := tx.Model(&PvPQueueEntry{}).Where("id = ? AND status = ?", entry.ID, "waiting").Update("status", "matched")
				if claim.Error != nil {
					return claim.Error
				}
				if claim.RowsAffected == 1 {
					if err := pvpDebitStake(tx, userID, stake); err != nil {
						return err
					}
					escrowed = true
					match, err := pvpStartMatch(tx, "ranked", stake, entry.UserID, userID, now)
					if err != nil {
						return err
					}
					if err := pvpStakeLedger(tx, match.ID, 1, entry.UserID, stake, now); err != nil {
						return err
					}
					if err := pvpStakeLedger(tx, match.ID, 2, userID, stake, now); err != nil {
						return err
					}
					view, err = buildPvPMatchView(tx, match, userID, now)
					return err
				}
			}
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if err := pvpDebitStake(tx, userID, stake); err != nil {
			return err
		}
		escrowed = true
		// One ticket row per account (uniqueIndex); re-queueing rewrites the
		// existing row, and the refund key carries the enqueue timestamp so a
		// later waiting stint can never collide with a settled one.
		waiting := PvPQueueEntry{UserID: userID, Balance: user.Quota - stake, Stake: stake, EnqueuedAt: now.UnixMilli(), Status: "waiting"}
		err = tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "user_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"balance", "stake", "enqueued_at", "status"}),
		}).Create(&waiting).Error
		if err != nil {
			return err
		}
		queued = true
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	if escrowed {
		if err := cacheDecrUserQuota(userID, int64(stake)); err != nil {
			common.SysLog(common.LogText("failed to sync pvp stake debit to user quota cache: %s", err.Error()))
		}
	}
	return view, queued, nil
}

// pvpQueueRefundKey identifies one waiting stint; the enqueue timestamp keeps
// a re-queued ticket from colliding with an already refunded one.
func pvpQueueRefundKey(entry *PvPQueueEntry) string {
	key := strconv.FormatUint(uint64(entry.ID), 10) + ":" + strconv.FormatInt(entry.EnqueuedAt, 10)
	return key
}

func LeavePvPQueue(userID int, now time.Time) error {
	var events []pvpLogEvent
	err := DB.Transaction(func(tx *gorm.DB) error {
		var entry PvPQueueEntry
		err := lockForUpdate(tx).Where("user_id = ? AND status = ?", userID, "waiting").First(&entry).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := tx.Model(&PvPQueueEntry{}).Where("id = ?", entry.ID).Update("status", "cancelled").Error; err != nil {
			return err
		}
		key := pvpQueueRefundKey(&entry)
		credited, err := creditPvP(tx, "refund:queue:"+key, "overflow:queue:"+key, "", userID, entry.Stake, "refund", now)
		if err != nil {
			return err
		}
		events = append(events, pvpLogEvent{userID: userID, kind: "refund", amount: credited})
		return nil
	})
	if err != nil {
		return err
	}
	applyPvPEvents(events)
	return nil
}

// matchPvPQueue retries pairing among waiting entries; used by the maintenance
// loop for pairs whose bands only overlap after both players waited. Pairing is
// skipped while PvP is disabled so existing tickets simply age out and refund.
func matchPvPQueue(now time.Time) error {
	settings, err := GetGameSettings()
	if err != nil {
		return err
	}
	if !settings.PvpEnabled {
		return nil
	}
	var entries []PvPQueueEntry
	if err := DB.Where("status = ?", "waiting").Order("enqueued_at ASC").Limit(100).Find(&entries).Error; err != nil {
		return err
	}
	matched := map[uint]bool{}
	for i := range entries {
		if matched[entries[i].ID] {
			continue
		}
		for j := i + 1; j < len(entries); j++ {
			if matched[entries[j].ID] || entries[i].Stake != entries[j].Stake || entries[i].UserID == entries[j].UserID {
				continue
			}
			waitSeconds := int((now.UnixMilli() - entries[i].EnqueuedAt) / 1000)
			if !pvpTolerated(entries[i].Balance, entries[j].Balance, waitSeconds) {
				continue
			}
			created, err := pairPvPQueueEntries(&entries[i], &entries[j], now)
			if err != nil {
				return err
			}
			if created {
				matched[entries[i].ID] = true
				matched[entries[j].ID] = true
				break
			}
		}
	}
	return nil
}

// errPvPPairLost marks a pairing that lost its second ticket to a concurrent
// claim between the two UPDATEs; the transaction rolls back so the first
// ticket stays waiting and its escrow remains refundable instead of being
// stranded in "matched" with no duel.
var errPvPPairLost = errors.New("pvp queue ticket claimed concurrently")

func pairPvPQueueEntries(first, second *PvPQueueEntry, now time.Time) (bool, error) {
	created := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		claim := tx.Model(&PvPQueueEntry{}).Where("id = ? AND status = ?", first.ID, "waiting").Update("status", "matched")
		if claim.Error != nil || claim.RowsAffected == 0 {
			return claim.Error
		}
		claim = tx.Model(&PvPQueueEntry{}).Where("id = ? AND status = ?", second.ID, "waiting").Update("status", "matched")
		if claim.Error != nil {
			return claim.Error
		}
		if claim.RowsAffected == 0 {
			return errPvPPairLost
		}
		match, err := pvpStartMatch(tx, "ranked", first.Stake, first.UserID, second.UserID, now)
		if err != nil {
			return err
		}
		if err := pvpStakeLedger(tx, match.ID, 1, first.UserID, first.Stake, now); err != nil {
			return err
		}
		if err := pvpStakeLedger(tx, match.ID, 2, second.UserID, second.Stake, now); err != nil {
			return err
		}
		created = true
		return nil
	})
	if errors.Is(err, errPvPPairLost) {
		// Losing the race is an ordinary outcome, not a maintenance failure.
		return false, nil
	}
	return created, err
}

// CreatePvPFriendly opens an invite-coded duel; the creator's stake is
// escrowed immediately and the joiner's stake is bound at join time.
func CreatePvPFriendly(userID, stake int, now time.Time) (*PvPMatchView, error) {
	settings, err := GetGameSettings()
	if err != nil {
		return nil, err
	}
	if !settings.PvpEnabled {
		return nil, ErrPvPDisabled
	}
	if stake < settings.PvpMinStake || stake > settings.PvpMaxStake {
		return nil, ErrPvPStake
	}
	var match PvPMatch
	err = DB.Transaction(func(tx *gorm.DB) error {
		var user User
		if err := lockForUpdate(tx).First(&user, userID).Error; err != nil {
			return err
		}
		busy, err := pvpActiveConflict(tx, userID)
		if err != nil {
			return err
		}
		if busy {
			return ErrPvPBusy
		}
		if err := pvpDebitStake(tx, userID, stake); err != nil {
			return err
		}
		code := pvpInviteCode()
		match = PvPMatch{ID: common.GetUUID(), Mode: "friendly", Status: "invited", Stake: stake, Player1ID: userID, InviteCode: &code, Secret1: pvpSecret(), CreatedAt: now.UnixMilli()}
		if err := tx.Create(&match).Error; err != nil {
			return err
		}
		return pvpStakeLedger(tx, match.ID, 1, userID, stake, now)
	})
	if err != nil {
		return nil, err
	}
	if err := cacheDecrUserQuota(userID, int64(stake)); err != nil {
		common.SysLog(common.LogText("failed to sync pvp stake debit to user quota cache: %s", err.Error()))
	}
	return buildPvPMatchView(DB, &match, userID, now)
}

func JoinPvPFriendly(userID int, code string, now time.Time) (*PvPMatchView, error) {
	settings, err := GetGameSettings()
	if err != nil {
		return nil, err
	}
	if !settings.PvpEnabled {
		return nil, ErrPvPDisabled
	}
	var match PvPMatch
	err = DB.Transaction(func(tx *gorm.DB) error {
		// Lock the joiner's own user row first so the one-active-duel check
		// shares a serialization point with every other entry point (queue
		// join, room create); otherwise two concurrent joins of different
		// rooms could both pass the busy check and escrow twice.
		var user User
		if err := lockForUpdate(tx).First(&user, userID).Error; err != nil {
			return err
		}
		err := lockForUpdate(tx).Where("invite_code = ? AND status = ?", code, "invited").First(&match).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPvPInvite
		}
		if err != nil {
			return err
		}
		if match.Player1ID == userID {
			return ErrPvPInvite
		}
		busy, err := pvpActiveConflict(tx, userID)
		if err != nil {
			return err
		}
		if busy {
			return ErrPvPBusy
		}
		// The creator's stake is already escrowed, so the room stake is bounded
		// by the joiner's wallet alone.
		if err := pvpDebitStake(tx, userID, match.Stake); err != nil {
			return err
		}
		seed := pvpSeed()
		state := tokengame.NewDuel(uint32(seed))
		encoded, err := common.Marshal(state)
		if err != nil {
			return err
		}
		match.Player2ID = userID
		match.Secret2 = pvpSecret()
		match.Seed = seed
		match.StateJSON = string(encoded)
		match.StartedAt = now.UnixMilli()
		match.Status = "playing"
		if err := tx.Save(&match).Error; err != nil {
			return err
		}
		return pvpStakeLedger(tx, match.ID, 2, userID, match.Stake, now)
	})
	if err != nil {
		return nil, err
	}
	if err := cacheDecrUserQuota(userID, int64(match.Stake)); err != nil {
		common.SysLog(common.LogText("failed to sync pvp stake debit to user quota cache: %s", err.Error()))
	}
	return buildPvPMatchView(DB, &match, userID, now)
}

// pvpAllowedTicks is how far server time lets the authoritative simulation
// advance; the clamp bounds late packets after the duel should have ended.
func pvpAllowedTicks(match *PvPMatch, now time.Time) int {
	elapsed := int((now.UnixMilli() - match.StartedAt) / tokengame.TickMillis)
	return max(0, min(elapsed, tokengame.DuelDuration+tokengame.MaxInputBatch))
}

// pvpLoadInputs rebuilds each player's submitted stream from the stored
// batches; ticks nobody submitted stay zero (neutral).
func pvpLoadInputs(tx *gorm.DB, matchID string) (inputs1, inputs2 []int, err error) {
	var rows []PvPInput
	if err = tx.Where("match_id = ?", matchID).Order("player ASC, seq ASC").Find(&rows).Error; err != nil {
		return
	}
	streams := [2]*[]int{&inputs1, &inputs2}
	for _, row := range rows {
		var batch []int
		if err = common.Unmarshal([]byte(row.Inputs), &batch); err != nil {
			return
		}
		*streams[row.Player-1] = append(*streams[row.Player-1], batch...)
	}
	return inputs1, inputs2, nil
}

// SubmitPvPInput is the authoritative step: signature and strict sequencing
// are verified before anything touches the simulation, the batch is stored,
// and the duel advances no further than server time allows.
func SubmitPvPInput(userID int, matchID string, seq, from int, inputs []int, quit bool, sig string, now time.Time) (*PvPMatchView, error) {
	if seq < 1 || from < 0 || len(inputs) > tokengame.MaxInputBatch {
		return nil, ErrPvPInput
	}
	for _, input := range inputs {
		if !tokengame.ValidInput(input) {
			return nil, ErrPvPInput
		}
	}
	var view *PvPMatchView
	var events []pvpLogEvent
	err := DB.Transaction(func(tx *gorm.DB) error {
		var match PvPMatch
		if err := lockForUpdate(tx).Where("id = ?", matchID).First(&match).Error; err != nil {
			return err
		}
		if match.Player1ID != userID && match.Player2ID != userID {
			return ErrPvPNotFound
		}
		slot := 1
		secret, seqNow, cursor := match.Secret1, match.Seq1, match.Player1Cursor
		if match.Player2ID == userID {
			slot, secret, seqNow, cursor = 2, match.Secret2, match.Seq2, match.Player2Cursor
		}
		if match.Status != "playing" {
			// Finished or cancelled: replays of the final batch are idempotent.
			var err error
			view, err = buildPvPMatchView(tx, &match, userID, now)
			return err
		}
		if seq != seqNow+1 {
			return ErrPvPInput
		}
		expected := pvpSignature(secret, match.ID, slot, seq, from, quit, inputs)
		if subtle.ConstantTimeCompare([]byte(sig), []byte(expected)) != 1 {
			return ErrPvPInput
		}
		allowed := pvpAllowedTicks(&match, now)
		if from != cursor || from+len(inputs) > allowed+2 {
			return ErrPvPInput
		}
		encoded, err := common.Marshal(inputs)
		if err != nil {
			return err
		}
		batch := PvPInput{MatchID: match.ID, Player: slot, Seq: seq, FromTick: from, Inputs: string(encoded), Quit: quit, ReceivedAt: now.UnixMilli()}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&batch).Error; err != nil {
			return err
		}
		if slot == 1 {
			match.Player1Cursor, match.Seq1 = from+len(inputs), seq
		} else {
			match.Player2Cursor, match.Seq2 = from+len(inputs), seq
		}
		inputs1, inputs2, err := pvpLoadInputs(tx, match.ID)
		if err != nil {
			return err
		}
		var state tokengame.DuelState
		if err := common.Unmarshal([]byte(match.StateJSON), &state); err != nil {
			return err
		}
		tokengame.AdvanceDuel(&state, allowed, inputs1, inputs2)
		if quit {
			state.Forfeit(slot - 1)
		}
		encoded, err = common.Marshal(state)
		if err != nil {
			return err
		}
		match.StateJSON = string(encoded)
		if state.Finished {
			if err := settlePvPMatch(tx, &match, &state, quit, now, &events); err != nil {
				return err
			}
		} else if err := tx.Save(&match).Error; err != nil {
			return err
		}
		view, err = buildPvPMatchView(tx, &match, userID, now)
		return err
	})
	if err != nil {
		return nil, err
	}
	applyPvPEvents(events)
	return view, nil
}

// settlePvPMatch finalizes a finished duel and moves the escrowed pot. The
// status transition plus idempotent ledger keys make repeated calls free.
func settlePvPMatch(tx *gorm.DB, match *PvPMatch, state *tokengame.DuelState, forfeit bool, now time.Time, events *[]pvpLogEvent) error {
	if match.Status == "finished" {
		return nil
	}
	if !state.Finished || state.Winner == 0 {
		return ErrPvPInput
	}
	match.WinnerSlot = state.Winner
	match.Draw = state.Winner == 3
	match.Player1Score = state.Players[0].Score
	match.Player2Score = state.Players[1].Score
	match.FinishedAt = now.UnixMilli()
	match.Status = "finished"
	switch state.Winner {
	case 3:
		for slot := 1; slot <= 2; slot++ {
			userID := match.playerID(slot)
			credited, err := creditPvP(tx, "refund:"+match.ID+":"+strconv.Itoa(slot), "overflow:"+match.ID+":"+strconv.Itoa(slot), match.ID, userID, match.Stake, "refund", now)
			if err != nil {
				return err
			}
			*events = append(*events, pvpLogEvent{userID: userID, kind: "refund", amount: credited})
		}
	case 1, 2:
		winner := match.playerID(state.Winner)
		credited, err := creditPvP(tx, "payout:"+match.ID, "overflow:"+match.ID, match.ID, winner, match.Stake*2, "payout", now)
		if err != nil {
			return err
		}
		*events = append(*events, pvpLogEvent{userID: winner, kind: "payout", amount: credited})
		if forfeit {
			*events = append(*events, pvpLogEvent{userID: winner, kind: "forfeit"})
		}
	}
	return tx.Save(match).Error
}

type PvPPlayerView struct {
	Slot   int    `json:"slot"`
	Secret string `json:"secret,omitempty"`
	Cursor int    `json:"cursor"`
	Seq    int    `json:"seq"`
	Score  int    `json:"score"`
	HP     int    `json:"hp"`
}

type PvPOpponentView struct {
	ID          int    `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Cursor      int    `json:"cursor"`
	Score       int    `json:"score"`
	HP          int    `json:"hp"`
}

type PvPMatchView struct {
	ID            string               `json:"id"`
	Mode          string               `json:"mode"`
	Status        string               `json:"status"`
	Stake         int                  `json:"stake"`
	Seed          int                  `json:"seed"`
	You           PvPPlayerView        `json:"you"`
	Opponent      PvPOpponentView      `json:"opponent"`
	State         *tokengame.DuelState `json:"state"`
	WinnerSlot    int                  `json:"winner_slot"`
	YouDeltaQuota *int                 `json:"you_delta_quota"`
	InviteCode    *string              `json:"invite_code"`
	CreatedAt     int64                `json:"created_at"`
	StartedAt     int64                `json:"started_at"`
	FinishedAt    int64                `json:"finished_at"`
	ServerTime    int64                `json:"server_time"`
}

// buildPvPMatchView renders the caller's side of a duel. Only the caller's own
// signing secret is ever included; the opponent view carries no secrets.
func buildPvPMatchView(tx *gorm.DB, match *PvPMatch, userID int, now time.Time) (*PvPMatchView, error) {
	view := &PvPMatchView{
		ID: match.ID, Mode: match.Mode, Status: match.Status, Stake: match.Stake, Seed: match.Seed,
		WinnerSlot: match.WinnerSlot, InviteCode: match.InviteCode,
		CreatedAt: match.CreatedAt, StartedAt: match.StartedAt, FinishedAt: match.FinishedAt,
		ServerTime: now.UnixMilli(),
	}
	slot := 2
	if match.Player1ID == userID {
		slot = 1
	}
	view.You = PvPPlayerView{Slot: slot}
	view.You.Seq = match.Seq1
	view.You.Cursor = match.Player1Cursor
	if slot == 2 {
		view.You.Seq = match.Seq2
		view.You.Cursor = match.Player2Cursor
	}
	if match.Player1ID == userID {
		view.You.Secret = match.Secret1
	} else {
		view.You.Secret = match.Secret2
	}
	opponentID := match.playerID(3 - slot)
	if opponentID != 0 {
		var opponent User
		if err := tx.First(&opponent, opponentID).Error; err != nil {
			return nil, err
		}
		view.Opponent = PvPOpponentView{ID: opponentID, Name: opponent.Username, DisplayName: opponent.DisplayName}
	}
	if match.StateJSON != "" {
		state := &tokengame.DuelState{}
		if err := common.Unmarshal([]byte(match.StateJSON), state); err != nil {
			return nil, err
		}
		if match.Status == "playing" {
			view.State = state
		}
		you, opponent := state.Players[slot-1], state.Players[2-slot]
		view.You.Score, view.You.HP, view.You.Cursor = you.Score, you.HP, you.Cursor
		view.Opponent.Score, view.Opponent.HP, view.Opponent.Cursor = opponent.Score, opponent.HP, opponent.Cursor
	}
	if match.Status == "finished" {
		delta := -match.Stake
		if match.WinnerSlot == 3 {
			delta = 0
		}
		if match.WinnerSlot == slot {
			delta = match.Stake
		}
		view.YouDeltaQuota = &delta
	}
	return view, nil
}

// GetPvPMatchView returns the caller's active duel, or the most recent
// finished one so clients can poll a settled result.
func GetPvPMatchView(userID int, now time.Time) (*PvPMatchView, error) {
	var match PvPMatch
	err := DB.Where("status IN ? AND (player1_id = ? OR player2_id = ?)", []string{"invited", "playing"}, userID, userID).Order("created_at DESC").First(&match).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		err = DB.Where("status = ? AND (player1_id = ? OR player2_id = ?)", "finished", userID, userID).Order("created_at DESC").First(&match).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
	}
	if err != nil {
		return nil, err
	}
	return buildPvPMatchView(DB, &match, userID, now)
}

type PvPQueueView struct {
	Waiting  bool  `json:"waiting"`
	WaitedMS int64 `json:"waited_ms"`
	Stake    int   `json:"stake"`
}

type PvPStatusView struct {
	Enabled    bool          `json:"enabled"`
	MinStake   int           `json:"min_stake"`
	MaxStake   int           `json:"max_stake"`
	Queue      *PvPQueueView `json:"queue"`
	Match      *PvPMatchView `json:"match"`
	ServerTime int64         `json:"server_time"`
}

func GetPvPStatus(userID int, now time.Time) (*PvPStatusView, error) {
	settings, err := GetGameSettings()
	if err != nil {
		return nil, err
	}
	view := &PvPStatusView{Enabled: settings.PvpEnabled, MinStake: settings.PvpMinStake, MaxStake: settings.PvpMaxStake, ServerTime: now.UnixMilli()}
	var entry PvPQueueEntry
	err = DB.Where("user_id = ? AND status = ?", userID, "waiting").First(&entry).Error
	if err == nil {
		view.Queue = &PvPQueueView{Waiting: true, WaitedMS: max(0, now.UnixMilli()-entry.EnqueuedAt), Stake: entry.Stake}
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	if view.Match, err = GetPvPMatchView(userID, now); err != nil {
		return nil, err
	}
	return view, nil
}

type PvPMatchSummary struct {
	ID            string `json:"id"`
	Mode          string `json:"mode"`
	Status        string `json:"status"`
	Stake         int    `json:"stake"`
	OpponentName  string `json:"opponent_name"`
	MyScore       int    `json:"my_score"`
	OpponentScore int    `json:"opponent_score"`
	Result        string `json:"result"`
	DeltaQuota    int    `json:"delta_quota"`
	CreatedAt     int64  `json:"created_at"`
	FinishedAt    int64  `json:"finished_at"`
}

func ListPvPMatches(userID, page, pageSize int) ([]PvPMatchSummary, int64, error) {
	var matches []PvPMatch
	var total int64
	query := DB.Where("player1_id = ? OR player2_id = ?", userID, userID)
	if err := query.Model(&PvPMatch{}).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if err := query.Order("created_at DESC").Limit(pageSize).Offset((page - 1) * pageSize).Find(&matches).Error; err != nil {
		return nil, 0, err
	}
	opponentIDs := map[int]bool{}
	for _, match := range matches {
		if match.Player1ID == userID {
			opponentIDs[match.Player2ID] = true
		} else {
			opponentIDs[match.Player1ID] = true
		}
	}
	names := map[int]string{}
	ids := make([]int, 0, len(opponentIDs))
	for id := range opponentIDs {
		if id != 0 {
			ids = append(ids, id)
		}
	}
	if len(ids) > 0 {
		var opponents []User
		if err := DB.Select("id, username, display_name").Where("id IN ?", ids).Find(&opponents).Error; err != nil {
			return nil, 0, err
		}
		for _, opponent := range opponents {
			if opponent.DisplayName != "" {
				names[opponent.Id] = opponent.DisplayName
			} else {
				names[opponent.Id] = opponent.Username
			}
		}
	}
	items := make([]PvPMatchSummary, 0, len(matches))
	for _, match := range matches {
		summary := PvPMatchSummary{ID: match.ID, Mode: match.Mode, Status: match.Status, Stake: match.Stake, CreatedAt: match.CreatedAt, FinishedAt: match.FinishedAt}
		opponentID := match.Player2ID
		summary.MyScore, summary.OpponentScore = match.Player1Score, match.Player2Score
		if match.Player2ID == userID {
			opponentID = match.Player1ID
			summary.MyScore, summary.OpponentScore = match.Player2Score, match.Player1Score
		}
		summary.OpponentName = names[opponentID]
		if match.Status == "finished" {
			summary.Result = "lose"
			summary.DeltaQuota = -match.Stake
			if (match.Player1ID == userID && match.WinnerSlot == 1) || (match.Player2ID == userID && match.WinnerSlot == 2) {
				summary.Result = "win"
				summary.DeltaQuota = match.Stake
			}
			if match.WinnerSlot == 3 {
				summary.Result = "draw"
				summary.DeltaQuota = 0
			}
		}
		items = append(items, summary)
	}
	return items, total, nil
}

type PvPReplayPlayer struct {
	Slot   int    `json:"slot"`
	UserID int    `json:"user_id"`
	Name   string `json:"name"`
	Score  int    `json:"score"`
}

type PvPReplayBatch struct {
	ID         uint  `json:"id"`
	Player     int   `json:"player"`
	Seq        int   `json:"seq"`
	FromTick   int   `json:"from_tick"`
	Inputs     []int `json:"inputs"`
	Quit       bool  `json:"quit"`
	ReceivedAt int64 `json:"received_at"`
}

type PvPReplayView struct {
	Seed       int               `json:"seed"`
	Stake      int               `json:"stake"`
	Players    []PvPReplayPlayer `json:"players"`
	WinnerSlot int               `json:"winner_slot"`
	Inputs     []PvPReplayBatch  `json:"inputs"`
	StartedAt  int64             `json:"started_at"`
	FinishedAt int64             `json:"finished_at"`
}

// GetPvPReplay returns the full input history, each batch tagged with its
// arrival time and insertion order so clients can replay the authoritative
// execution sequence; only duelists can fetch their own matches.
func GetPvPReplay(userID int, matchID string) (*PvPReplayView, error) {
	var match PvPMatch
	if err := DB.Where("id = ?", matchID).First(&match).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPvPNotFound
		}
		return nil, err
	}
	if match.Player1ID != userID && match.Player2ID != userID {
		return nil, ErrPvPNotFound
	}
	rows := []PvPReplayPlayer{
		{Slot: 1, UserID: match.Player1ID, Score: match.Player1Score},
		{Slot: 2, UserID: match.Player2ID, Score: match.Player2Score},
	}
	users := map[int]string{}
	for i := range rows {
		if rows[i].UserID == 0 {
			continue
		}
		var user User
		if err := DB.First(&user, rows[i].UserID).Error; err != nil {
			return nil, err
		}
		if user.DisplayName != "" {
			users[rows[i].UserID] = user.DisplayName
		} else {
			users[rows[i].UserID] = user.Username
		}
	}
	for i := range rows {
		rows[i].Name = users[rows[i].UserID]
	}
	var batches []PvPInput
	if err := DB.Where("match_id = ?", matchID).Order("player ASC, seq ASC").Find(&batches).Error; err != nil {
		return nil, err
	}
	inputs := make([]PvPReplayBatch, 0, len(batches))
	for _, batch := range batches {
		var decoded []int
		if err := common.Unmarshal([]byte(batch.Inputs), &decoded); err != nil {
			return nil, err
		}
		if decoded == nil {
			decoded = []int{}
		}
		inputs = append(inputs, PvPReplayBatch{ID: batch.ID, Player: batch.Player, Seq: batch.Seq, FromTick: batch.FromTick, Inputs: decoded, Quit: batch.Quit, ReceivedAt: batch.ReceivedAt})
	}
	return &PvPReplayView{Seed: match.Seed, Stake: match.Stake, Players: rows, WinnerSlot: match.WinnerSlot, Inputs: inputs, StartedAt: match.StartedAt, FinishedAt: match.FinishedAt}, nil
}

// forceFinishPvP ends an abandoned duel with neutral inputs and settles it.
func forceFinishPvP(match *PvPMatch, now time.Time) error {
	var events []pvpLogEvent
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ?", match.ID).First(match).Error; err != nil {
			return err
		}
		if match.Status != "playing" {
			return nil
		}
		inputs1, inputs2, err := pvpLoadInputs(tx, match.ID)
		if err != nil {
			return err
		}
		var state tokengame.DuelState
		if err := common.Unmarshal([]byte(match.StateJSON), &state); err != nil {
			return err
		}
		tokengame.AdvanceDuel(&state, tokengame.DuelDuration, inputs1, inputs2)
		encoded, err := common.Marshal(state)
		if err != nil {
			return err
		}
		match.StateJSON = string(encoded)
		return settlePvPMatch(tx, match, &state, false, now, &events)
	})
	if err != nil {
		return err
	}
	applyPvPEvents(events)
	return nil
}

func cancelPvPInvite(match *PvPMatch, now time.Time) error {
	var events []pvpLogEvent
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ?", match.ID).First(match).Error; err != nil {
			return err
		}
		if match.Status != "invited" {
			return nil
		}
		match.Status = "cancelled"
		match.FinishedAt = now.UnixMilli()
		credited, err := creditPvP(tx, "refund:"+match.ID+":1", "overflow:"+match.ID+":1", match.ID, match.Player1ID, match.Stake, "refund", now)
		if err != nil {
			return err
		}
		events = append(events, pvpLogEvent{userID: match.Player1ID, kind: "refund", amount: credited})
		return tx.Save(match).Error
	})
	if err != nil {
		return err
	}
	applyPvPEvents(events)
	return nil
}

func refundQueueEntry(entry *PvPQueueEntry, now time.Time) error {
	var events []pvpLogEvent
	err := DB.Transaction(func(tx *gorm.DB) error {
		claim := tx.Model(&PvPQueueEntry{}).Where("id = ? AND status = ?", entry.ID, "waiting").Update("status", "cancelled")
		if claim.Error != nil || claim.RowsAffected == 0 {
			return claim.Error
		}
		key := pvpQueueRefundKey(entry)
		credited, err := creditPvP(tx, "refund:queue:"+key, "overflow:queue:"+key, "", entry.UserID, entry.Stake, "refund", now)
		if err != nil {
			return err
		}
		events = append(events, pvpLogEvent{userID: entry.UserID, kind: "refund", amount: credited})
		return nil
	})
	if err != nil {
		return err
	}
	applyPvPEvents(events)
	return nil
}

// MaintainPvP retries matchmaking, refunds stale queue entries and invites,
// and force-settles duels whose input window has closed.
func MaintainPvP(now time.Time) error {
	if err := matchPvPQueue(now); err != nil {
		return err
	}
	var stale []PvPQueueEntry
	if err := DB.Where("status = ? AND enqueued_at < ?", "waiting", now.Add(-pvpQueueWaitLimit).UnixMilli()).Limit(100).Find(&stale).Error; err != nil {
		return err
	}
	for i := range stale {
		if err := refundQueueEntry(&stale[i], now); err != nil {
			return err
		}
	}
	var expired []PvPMatch
	if err := DB.Where("status = ? AND created_at < ?", "invited", now.Add(-pvpInviteTimeout).UnixMilli()).Limit(100).Find(&expired).Error; err != nil {
		return err
	}
	for i := range expired {
		if err := cancelPvPInvite(&expired[i], now); err != nil {
			return err
		}
	}
	deadline := int64(tokengame.DuelDuration+tokengame.MaxInputBatch+30) * tokengame.TickMillis
	var running []PvPMatch
	if err := DB.Where("status = ? AND started_at < ?", "playing", now.UnixMilli()-deadline).Limit(50).Find(&running).Error; err != nil {
		return err
	}
	for i := range running {
		if err := forceFinishPvP(&running[i], now); err != nil {
			return err
		}
	}
	return nil
}

func RunPvPMaintenance() {
	for {
		if err := MaintainPvP(time.Now()); err != nil {
			common.SysError(common.LogText("pvp maintenance failed: %s", err.Error()))
		}
		time.Sleep(5 * time.Second)
	}
}
