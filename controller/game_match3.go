package controller

import (
	"errors"
	"net/http"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func GetMatchStatus(c *gin.Context) {
	status, err := model.GetMatchStatus(c.GetInt("id"), time.Now())
	if err != nil {
		logGameError("load the tile game", err)
		common.ApiErrorT(c, "Unable to load the tile game")
		return
	}
	common.ApiSuccess(c, status)
}

func StartMatch(c *gin.Context) {
	var body struct {
		Mode string `json:"mode" binding:"required,oneof=daily endless"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1024)
	if err := c.ShouldBindJSON(&body); err != nil {
		common.ApiErrorT(c, "Invalid game input")
		return
	}
	run, err := model.StartMatch(c.GetInt("id"), body.Mode, time.Now())
	if err != nil {
		if errors.Is(err, model.ErrMatchClosed) || errors.Is(err, model.ErrMatchAttempts) {
			common.ApiErrorT(c, err.Error())
		} else {
			logGameError("start a tile game", err)
			common.ApiErrorT(c, "Unable to start the tile game. Please try again")
		}
		return
	}
	common.ApiSuccess(c, run)
}

func AdvanceMatch(c *gin.Context) {
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
	run, err := model.AdvanceMatch(c.GetInt("id"), body.ID, body.From, body.Inputs, body.Quit, time.Now())
	if err != nil {
		// Input errors are masked as one resync message and are not logged.
		if errors.Is(err, model.ErrMatchClosed) {
			common.ApiErrorT(c, err.Error())
			return
		}
		if !errors.Is(err, model.ErrMatchInput) && !errors.Is(err, gorm.ErrRecordNotFound) {
			logGameError("advance a tile game", err)
		}
		common.ApiErrorT(c, model.ErrMatchInput.Error())
		return
	}
	common.ApiSuccess(c, run)
}

func GetMatchRankings(c *gin.Context) {
	rows, err := model.GetMatchRanking(c.GetInt("id"), c.Query("mode"), time.Now())
	if err != nil {
		if errors.Is(err, model.ErrMatchInput) {
			common.ApiErrorT(c, "Invalid game input")
			return
		}
		logGameError("load tile game rankings", err)
		common.ApiErrorT(c, "Unable to load rankings")
		return
	}
	common.ApiSuccess(c, rows)
}
