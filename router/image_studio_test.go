package router

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"maps"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestImageStudioSessionRelay(t *testing.T) {
	setupRelayRouterTestDB(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Channel{}, &model.Log{}, &model.UserSession{}, &model.UserSubscription{}, &model.UserAccessToken{}, &model.AuthFlow{}))
	sqlDB, err := model.DB.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	previousMemory, previousBatch, previousLog := common.MemoryCacheEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled
	previousPrices := ratio_setting.ModelPrice2JSONString()
	common.MemoryCacheEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled = false, false, true
	require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(`{"studio-image-test":0.01,"studio-chat-image-test":0.01,"gemini-2.5-flash-image":0.01}`))
	t.Cleanup(func() {
		common.MemoryCacheEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled = previousMemory, previousBatch, previousLog
		require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(previousPrices))
	})
	user := model.User{Username: "image-studio-user", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Group: "default", Quota: 1000000, AuthVersion: 1, Setting: `{"billing_preference":"wallet_only"}`}
	require.NoError(t, model.DB.Create(&user).Error)
	session, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "studio-test")
	require.NoError(t, err)
	var calls atomic.Int32
	var fail atomic.Bool
	png, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1sAAAAASUVORK5CYII=")
	require.NoError(t, err)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if strings.Contains(r.URL.Path, "/models/gemini-2.5-flash-image:generateContent") {
			if r.Header.Get("x-goog-api-key") != "channel-test-key" {
				t.Error("Gemini must receive the channel credential")
			}
			var request dto.GeminiChatRequest
			if err := common.DecodeJson(r.Body, &request); err != nil {
				t.Error(err)
			}
			if len(request.GenerationConfig.ResponseModalities) != 2 {
				t.Error("Gemini image output must be enabled")
			}
			var imageConfig map[string]any
			if err := common.Unmarshal(request.GenerationConfig.ImageConfig, &imageConfig); err != nil || imageConfig["aspectRatio"] != "1:1" {
				t.Errorf("Gemini image ratio = %v, want 1:1", imageConfig["aspectRatio"])
			}
			var responseFormat map[string]map[string]any
			if err := common.Unmarshal(request.GenerationConfig.ResponseFormat, &responseFormat); err != nil || responseFormat["image"]["aspectRatio"] != "1:1" {
				t.Errorf("Gemini response format ratio = %v, want 1:1", responseFormat["image"]["aspectRatio"])
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"candidates":[{"content":{"role":"model","parts":[{"inlineData":{"mimeType":"image/png","data":"aGVsbG8="}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20,"totalTokenCount":30}}`))
			return
		}
		if r.Header.Get("Authorization") != "Bearer channel-test-key" {
			t.Error("provider must receive only the channel credential")
		}
		if r.URL.RawQuery != "" {
			t.Error("dashboard query parameters leaked upstream")
		}
		if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			defer r.MultipartForm.RemoveAll()
			file, header, err := r.FormFile("image")
			if err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			data, _ := io.ReadAll(file)
			file.Close()
			if !bytes.Equal(data, png) || header.Filename != "reference.png" || r.URL.Path != "/v1/images/edits" || r.FormValue("n") != "1" {
				t.Error("invalid image editing payload")
			}
		} else {
			var body map[string]any
			if err := common.DecodeJson(r.Body, &body); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			if _, found := body["group"]; found {
				t.Error("group must not be forwarded")
			}
			if _, found := body["key"]; found {
				t.Error("injected credential must not be forwarded")
			}
			if _, found := body["extra"]; found {
				t.Error("unvalidated multipliers must not be forwarded")
			}
			if r.URL.Path == "/v1/chat/completions" && body["image_config"] == nil {
				if body["model"] != "studio-chat-image-test" || body["messages"] == nil {
					t.Error("invalid translation relay payload")
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"id":"translation-test","object":"chat.completion","model":"studio-chat-image-test","choices":[{"index":0,"message":{"role":"assistant","content":"translated source"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":10,"total_tokens":20}}`))
				return
			}
			if r.URL.Path == "/v1/chat/completions" {
				imageConfig, _ := body["image_config"].(map[string]any)
				responseFormat, _ := body["response_format"].(map[string]any)
				ratio, _ := responseFormat["aspect_ratio"].(string)
				expectedSizes := map[string]string{"1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536", "16:9": "1536x864"}
				if body["stream"] != false || body["messages"] == nil || body["size"] != expectedSizes[ratio] || imageConfig["aspect_ratio"] != ratio || imageConfig["image_size"] != "1K" || responseFormat["type"] != "image" || responseFormat["image_size"] != "1K" {
					t.Error("invalid chat image payload")
				}
			} else if r.URL.Path != "/v1/images/generations" || body["n"] != float64(1) || body["prompt"] != "A quiet landscape" {
				t.Errorf("invalid generation payload: %v", body)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		if fail.Load() {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":{"message":"provider rejected prompt","type":"invalid_request_error"}}`))
			return
		}
		if r.URL.Path == "/v1/chat/completions" {
			_, _ = w.Write([]byte(`{"id":"chat-test","object":"chat.completion","model":"studio-chat-image-test","choices":[{"index":0,"message":{"role":"assistant","content":"![image](data:image/png;base64,aGVsbG8=)"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":10,"total_tokens":20}}`))
		} else {
			_, _ = w.Write([]byte(`{"created":123,"data":[{"b64_json":"aGVsbG8="}]}`))
		}
	}))
	defer upstream.Close()
	channel := model.Channel{Type: constant.ChannelTypeOpenAI, Key: "channel-test-key", Status: common.ChannelStatusEnabled, Name: "studio-test", BaseURL: &upstream.URL, Models: "studio-image-test,studio-chat-image-test,text-only", Group: "default"}
	require.NoError(t, channel.Insert())
	geminiChannel := model.Channel{Type: constant.ChannelTypeGemini, Key: "channel-test-key", Status: common.ChannelStatusEnabled, Name: "studio-gemini-test", BaseURL: &upstream.URL, Models: "gemini-2.5-flash-image", Group: "default"}
	require.NoError(t, geminiChannel.Insert())
	engine := gin.New()
	SetRelayRouter(engine)
	send := func(body io.Reader, contentType, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/pg/image-studio?key=must-not-forward", body)
		req.Header.Set("Content-Type", contentType)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		engine.ServeHTTP(rec, req)
		return rec
	}
	request := map[string]any{"model": "studio-image-test", "prompt": "A quiet landscape", "n": 1, "protocol": "images", "size": "1024x1024", "key": "injected", "extra": map[string]any{"n": 99999999}}
	encode := func(v any) io.Reader {
		data, err := common.Marshal(v)
		require.NoError(t, err)
		return bytes.NewReader(data)
	}
	t.Run("unauthenticated request cannot spend quota", func(t *testing.T) {
		rec := send(encode(request), "application/json", "")
		require.Equal(t, 401, rec.Code, rec.Body.String())
		require.Zero(t, calls.Load())
	})
	t.Run("generation uses own group and charges user without API token", func(t *testing.T) {
		rec := send(encode(request), "application/json", session.AccessToken)
		require.Equal(t, 200, rec.Code, rec.Body.String())
		require.Contains(t, rec.Body.String(), "b64_json")
		var current model.User
		require.NoError(t, model.DB.First(&current, user.Id).Error)
		require.Equal(t, user.Quota-5000, current.Quota)
		var log model.Log
		require.NoError(t, model.DB.Where("type = ?", model.LogTypeConsume).Last(&log).Error)
		require.Equal(t, "image-studio", log.TokenName)
		require.Zero(t, log.TokenId)
		require.Equal(t, 5000, log.Quota)
	})
	t.Run("multipart image reaches edits endpoint", func(t *testing.T) {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		for key, value := range map[string]string{"model": "studio-image-test", "prompt": "A quiet landscape", "n": "1", "protocol": "images", "size": "1024x1024"} {
			require.NoError(t, writer.WriteField(key, value))
		}
		part, err := writer.CreateFormFile("image", "photo.png")
		require.NoError(t, err)
		_, err = part.Write(png)
		require.NoError(t, err)
		require.NoError(t, writer.Close())
		rec := send(&body, writer.FormDataContentType(), session.AccessToken)
		require.Equal(t, 200, rec.Code, rec.Body.String())
	})
	t.Run("chat image request preserves chat relay billing", func(t *testing.T) {
		rec := send(strings.NewReader(`{"model":"studio-chat-image-test","prompt":"A quiet landscape","n":1,"protocol":"chat","aspect_ratio":"16:9"}`), "application/json", session.AccessToken)
		require.Equal(t, 200, rec.Code, rec.Body.String())
		require.Contains(t, rec.Body.String(), "data:image/png")
	})
	t.Run("chat image request maps every supported ratio", func(t *testing.T) {
		for _, ratio := range []string{"1:1", "3:2", "2:3", "16:9"} {
			t.Run(ratio, func(t *testing.T) {
				rec := send(strings.NewReader(fmt.Sprintf(`{"model":"studio-chat-image-test","prompt":"A quiet landscape","n":1,"protocol":"chat","aspect_ratio":"%s"}`, ratio)), "application/json", session.AccessToken)
				require.Equal(t, 200, rec.Code, rec.Body.String())
			})
		}
	})
	t.Run("failed upstream request refunds reserved quota", func(t *testing.T) {
		before, err := model.GetUserQuota(user.Id, false)
		require.NoError(t, err)
		fail.Store(true)
		defer fail.Store(false)
		rec := send(encode(request), "application/json", session.AccessToken)
		require.Equal(t, 400, rec.Code, rec.Body.String())
		require.Eventually(t, func() bool { after, err := model.GetUserQuota(user.Id, false); return err == nil && after == before }, time.Second*3, time.Millisecond*10)
	})
	t.Run("native Gemini channel returns images through chat conversion", func(t *testing.T) {
		rec := send(strings.NewReader(`{"model":"gemini-2.5-flash-image","prompt":"A quiet landscape","n":1,"protocol":"chat","aspect_ratio":"1:1"}`), "application/json", session.AccessToken)
		require.Equal(t, 200, rec.Code, rec.Body.String())
		require.Contains(t, rec.Body.String(), "data:image/png;base64,aGVsbG8=")
	})
	t.Run("invalid inputs cannot reach the provider", func(t *testing.T) {
		before := calls.Load()
		for _, tc := range []struct {
			name, field string
			value       any
			status      int
		}{
			{"foreign group", "group", "other-team", 403},
			{"unavailable model", "model", "private-image-model", 403},
			{"not image model", "model", "text-only", 403},
			{"zero images", "n", 0, 400},
			{"negative images", "n", -1, 400},
			{"oversized image count", "n", dto.MaxImageN + 1, 400},
			{"wrapped image count", "n", uint64(18446744073686646784), 400},
			{"missing image count", "n", nil, 400},
			{"empty prompt", "prompt", " ", 400},
			{"long prompt", "prompt", strings.Repeat("画", 2001), 400},
			{"unknown protocol", "protocol", "other", 400},
			{"unsupported size", "size", "99999x99999", 400},
		} {
			t.Run(tc.name, func(t *testing.T) {
				payload := map[string]any{}
				for k, v := range request {
					payload[k] = v
				}
				payload[tc.field] = tc.value
				rec := send(encode(payload), "application/json", session.AccessToken)
				require.Equal(t, tc.status, rec.Code, rec.Body.String())
			})
		}
		for _, count := range []string{"1", "0", fmt.Sprint(dto.MaxImageN + 1)} {
			var body bytes.Buffer
			writer := multipart.NewWriter(&body)
			for key, value := range map[string]string{"model": "studio-image-test", "prompt": "A quiet landscape", "n": count, "protocol": "images", "size": "1024x1024"} {
				require.NoError(t, writer.WriteField(key, value))
			}
			part, err := writer.CreateFormFile("image", "fake.png")
			require.NoError(t, err)
			_, err = part.Write([]byte("<svg>not a raster image</svg>"))
			require.NoError(t, err)
			require.NoError(t, writer.Close())
			rec := send(&body, writer.FormDataContentType(), session.AccessToken)
			require.Equal(t, 400, rec.Code, rec.Body.String())
		}
		require.Equal(t, before, calls.Load())
	})
	t.Run("translation endpoint preserves session relay and billing", func(t *testing.T) {
		balance, err := model.GetUserQuota(user.Id, true)
		require.NoError(t, err)
		req := httptest.NewRequest(http.MethodPost, "/pg/translation-studio", strings.NewReader(`{"model":"studio-chat-image-test","group":"default","messages":[{"role":"user","content":"Translate this source"}],"max_tokens":32,"stream":false}`))
		req.Header.Set("Authorization", "Bearer "+session.AccessToken)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		engine.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		require.Contains(t, rec.Body.String(), "translated source")
		after, err := model.GetUserQuota(user.Id, true)
		require.NoError(t, err)
		require.Equal(t, balance-5000, after)
	})
	t.Run("retired studio flags do not block relay or change billing", func(t *testing.T) {
		common.OptionMapRWMutex.Lock()
		if common.OptionMap == nil {
			common.OptionMap = map[string]string{}
		}
		oldImage, hasImage := common.OptionMap["studio_setting.image_studio_enabled"]
		oldTranslation, hasTranslation := common.OptionMap["studio_setting.translation_studio_enabled"]
		common.OptionMap["studio_setting.image_studio_enabled"] = "false"
		common.OptionMap["studio_setting.translation_studio_enabled"] = "false"
		common.OptionMapRWMutex.Unlock()
		t.Cleanup(func() {
			common.OptionMapRWMutex.Lock()
			defer common.OptionMapRWMutex.Unlock()
			if hasImage {
				common.OptionMap["studio_setting.image_studio_enabled"] = oldImage
			} else {
				delete(common.OptionMap, "studio_setting.image_studio_enabled")
			}
			if hasTranslation {
				common.OptionMap["studio_setting.translation_studio_enabled"] = oldTranslation
			} else {
				delete(common.OptionMap, "studio_setting.translation_studio_enabled")
			}
		})
		before := calls.Load()
		balance, err := model.GetUserQuota(user.Id, true)
		require.NoError(t, err)
		rec := send(encode(request), "application/json", session.AccessToken)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		req := httptest.NewRequest(http.MethodPost, "/pg/translation-studio", strings.NewReader(`{"model":"studio-chat-image-test","group":"default","messages":[{"role":"user","content":"Translate this source"}],"max_tokens":32,"stream":false}`))
		req.Header.Set("Authorization", "Bearer "+session.AccessToken)
		req.Header.Set("Content-Type", "application/json")
		rec = httptest.NewRecorder()
		engine.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		require.Contains(t, rec.Body.String(), "translated source")
		require.Equal(t, before+2, calls.Load())
		after, err := model.GetUserQuota(user.Id, true)
		require.NoError(t, err)
		require.Equal(t, balance-10000, after)
	})
	t.Run("revoked session is rejected", func(t *testing.T) {
		_, err := model.RevokeUserSession(user.Id, session.Session.SID, "test")
		require.NoError(t, err)
		before := calls.Load()
		rec := send(encode(request), "application/json", session.AccessToken)
		require.Equal(t, 401, rec.Code, rec.Body.String())
		require.Equal(t, before, calls.Load())
	})
}

