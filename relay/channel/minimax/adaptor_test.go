package minimax

import (
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetRequestURLForImageGeneration(t *testing.T) {
	t.Parallel()

	info := &relaycommon.RelayInfo{
		RelayMode: relayconstant.RelayModeImagesGenerations,
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelBaseUrl: "https://api.minimax.chat",
		},
	}

	got, err := GetRequestURL(info)
	if err != nil {
		t.Fatalf("GetRequestURL returned error: %v", err)
	}

	want := "https://api.minimax.chat/v1/image_generation"
	if got != want {
		t.Fatalf("GetRequestURL() = %q, want %q", got, want)
	}
}

func TestConvertImageRequest(t *testing.T) {
	t.Parallel()

	adaptor := &Adaptor{}
	info := &relaycommon.RelayInfo{
		RelayMode:       relayconstant.RelayModeImagesGenerations,
		OriginModelName: "image-01",
	}
	request := dto.ImageRequest{
		Model:          "image-01",
		Prompt:         "a red fox in snowfall",
		Size:           "1536x1024",
		ResponseFormat: "url",
		N:              uintPtr(2),
	}

	got, err := adaptor.ConvertImageRequest(gin.CreateTestContextOnly(httptest.NewRecorder(), gin.New()), info, request)
	if err != nil {
		t.Fatalf("ConvertImageRequest returned error: %v", err)
	}

	body, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("json.Unmarshal returned error: %v", err)
	}

	if payload["model"] != "image-01" {
		t.Fatalf("model = %#v, want %q", payload["model"], "image-01")
	}
	if payload["prompt"] != request.Prompt {
		t.Fatalf("prompt = %#v, want %q", payload["prompt"], request.Prompt)
	}
	if payload["n"] != float64(2) {
		t.Fatalf("n = %#v, want 2", payload["n"])
	}
	if payload["aspect_ratio"] != "3:2" {
		t.Fatalf("aspect_ratio = %#v, want %q", payload["aspect_ratio"], "3:2")
	}
	if payload["response_format"] != "url" {
		t.Fatalf("response_format = %#v, want %q", payload["response_format"], "url")
	}
}

func TestDoResponseForImageGeneration(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)

	info := &relaycommon.RelayInfo{
		RelayMode: relayconstant.RelayModeImagesGenerations,
		StartTime: time.Unix(1700000000, 0),
	}
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       httptest.NewRecorder().Result().Body,
	}
	resp.Body = ioNopCloser(`{"data":{"image_urls":["https://example.com/minimax.png"]}}`)

	adaptor := &Adaptor{}
	usage, err := adaptor.DoResponse(c, resp, info)
	if err != nil {
		t.Fatalf("DoResponse returned error: %v", err)
	}
	if usage == nil {
		t.Fatalf("DoResponse returned nil usage")
	}

	body := recorder.Body.String()
	if !strings.Contains(body, `"url":"https://example.com/minimax.png"`) {
		t.Fatalf("response body = %s, want OpenAI image response with image URL", body)
	}
	if strings.Contains(body, `"image_urls"`) {
		t.Fatalf("response body = %s, should not expose raw MiniMax image_urls payload", body)
	}
}

func TestConvertAudioRequestAlwaysRequestsHexAudio(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name           string
		responseFormat string
		wantFormat     string
	}{
		{name: "mp3", responseFormat: "mp3", wantFormat: "mp3"},
		{name: "wav", responseFormat: "wav", wantFormat: "wav"},
		{name: "default", responseFormat: "", wantFormat: "mp3"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			c := gin.CreateTestContextOnly(httptest.NewRecorder(), gin.New())
			info := &relaycommon.RelayInfo{
				RelayMode:       relayconstant.RelayModeAudioSpeech,
				OriginModelName: "speech-02-turbo",
			}
			request := dto.AudioRequest{
				Model:          "speech-02-turbo",
				Input:          "你好",
				Voice:          "male-qn-qingse",
				ResponseFormat: tc.responseFormat,
			}

			reader, err := (&Adaptor{}).ConvertAudioRequest(c, info, request)
			require.NoError(t, err)
			body, err := io.ReadAll(reader)
			require.NoError(t, err)

			var payload map[string]any
			require.NoError(t, json.Unmarshal(body, &payload))
			assert.Equal(t, "hex", payload["output_format"])
			audioSetting, ok := payload["audio_setting"].(map[string]any)
			require.True(t, ok)
			assert.Equal(t, tc.wantFormat, audioSetting["format"])
			assert.Equal(t, "你好", payload["text"])
		})
	}
}

func TestDoResponseForTTSReturnsDecodedAudio(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name            string
		responseFormat  string
		wantContentType string
	}{
		{name: "mp3", responseFormat: "mp3", wantContentType: "audio/mpeg"},
		{name: "wav", responseFormat: "wav", wantContentType: "audio/wav"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			recorder := httptest.NewRecorder()
			c := gin.CreateTestContextOnly(recorder, gin.New())
			info := &relaycommon.RelayInfo{
				RelayMode:       relayconstant.RelayModeAudioSpeech,
				OriginModelName: "speech-02-turbo",
			}
			_, err := (&Adaptor{}).ConvertAudioRequest(c, info, dto.AudioRequest{
				Input:          "hi",
				Voice:          "male-qn-qingse",
				ResponseFormat: tc.responseFormat,
			})
			require.NoError(t, err)

			audio := []byte("ID3\x03audio-bytes")
			resp := &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body: ioNopCloser(`{"data":{"audio":"` + hex.EncodeToString(audio) +
					`","status":2},"extra_info":{"usage_characters":2},"base_resp":{"status_code":0}}`),
			}

			usage, apiErr := (&Adaptor{}).DoResponse(c, resp, info)
			require.Nil(t, apiErr)
			require.NotNil(t, usage)

			assert.Equal(t, http.StatusOK, recorder.Code)
			assert.Equal(t, tc.wantContentType, recorder.Header().Get("Content-Type"))
			assert.Equal(t, audio, recorder.Body.Bytes())
		})
	}
}

type nopReadCloser struct {
	*strings.Reader
}

func (n nopReadCloser) Close() error {
	return nil
}

func ioNopCloser(body string) nopReadCloser {
	return nopReadCloser{Reader: strings.NewReader(body)}
}

func uintPtr(v uint) *uint {
	return &v
}
