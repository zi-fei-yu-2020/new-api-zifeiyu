package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting"
	"github.com/stretchr/testify/require"
)

func TestBepusdtSignatureAndNotification(t *testing.T) {
	valid := []byte(`{"actual_amount":"1.25","amount":1.25,"block_transaction_id":"tx-123","order_id":"BEP-order-1","status":2,"token":"wallet-address","trade_id":"gateway-1","signature":"3fc0013efca364fd586e7c805fbd464c"}`)
	event, err := VerifyBepusdtNotification(valid, "test-secret")
	require.NoError(t, err)
	require.EqualValues(t, 125, event.MoneyCents)
	require.Equal(t, "BEP-order-1", event.OrderID)
	for _, body := range []string{
		strings.Replace(string(valid), "1.25", "0.25", 1),
		strings.Replace(string(valid), "BEP-order-1", "BEP-order-2", 1),
		strings.Replace(string(valid), "3fc0013efca364fd586e7c805fbd464c", "wrong", 1),
		"null",
	} {
		_, err := VerifyBepusdtNotification([]byte(body), "test-secret")
		require.Error(t, err)
	}
	_, err = VerifyBepusdtNotification(valid, "wrong-key")
	require.Error(t, err)
	_, err = SignBepusdt(map[string]any{"order_id": "one&amount=100"}, "test-secret")
	require.Error(t, err)
	_, err = SignBepusdt(map[string]any{"amount": []int{1, 2}}, "test-secret")
	require.Error(t, err)
	for _, value := range []string{"0", "-1", "0.001", "NaN", "1e100"} {
		_, err := BepusdtMoneyCents(value)
		require.Error(t, err)
	}
}

func TestBepusdtCheckoutValidatesGatewayResponse(t *testing.T) {
	for _, scenario := range []string{"valid", "wrong_amount", "wrong_order", "wrong_currency", "foreign_url", "failed_status", "invalid_json"} {
		t.Run(scenario, func(t *testing.T) {
			var gateway *httptest.Server
			gateway = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				require.Equal(t, "/api/v1/order/create-order", request.URL.Path)
				var payload map[string]any
				require.NoError(t, common.DecodeJson(request.Body, &payload))
				signature, err := SignBepusdt(payload, "test-secret")
				require.NoError(t, err)
				require.Equal(t, signature, payload["signature"])
				require.Equal(t, "USD", payload["fiat"])
				require.Equal(t, float64(1.25), payload["amount"])
				if scenario == "invalid_json" {
					_, _ = writer.Write([]byte("not-json"))
					return
				}
				data := BepusdtCheckout{Status: 1, OrderID: "BEP-order-1", TradeID: "gateway-1", Amount: "1.25", Fiat: "USD", PaymentURL: gateway.URL + "/pay/checkout/gateway-1"}
				switch scenario {
				case "wrong_amount":
					data.Amount = "1.26"
				case "wrong_order":
					data.OrderID = "another-order"
				case "wrong_currency":
					data.Fiat = "CNY"
				case "foreign_url":
					data.PaymentURL = "https://other.example/pay"
				case "failed_status":
					data.Status = 3
				}
				body, err := common.Marshal(map[string]any{"status_code": 200, "data": data})
				require.NoError(t, err)
				_, _ = writer.Write(body)
			}))
			defer gateway.Close()
			config := setting.BepusdtConfig{BaseURL: gateway.URL, APIKey: "test-secret", UnitPrice: "1", MinTopUp: 1, Currencies: "USDT,USDC"}
			result, err := CreateBepusdtCheckout(context.Background(), config, "BEP-order-1", 125, "https://console.example/api/bepusdt/notify", "https://console.example/wallet")
			if scenario == "valid" {
				require.NoError(t, err)
				require.Equal(t, "gateway-1", result.TradeID)
			} else {
				require.Error(t, err)
			}
		})
	}
}

func TestBepusdtCheckoutURLRetainsHTTPSBehindProxy(t *testing.T) {
	actual, err := bepusdtCheckoutURL("https://pay.example", "http://pay.example/pay/checkout/order")
	require.NoError(t, err)
	require.Equal(t, "https://pay.example/pay/checkout/order", actual)
	for _, target := range []string{"javascript:alert(1)", "https://evil.example/pay", "https://user@pay.example/pay", "//pay.example/pay"} {
		_, err = bepusdtCheckoutURL("https://pay.example", target)
		require.Error(t, err)
	}
}
