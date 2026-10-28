package controller

import (
	"io"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
)

// careerSpeechMaxInputRunes bounds the TTS input, which is billed per rune.
const careerSpeechMaxInputRunes = 2000

var careerSpeechVoicePattern = regexp.MustCompile(`^[A-Za-z0-9_:./-]{1,64}$`)

// careerSpeechRequest is the only shape accepted from the dashboard; vendor
// fields such as metadata or instructions are never decoded or forwarded.
type careerSpeechRequest struct {
	Model          string   `json:"model"`
	Input          string   `json:"input"`
	Voice          string   `json:"voice"`
	Speed          *float64 `json:"speed"`
	ResponseFormat string   `json:"response_format"`
	Group          string   `json:"group"`
}

// PrepareCareerSpeech adapts a dashboard text-to-speech request to the
// existing /v1/audio/speech relay pipeline using the session's own group.
func PrepareCareerSpeech(c *gin.Context) {
	if _, ok := middleware.GetSessionAuthIdentity(c); !ok || c.GetBool("use_access_token") {
		imageStudioError(c, http.StatusForbidden, "A dashboard login session is required.")
		return
	}
	if c.ContentType() != "application/json" {
		imageStudioError(c, http.StatusUnsupportedMediaType, "Use JSON.")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
	var input careerSpeechRequest
	if err := common.UnmarshalBodyReusable(c, &input); err != nil {
		imageStudioError(c, http.StatusBadRequest, "Invalid speech request.")
		return
	}
	input.Input = strings.TrimSpace(input.Input)
	if input.Input == "" || utf8.RuneCountInString(input.Input) > careerSpeechMaxInputRunes {
		imageStudioError(c, http.StatusBadRequest, "Enter speech text of up to 2000 characters.")
		return
	}
	speed := 1.0
	if input.Speed != nil {
		speed = *input.Speed
	}
	// The negated range check also rejects NaN.
	if !(speed >= 0.5 && speed <= 2) {
		imageStudioError(c, http.StatusBadRequest, "Invalid speech speed.")
		return
	}
	if !careerSpeechVoicePattern.MatchString(input.Voice) {
		imageStudioError(c, http.StatusBadRequest, "Invalid voice.")
		return
	}
	if input.ResponseFormat != "" && input.ResponseFormat != "mp3" {
		imageStudioError(c, http.StatusBadRequest, "Unsupported audio format.")
		return
	}
	group := common.GetContextKeyString(c, constant.ContextKeyUserGroup)
	name := strings.ToLower(input.Model)
	isSpeechModel := strings.Contains(name, "tts") || strings.Contains(name, "speech") || strings.Contains(name, "cosyvoice")
	if group == "" || input.Group != "" && input.Group != group || !isSpeechModel || !slices.Contains(model.GetGroupEnabledModels(group), input.Model) {
		imageStudioError(c, http.StatusForbidden, "This voice model is not available in your current group.")
		return
	}
	body, err := common.Marshal(map[string]any{
		"model":           input.Model,
		"input":           input.Input,
		"voice":           input.Voice,
		"speed":           speed,
		"response_format": "mp3",
	})
	if err != nil {
		imageStudioError(c, http.StatusInternalServerError, "Could not prepare the speech request.")
		return
	}
	storage, err := common.CreateBodyStorage(body)
	if err != nil {
		imageStudioError(c, http.StatusInternalServerError, "Could not prepare the speech request.")
		return
	}
	common.CleanupBodyStorage(c)
	c.Set(common.KeyBodyStorage, storage)
	c.Request.Body = io.NopCloser(storage)
	c.Request.ContentLength = int64(len(body))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Request.Header.Del("Content-Length")
	// Relay mode detection and channel distribution only recognise this path.
	c.Request.URL.Path = "/v1/audio/speech"
	c.Request.URL.RawQuery = ""
	c.Request.Form, c.Request.PostForm, c.Request.MultipartForm = nil, nil, nil
	common.SetContextKey(c, constant.ContextKeyUsingGroup, group)
	if err := middleware.SetupContextForToken(c, &model.Token{UserId: c.GetInt("id"), Name: "career-speech", Group: group, UnlimitedQuota: true}); err != nil {
		imageStudioError(c, http.StatusInternalServerError, "Could not prepare the speech request.")
		return
	}
	if _, err := helper.GetAndValidateRequest(c, types.RelayFormatOpenAIAudio); err != nil {
		imageStudioError(c, http.StatusBadRequest, err.Error())
		return
	}
	c.Next()
}

func CareerSpeech(c *gin.Context) {
	Relay(c, types.RelayFormatOpenAIAudio)
}
