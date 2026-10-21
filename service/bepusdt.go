package service

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting"
	"github.com/shopspring/decimal"
)

var ErrBepusdtSignature = errors.New("invalid BEpusdt signature")
var ErrBepusdtPayload = errors.New("invalid BEpusdt payload")
var bepusdtMoneyPattern = regexp.MustCompile(`^[0-9]{1,14}([.][0-9]{1,2})?$`)
var bepusdtIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func SignBepusdt(values map[string]any, key string) (string, error) {
	if key == "" {
		return "", ErrBepusdtSignature
	}
	keys := make([]string, 0, len(values))
	for name := range values {
		if name == "signature" {
			continue
		}
		if name == "" || strings.ContainsAny(name, "&=") {
			return "", ErrBepusdtPayload
		}
		keys = append(keys, name)
	}
	sort.Strings(keys)
	var parts []string
	for _, name := range keys {
		value := values[name]
		if value == nil || value == "" {
			continue
		}
		switch typed := value.(type) {
		case string:
			if strings.Contains(typed, "&") {
				return "", ErrBepusdtPayload
			}
		case float64:
			if math.IsNaN(typed) || math.IsInf(typed, 0) {
				return "", ErrBepusdtPayload
			}
		case int, int64, bool:
		default:
			return "", ErrBepusdtPayload
		}
		parts = append(parts, fmt.Sprintf("%s=%v", name, value))
	}
	sum := md5.Sum([]byte(strings.Join(parts, "&") + key))
	return hex.EncodeToString(sum[:]), nil
}

func BepusdtMoneyCents(value string) (int64, error) {
	if !bepusdtMoneyPattern.MatchString(value) {
		return 0, ErrBepusdtPayload
	}
	amount, err := decimal.NewFromString(value)
	if err != nil || !amount.IsPositive() {
		return 0, ErrBepusdtPayload
	}
	cents := amount.Mul(decimal.NewFromInt(100))
	if !cents.IsInteger() || cents.GreaterThan(decimal.NewFromInt(common.MaxWalletQuota)) {
		return 0, ErrBepusdtPayload
	}
	return cents.IntPart(), nil
}

type BepusdtCheckout struct {
	Status     int    `json:"status"`
	TradeID    string `json:"trade_id"`
	OrderID    string `json:"order_id"`
	Amount     string `json:"amount"`
	Fiat       string `json:"fiat"`
	PaymentURL string `json:"payment_url"`
}

func CreateBepusdtCheckout(ctx context.Context, config setting.BepusdtConfig, orderID string, cents int64, notifyURL, returnURL string) (*BepusdtCheckout, error) {
	if !config.Ready() || cents <= 0 || cents > common.MaxWalletQuota || !strings.HasPrefix(orderID, "BEP-") || len(orderID) > 64 || !bepusdtIDPattern.MatchString(orderID) {
		return nil, ErrBepusdtPayload
	}
	amount := decimal.NewFromInt(cents).Div(decimal.NewFromInt(100))
	payload := map[string]any{"order_id": orderID, "amount": amount.InexactFloat64(), "fiat": "USD", "currencies": config.Currencies, "name": "New API credits", "timeout": 900, "notify_url": notifyURL, "redirect_url": returnURL}
	if !decimal.NewFromFloat(payload["amount"].(float64)).Equal(amount) {
		return nil, ErrBepusdtPayload
	}
	signature, err := SignBepusdt(payload, config.APIKey)
	if err != nil {
		return nil, err
	}
	payload["signature"] = signature
	body, err := common.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, config.BaseURL+"/api/v1/order/create-order", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("BEpusdt request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("BEpusdt request failed")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(raw) > 65536 {
		return nil, ErrBepusdtPayload
	}
	var result struct {
		StatusCode int             `json:"status_code"`
		Data       BepusdtCheckout `json:"data"`
	}
	if common.Unmarshal(raw, &result) != nil || result.StatusCode != 200 {
		return nil, errors.New("BEpusdt request failed")
	}
	paidCents, err := BepusdtMoneyCents(result.Data.Amount)
	if err != nil || paidCents != cents || result.Data.OrderID != orderID || result.Data.Fiat != "USD" || !bepusdtIDPattern.MatchString(result.Data.TradeID) || (result.Data.Status != 1 && result.Data.Status != 2 && result.Data.Status != 5) {
		return nil, ErrBepusdtPayload
	}
	result.Data.PaymentURL, err = bepusdtCheckoutURL(config.BaseURL, result.Data.PaymentURL)
	if err != nil {
		return nil, err
	}
	return &result.Data, nil
}

func bepusdtCheckoutURL(gateway, value string) (string, error) {
	base, err := url.Parse(gateway)
	if err != nil {
		return "", ErrBepusdtPayload
	}
	checkout, err := url.Parse(value)
	if err != nil || !strings.EqualFold(checkout.Host, base.Host) || checkout.User != nil || checkout.Fragment != "" || (checkout.Scheme != "http" && checkout.Scheme != "https") {
		return "", ErrBepusdtPayload
	}
	if base.Scheme == "https" {
		checkout.Scheme = "https"
	}
	return checkout.String(), nil
}

type BepusdtNotification struct {
	OrderID       string            `json:"order_id"`
	TradeID       string            `json:"trade_id"`
	Amount        common.RawMessage `json:"amount"`
	ActualAmount  string            `json:"actual_amount"`
	Token         string            `json:"token"`
	TransactionID string            `json:"block_transaction_id"`
	Status        int               `json:"status"`
	MoneyCents    int64             `json:"-"`
}

func VerifyBepusdtNotification(raw []byte, key string) (*BepusdtNotification, error) {
	var values map[string]any
	if err := common.Unmarshal(raw, &values); err != nil {
		return nil, ErrBepusdtPayload
	}
	provided, ok := values["signature"].(string)
	if !ok {
		return nil, ErrBepusdtSignature
	}
	expected, err := SignBepusdt(values, key)
	if err != nil {
		return nil, err
	}
	decoded, err := hex.DecodeString(provided)
	want, _ := hex.DecodeString(expected)
	if err != nil || subtle.ConstantTimeCompare(decoded, want) != 1 {
		return nil, ErrBepusdtSignature
	}
	var event BepusdtNotification
	if common.Unmarshal(raw, &event) != nil || !strings.HasPrefix(event.OrderID, "BEP-") || len(event.OrderID) > 64 || !bepusdtIDPattern.MatchString(event.OrderID) || !bepusdtIDPattern.MatchString(event.TradeID) || event.Status < 1 || event.Status > 6 {
		return nil, ErrBepusdtPayload
	}
	amount := string(event.Amount)
	if len(event.Amount) > 0 && event.Amount[0] == '"' {
		if common.Unmarshal(event.Amount, &amount) != nil {
			return nil, ErrBepusdtPayload
		}
	}
	event.MoneyCents, err = BepusdtMoneyCents(amount)
	if err != nil {
		return nil, err
	}
	if event.Status == 2 {
		if len(event.ActualAmount) > 128 || len(event.Token) > 256 || len(event.TransactionID) > 256 {
			return nil, ErrBepusdtPayload
		}
		actual, err := decimal.NewFromString(event.ActualAmount)
		if err != nil || !actual.IsPositive() || strings.TrimSpace(event.Token) == "" || strings.TrimSpace(event.TransactionID) == "" {
			return nil, ErrBepusdtPayload
		}
	}
	return &event, nil
}
