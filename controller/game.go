package controller

import (
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// logGameError records the real cause server-side; responses stay generic.
func logGameError(action string, err error) {
	common.SysError(common.LogText("game center: failed to %s: %s", action, err.Error()))
}

func GetGameStatus(c *gin.Context) {
	now := time.Now()
	settings, err := model.GetGameSettings()
	if err != nil {
		logGameError("load game settings", err)
		common.ApiErrorT(c, "Unable to load the daily challenge")
		return
	}
	run, err := model.GetTodayGame(c.GetInt("id"), now)
	if err != nil {
		logGameError("load today's game", err)
		common.ApiErrorT(c, "Unable to load the daily challenge")
		return
	}
	budgets, err := model.GetGameBudgets(settings, now)
	if err != nil {
		logGameError("load game budgets", err)
		common.ApiErrorT(c, "Unable to load the daily challenge")
		return
	}
	day, week, reset := model.GameCalendar(now)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"settings": settings, "budgets": budgets, "run": run, "day": day, "week": week, "resets_at": reset, "server_time": now.UnixMilli()}})
}
func StartGame(c *gin.Context) {
	run, err := model.StartGame(c.GetInt("id"), time.Now())
	if err != nil {
		if errors.Is(err, model.ErrGameBudget) {
			common.ApiErrorT(c, "The daily reward budget cannot cover another run")
		} else if errors.Is(err, model.ErrGameClosed) {
			common.ApiErrorT(c, "The daily challenge is currently closed")
		} else {
			logGameError("start a game", err)
			common.ApiErrorT(c, "Unable to start the daily challenge. Please try again")
		}
		return
	}
	common.ApiSuccess(c, run)
}
func AdvanceGame(c *gin.Context) {
	var body struct {
		ID     string `json:"id" binding:"required,max=40"`
		From   int    `json:"from" binding:"min=0"`
		Inputs []int  `json:"inputs" binding:"max=300"`
		Quit   bool   `json:"quit"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	if err := c.ShouldBindJSON(&body); err != nil {
		common.ApiErrorT(c, "Invalid game input")
		return
	}
	run, err := model.AdvanceGame(c.GetInt("id"), body.ID, body.From, body.Inputs, body.Quit, time.Now())
	if err != nil {
		if !errors.Is(err, model.ErrGameInput) && !errors.Is(err, gorm.ErrRecordNotFound) {
			logGameError("advance a game", err)
		}
		common.ApiErrorT(c, "Game progress is out of sync. Reconnect to continue the same run")
		return
	}
	common.ApiSuccess(c, run)
}
func GetGameRankings(c *gin.Context) {
	rows, err := model.GetGameRanking(c.GetInt("id"), c.Query("period") == "week", time.Now())
	if err != nil {
		logGameError("load rankings", err)
		common.ApiErrorT(c, "Unable to load rankings")
		return
	}
	common.ApiSuccess(c, rows)
}
func UpdateGameSettings(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		common.ApiErrorT(c, "Invalid game reward settings")
		return
	}
	// Omitted fields keep their stored value rather than resetting to zero.
	stored, err := model.PatchGameSettings(body)
	if err != nil {
		if !errors.Is(err, model.ErrGameSettings) {
			logGameError("save game settings", err)
		}
		common.ApiErrorT(c, "Invalid game reward settings")
		return
	}
	common.ApiSuccess(c, stored)
}

func GetGameSettings(c *gin.Context) {
	settings, err := model.GetGameSettings()
	if err != nil {
		logGameError("load game settings", err)
		common.ApiErrorT(c, "Unable to load game settings")
		return
	}
	common.ApiSuccess(c, settings)
}

// Reward polling does not reload or advance the player's active game state.
func GetGameRewards(c *gin.Context) {
	now := time.Now()
	settings, err := model.GetGameSettings()
	if err != nil {
		logGameError("load game settings", err)
		common.ApiErrorT(c, "Unable to load game rewards")
		return
	}
	budgets, err := model.GetGameBudgets(settings, now)
	if err != nil {
		logGameError("load game budgets", err)
		common.ApiErrorT(c, "Unable to load game rewards")
		return
	}
	_, week, _ := model.GameCalendar(now)
	common.ApiSuccess(c, gin.H{"budgets": budgets, "week": week, "enabled": settings.Enabled, "rewards_enabled": settings.RewardsEnabled, "server_time": now.UnixMilli()})
}