func TestCareerSpeechSessionRelay(t *testing.T) {
	setupRelayRouterTestDB(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Channel{}, &model.Log{}, &model.UserSession{}, &model.UserSubscription{}, &model.UserAccessToken{}, &model.AuthFlow{}))
	sqlDB, err := model.DB.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	previousMemory, previousBatch, previousLog, previousCount := common.MemoryCacheEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled, constant.CountToken
	previousPrices := ratio_setting.ModelPrice2JSONString()
	// TTS bills the counted input runes; production enables CountToken by default.
	common.MemoryCacheEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled, constant.CountToken = false, false, true, true
	require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(`{"career-tts-test":0.01,"text-only":0.01}`))
	t.Cleanup(func() {
		common.MemoryCacheEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled, constant.CountToken = previousMemory, previousBatch, previousLog, previousCount
		require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(previousPrices))
	})
	user := model.User{Username: "career-speech-user", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Group: "default", Quota: 1000000, AuthVersion: 1, Setting: `{"billing_preference":"wallet_only"}`}
	require.NoError(t, model.DB.Create(&user).Error)
	session, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "speech-test")
	require.NoError(t, err)
	suffix, err := common.GenerateRandomCharsKey(43)
	require.NoError(t, err)
	pat := model.AccessTokenPrefix + suffix
	patRow := &model.UserAccessToken{Name: "speech pat", TokenHash: model.AccessTokenFingerprint(pat), TokenHint: model.AccessTokenHint(pat)}
	require.NoError(t, patRow.SetScopes([]string{"profile:read"}))
	require.NoError(t, model.CreateUserAccessToken(user.Id, patRow, service.AccessTokenMaxPerUser))

	audio := []byte("ID3-fake-mp3-bytes")
	var calls atomic.Int32
	var fail atomic.Bool
	var lastBody atomic.Value
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v1/audio/speech", r.URL.Path)
		assert.Empty(t, r.URL.RawQuery, "dashboard query parameters leaked upstream")
		assert.Equal(t, "Bearer channel-test-key", r.Header.Get("Authorization"))
		var body map[string]any
		if !assert.NoError(t, common.DecodeJson(r.Body, &body)) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		lastBody.Store(body)
		if fail.Load() {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"provider rejected input","type":"invalid_request_error"}}`))
			return
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write(audio)
	}))
	defer upstream.Close()
	channel := model.Channel{Type: constant.ChannelTypeOpenAI, Key: "channel-test-key", Status: common.ChannelStatusEnabled, Name: "speech-test", BaseURL: &upstream.URL, Models: "career-tts-test,text-only", Group: "default"}
	require.NoError(t, channel.Insert())
	engine := gin.New()
	SetRelayRouter(engine)
	send := func(body io.Reader, contentType, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/pg/audio/speech?key=must-not-forward", body)
		req.Header.Set("Content-Type", contentType)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		engine.ServeHTTP(rec, req)
		return rec
	}
	request := map[string]any{"model": "career-tts-test", "input": "  请做一下自我介绍。 ", "voice": "alloy", "group": "default"}
	encode := func(v any) io.Reader {
		data, err := common.Marshal(v)
		require.NoError(t, err)
		return bytes.NewReader(data)
	}
	with := func(field string, value any) map[string]any {
		payload := maps.Clone(request)
		payload[field] = value
		return payload
	}

	t.Run("unauthenticated request cannot spend quota", func(t *testing.T) {
		rec := send(encode(request), "application/json", "")
		require.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
		require.Zero(t, calls.Load())
	})
	t.Run("personal access token is rejected", func(t *testing.T) {
		rec := send(encode(request), "application/json", pat)
		require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
		require.Zero(t, calls.Load())
	})
	t.Run("speech uses own group and charges the wallet", func(t *testing.T) {
		before, err := model.GetUserQuota(user.Id, true)
		require.NoError(t, err)
		rec := send(encode(request), "application/json", session.AccessToken)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.Equal(t, audio, rec.Body.Bytes())
		assert.Equal(t, "audio/mpeg", rec.Header().Get("Content-Type"))
		assert.Equal(t, map[string]any{"model": "career-tts-test", "input": "请做一下自我介绍。", "voice": "alloy", "speed": float64(1), "response_format": "mp3"}, lastBody.Load())
		after, err := model.GetUserQuota(user.Id, true)
		require.NoError(t, err)
		assert.Equal(t, before-int(0.01*common.QuotaPerUnit), after)
		var log model.Log
		require.NoError(t, model.DB.Where("type = ?", model.LogTypeConsume).Last(&log).Error)
		assert.Equal(t, "career-speech", log.TokenName)
		assert.Zero(t, log.TokenId)
	})
	t.Run("vendor passthrough fields never reach the provider", func(t *testing.T) {
		for name, extra := range map[string]map[string]any{
			"metadata text":         {"metadata": map[string]any{"text": strings.Repeat("长", 5000)}},
			"metadata request text": {"metadata": map[string]any{"request": map[string]any{"text": strings.Repeat("长", 5000)}, "app": map[string]any{"appid": "x"}}},
			"stream format":         {"stream_format": "sse"},
			"instructions":          {"instructions": "whisper"},
			"vllm reference audio":  {"ref_audio": "data:audio/wav;base64,AAAA", "max_new_tokens": 99999},
		} {
			t.Run(name, func(t *testing.T) {
				payload := maps.Clone(request)
				maps.Copy(payload, extra)
				payload["speed"] = 1.5
				rec := send(encode(payload), "application/json", session.AccessToken)
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
				body, _ := lastBody.Load().(map[string]any)
				assert.ElementsMatch(t, []string{"model", "input", "voice", "speed", "response_format"}, slices.Collect(maps.Keys(body)))
				assert.Equal(t, 1.5, body["speed"])
			})
		}
	})
	t.Run("invalid inputs cannot reach the provider", func(t *testing.T) {
		before := calls.Load()
		for _, tc := range []struct {
			name    string
			payload map[string]any
			status  int
		}{
			{"foreign group", with("group", "other-team"), http.StatusForbidden},
			{"unavailable model", with("model", "private-tts-model"), http.StatusForbidden},
			{"not speech model", with("model", "text-only"), http.StatusForbidden},
			{"empty input", with("input", ""), http.StatusBadRequest},
			{"whitespace input", with("input", " \n\t "), http.StatusBadRequest},
			{"long input", with("input", strings.Repeat("字", 2001)), http.StatusBadRequest},
			{"zero speed", with("speed", 0), http.StatusBadRequest},
			{"negative speed", with("speed", -1), http.StatusBadRequest},
			{"fast speed", with("speed", 2.01), http.StatusBadRequest},
			{"huge speed", with("speed", 1e308), http.StatusBadRequest},
			{"wav format", with("response_format", "wav"), http.StatusBadRequest},
			{"missing voice", with("voice", ""), http.StatusBadRequest},
			{"long voice", with("voice", strings.Repeat("v", 65)), http.StatusBadRequest},
			{"voice charset", with("voice", "a b<"), http.StatusBadRequest},
		} {
			t.Run(tc.name, func(t *testing.T) {
				rec := send(encode(tc.payload), "application/json", session.AccessToken)
				require.Equal(t, tc.status, rec.Code, rec.Body.String())
			})
		}
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		for key, value := range map[string]string{"model": "career-tts-test", "input": "hello", "voice": "alloy"} {
			require.NoError(t, writer.WriteField(key, value))
		}
		require.NoError(t, writer.Close())
		rec := send(&body, writer.FormDataContentType(), session.AccessToken)
		require.Equal(t, http.StatusUnsupportedMediaType, rec.Code, rec.Body.String())
		require.Equal(t, before, calls.Load())
	})
	t.Run("failed upstream request refunds reserved quota", func(t *testing.T) {
		before, err := model.GetUserQuota(user.Id, false)
		require.NoError(t, err)
		fail.Store(true)
		defer fail.Store(false)
		rec := send(encode(request), "application/json", session.AccessToken)
		require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
		require.Eventually(t, func() bool { after, err := model.GetUserQuota(user.Id, false); return err == nil && after == before }, time.Second*3, time.Millisecond*10)
	})
	t.Run("revoked session is rejected", func(t *testing.T) {
		_, err := model.RevokeUserSession(user.Id, session.Session.SID, "test")
		require.NoError(t, err)
		before := calls.Load()
		rec := send(encode(request), "application/json", session.AccessToken)
		require.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
		require.Equal(t, before, calls.Load())
	})
}
