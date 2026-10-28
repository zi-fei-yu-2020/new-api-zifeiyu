package controller

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

func GetPvPStatus(c *gin.Context) {
	status, err := model.GetPvPStatus(c.GetInt("id"), time.Now())
	if err != nil {
		common.ApiErrorT(c, "Unable to load PvP status")
		return
	}
	common.ApiSuccess(c, status)
}

func JoinPvPQueue(c *gin.Context) {
	var body struct {
		Stake int `json:"stake"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.ApiErrorT(c, "Invalid PvP stake")
		return
	}
	view, queued, err := model.JoinPvPQueue(c.GetInt("id"), body.Stake, time.Now())
	if err != nil {
		respondPvPError(c, err, "Unable to join the PvP queue")
		return
	}
	common.ApiSuccess(c, gin.H{"queued": queued, "match": view})
}

func LeavePvPQueue(c *gin.Context) {
	if err := model.LeavePvPQueue(c.GetInt("id"), time.Now()); err != nil {
		respondPvPError(c, err, "Unable to leave the PvP queue")
		return
	}
	common.ApiSuccess(c, gin.H{"left": true})
}

func GetPvPMatch(c *gin.Context) {
	view, err := model.GetPvPMatchView(c.GetInt("id"), time.Now())
	if err != nil {
		respondPvPError(c, err, "Unable to load the PvP duel")
		return
	}
	common.ApiSuccess(c, view)
}

func SubmitPvPInput(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16384)
	var body struct {
		MatchID string `json:"match_id" binding:"required,max=40"`
		Seq     int    `json:"seq"`
		From    int    `json:"from"`
		Inputs  []int  `json:"inputs" binding:"max=300"`
		Quit    bool   `json:"quit"`
		Sig     string `json:"sig" binding:"required,len=64"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.ApiErrorT(c, "Invalid PvP input packet")
		return
	}
	view, err := model.SubmitPvPInput(c.GetInt("id"), body.MatchID, body.Seq, body.From, body.Inputs, body.Quit, body.Sig, time.Now())
	if err != nil {
		respondPvPError(c, err, "PvP input rejected. Refresh the duel and retry")
		return
	}
	common.ApiSuccess(c, view)
}

func CreatePvPFriendly(c *gin.Context) {
	var body struct {
		Stake int `json:"stake"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.ApiErrorT(c, "Invalid PvP stake")
		return
	}
	userID := c.GetInt("id")
	view, err := model.CreatePvPFriendly(userID, body.Stake, time.Now())
	if err != nil {
		respondPvPError(c, err, "Unable to create a friendly duel")
		return
	}
	common.ApiSuccess(c, gin.H{"code": *view.InviteCode, "match": view})
}

func JoinPvPFriendly(c *gin.Context) {
	var body struct {
		Code string `json:"code" binding:"required,max=16"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.ApiErrorT(c, "Invalid or expired PvP invite code")
		return
	}
	view, err := model.JoinPvPFriendly(c.GetInt("id"), body.Code, time.Now())
	if err != nil {
		respondPvPError(c, err, "Unable to join the friendly duel")
		return
	}
	common.ApiSuccess(c, gin.H{"match": view})
}

func ListPvPMatches(c *gin.Context) {
	page, err := strconv.Atoi(c.Query("page"))
	if err != nil || page < 1 {
		page = 1
	}
	pageSize, err := strconv.Atoi(c.Query("page_size"))
	if err != nil || pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 50 {
		pageSize = 50
	}
	items, total, err := model.ListPvPMatches(c.GetInt("id"), page, pageSize)
	if err != nil {
		common.ApiErrorT(c, "Unable to load PvP matches")
		return
	}
	common.ApiSuccess(c, gin.H{"items": items, "total": total})
}

func GetPvPReplay(c *gin.Context) {
	replay, err := model.GetPvPReplay(c.GetInt("id"), c.Param("id"))
	if err != nil {
		respondPvPError(c, err, "Unable to load the PvP replay")
		return
	}
	common.ApiSuccess(c, replay)
}

func respondPvPError(c *gin.Context, err error, fallback string) {
	switch {
	case errors.Is(err, model.ErrPvPDisabled):
		common.ApiErrorT(c, "PvP duels are currently disabled")
	case errors.Is(err, model.ErrPvPStake):
		common.ApiErrorT(c, "Invalid PvP stake")
	case errors.Is(err, model.ErrPvPBusy):
		common.ApiErrorT(c, "You already have an active PvP duel or queue entry")
	case errors.Is(err, model.ErrPvPQuota):
		common.ApiErrorT(c, "Insufficient quota for the stake")
	case errors.Is(err, model.ErrPvPInput):
		common.ApiErrorT(c, "PvP input rejected. Refresh the duel and retry")
	case errors.Is(err, model.ErrPvPNotFound):
		common.ApiErrorT(c, "PvP match not found")
	case errors.Is(err, model.ErrPvPInvite):
		common.ApiErrorT(c, "Invalid or expired PvP invite code")
	case errors.Is(err, model.ErrPvPReplayNotReady):
		common.ApiErrorT(c, "PvP replay is only available after the duel finishes")
	default:
		common.ApiErrorT(c, fallback)
	}
}
