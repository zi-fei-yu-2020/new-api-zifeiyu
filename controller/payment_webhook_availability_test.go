package controller

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

type bepusdtTestGateway struct {
	db       *gorm.DB
	paid     atomic.Bool
	requests atomic.Int64
	server   *httptest.Server
}

func setupBepusdtTest(t *testing.T) *bepusdtTestGateway {
	t.Helper()
	db := setupManageUserTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.TopUp{}, &model.BepusdtOrder{}, &model.Option{}))
	confirmPaymentComplianceForTest(t)
	original := setting.BepusdtOptionValues()
	originalServer, originalCallback, originalUnit := system_setting.ServerAddress, operation_setting.CustomCallbackAddress, common.QuotaPerUnit
	originalDisplay := operation_setting.GetGeneralSetting().QuotaDisplayType
	originalDiscount := operation_setting.GetPaymentSetting().AmountDiscount
	originalRatio := common.TopupGroupRatio2JSONString()
	t.Cleanup(func() {
		for key, value := range original {
			require.NoError(t, setting.SetBepusdtOption(key, value))
		}
		system_setting.ServerAddress = originalServer
		operation_setting.CustomCallbackAddress = originalCallback
		common.QuotaPerUnit = originalUnit
		operation_setting.GetGeneralSetting().QuotaDisplayType = originalDisplay
		operation_setting.GetPaymentSetting().AmountDiscount = originalDiscount
		require.NoError(t, common.UpdateTopupGroupRatioByJSONString(originalRatio))
	})
	system_setting.ServerAddress = "https://console.example"
	operation_setting.CustomCallbackAddress = ""
	common.QuotaPerUnit = 500000
	operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeUSD
	operation_setting.GetPaymentSetting().AmountDiscount = map[int]float64{}
	require.NoError(t, common.UpdateTopupGroupRatioByJSONString(`{"default":1}`))
	require.NoError(t, db.Create(&model.User{Id: 1, Username: "bepusdt-buyer", Quota: 100, Group: "default", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AuthVersion: 1}).Error)
	fixture := &bepusdtTestGateway{db: db}
	var mutex sync.Mutex
	orders := map[string]service.BepusdtCheckout{}
	fixture.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		fixture.requests.Add(1)
		var payload map[string]any
		require.NoError(t, common.DecodeJson(request.Body, &payload))
		expected, err := service.SignBepusdt(payload, "test-secret")
		require.NoError(t, err)
		require.Equal(t, expected, payload["signature"])
		require.Equal(t, "USD", payload["fiat"])
		id := payload["order_id"].(string)
		mutex.Lock()
		order, found := orders[id]
		if !found {
			order = service.BepusdtCheckout{OrderID: id, TradeID: "gateway-" + id, Amount: fmt.Sprint(payload["amount"]), Fiat: "USD", Status: 1, PaymentURL: fixture.server.URL + "/pay/checkout/gateway-" + id}
			orders[id] = order
		}
		if found && fixture.paid.Load() {
			order.Status = 2
		}
		mutex.Unlock()
		data, err := common.Marshal(map[string]any{"status_code": 200, "data": order})
		require.NoError(t, err)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write(data)
	}))
	t.Cleanup(fixture.server.Close)
	for key, value := range map[string]string{"BepusdtEnabled": "false", "BepusdtBaseURL": fixture.server.URL, "BepusdtApiKey": "test-secret", "BepusdtUnitPrice": "1", "BepusdtMinTopUp": "1", "BepusdtCurrencies": "USDT,USDC"} {
		require.NoError(t, setting.SetBepusdtOption(key, value))
	}
	return fixture
}

func bepusdtRequest(handler gin.HandlerFunc, userID int, body []byte) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	ctx.Set("id", userID)
	handler(ctx)
	return recorder
}

func createBepusdtCheckoutForTest(t *testing.T, fixture *bepusdtTestGateway) string {
	t.Helper()
	require.NoError(t, setting.SetBepusdtOption("BepusdtEnabled", "true"))
	response := bepusdtRequest(RequestBepusdtPay, 1, []byte(`{"amount":2}`))
	var result struct {
		Message string `json:"message"`
		Data    struct {
			OrderID string `json:"order_id"`
			Link    string `json:"pay_link"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
	require.Equal(t, "success", result.Message, response.Body.String())
	require.True(t, strings.HasPrefix(result.Data.Link, fixture.server.URL+"/pay/"))
	require.NotEmpty(t, result.Data.OrderID)
	return result.Data.OrderID
}

func bepusdtCallback(t *testing.T, orderID, key string, amount float64, status int) *httptest.ResponseRecorder {
	t.Helper()
	payload := map[string]any{"order_id": orderID, "trade_id": "gateway-" + orderID, "amount": amount, "status": status, "actual_amount": "2.00", "token": "wallet-address", "block_transaction_id": "tx-123"}
	signature, err := service.SignBepusdt(payload, key)
	require.NoError(t, err)
	payload["signature"] = signature
	body, err := common.Marshal(payload)
	require.NoError(t, err)
	return bepusdtRequest(BepusdtNotify, 0, body)
}

func TestBepusdtDisabledDoesNotExposeOrCreatePayments(t *testing.T) {
	fixture := setupBepusdtTest(t)
	response := bepusdtRequest(RequestBepusdtPay, 1, []byte(`{"amount":2}`))
	require.Contains(t, response.Body.String(), "BEpusdt payments are disabled")
	var count int64
	require.NoError(t, fixture.db.Model(&model.TopUp{}).Count(&count).Error)
	require.Zero(t, count)
	originalMethods := operation_setting.PayMethods
	operation_setting.PayMethods = []map[string]string{{"name": "draft", "type": "bepusdt"}}
	t.Cleanup(func() { operation_setting.PayMethods = originalMethods })
	response = bepusdtRequest(GetTopUpInfo, 1, nil)
	var result struct {
		Data struct {
			Enabled bool                `json:"enable_bepusdt_topup"`
			Methods []map[string]string `json:"pay_methods"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
	require.False(t, result.Data.Enabled)
	for _, method := range result.Data.Methods {
		require.NotEqual(t, "bepusdt", method["type"])
	}
	require.Zero(t, fixture.requests.Load())
}

func TestBepusdtPaidCallbackVerifiesGatewayAndUsesFrozenQuota(t *testing.T) {
	fixture := setupBepusdtTest(t)
	orderID := createBepusdtCheckoutForTest(t, fixture)
	require.Equal(t, http.StatusForbidden, bepusdtCallback(t, orderID, "wrong-key", 2, 2).Code)
	require.Equal(t, http.StatusBadRequest, bepusdtCallback(t, orderID, "test-secret", 1, 2).Code)
	require.Equal(t, http.StatusServiceUnavailable, bepusdtCallback(t, orderID, "test-secret", 2, 2).Code, "a signed callback cannot credit an order that the gateway still reports unpaid")
	fixture.paid.Store(true)
	require.NoError(t, setting.SetBepusdtOption("BepusdtEnabled", "false"))
	require.NoError(t, setting.SetBepusdtOption("BepusdtUnitPrice", "10"))
	require.NoError(t, setting.SetBepusdtOption("BepusdtBaseURL", ""))
	common.QuotaPerUnit = 99
	response := bepusdtCallback(t, orderID, "test-secret", 2, 2)
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, "ok", response.Body.String())
	var user model.User
	require.NoError(t, fixture.db.First(&user, 1).Error)
	require.Equal(t, 1000100, user.Quota)
	requests := fixture.requests.Load()
	require.Equal(t, http.StatusOK, bepusdtCallback(t, orderID, "test-secret", 2, 2).Code)
	require.Equal(t, requests, fixture.requests.Load(), "duplicate callbacks do not require another gateway request")
	require.NoError(t, fixture.db.First(&user, 1).Error)
	require.Equal(t, 1000100, user.Quota)
}

func TestBepusdtSettlementFailureReturnsRetryableStatus(t *testing.T) {
	fixture := setupBepusdtTest(t)
	orderID := createBepusdtCheckoutForTest(t, fixture)
	fixture.paid.Store(true)
	require.NoError(t, fixture.db.Model(&model.User{}).Where("id = ?", 1).Update("quota", common.MaxWalletQuota).Error)
	require.Equal(t, http.StatusInternalServerError, bepusdtCallback(t, orderID, "test-secret", 2, 2).Code)
	require.Equal(t, common.TopUpStatusPending, model.GetTopUpByTradeNo(orderID).Status)
	require.NoError(t, fixture.db.Model(&model.User{}).Where("id = ?", 1).Update("quota", 0).Error)
	require.Equal(t, http.StatusOK, bepusdtCallback(t, orderID, "test-secret", 2, 2).Code)
}

func TestBepusdtReturnDoesNotCreditAndOtherUsersCannotReadOrder(t *testing.T) {
	fixture := setupBepusdtTest(t)
	orderID := createBepusdtCheckoutForTest(t, fixture)
	for _, userID := range []int{1, 2} {
		recorder := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(recorder)
		ctx.Set("id", userID)
		ctx.Params = gin.Params{{Key: "trade_no", Value: orderID}}
		GetBepusdtPaymentStatus(ctx)
		if userID == 1 {
			require.Equal(t, http.StatusOK, recorder.Code)
			require.Contains(t, recorder.Body.String(), "pending")
		} else {
			require.Equal(t, http.StatusNotFound, recorder.Code)
		}
	}
	var user model.User
	require.NoError(t, fixture.db.First(&user, 1).Error)
	require.Equal(t, 100, user.Quota)
}

func TestBepusdtTokenDisplayRejectsTruncationAndQuotesWholeCredits(t *testing.T) {
	fixture := setupBepusdtTest(t)
	require.NoError(t, setting.SetBepusdtOption("BepusdtEnabled", "true"))
	operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeTokens
	response := bepusdtRequest(RequestBepusdtAmount, 1, []byte(`{"amount":750000}`))
	require.Contains(t, response.Body.String(), "multiple")
	response = bepusdtRequest(RequestBepusdtAmount, 1, []byte(`{"amount":1000000}`))
	require.Contains(t, response.Body.String(), `"data":"2.00"`)
	response = bepusdtRequest(GetTopUpInfo, 1, nil)
	require.Contains(t, response.Body.String(), `"bepusdt_min_topup":500000`)
	require.Zero(t, fixture.requests.Load())
}

func TestBepusdtConfigurationNeverReturnsTheAPIToken(t *testing.T) {
	setupBepusdtTest(t)
	original := common.OptionMap
	common.OptionMap = map[string]string{"BepusdtApiKey": "test-secret", "BepusdtBaseURL": "https://pay.example"}
	t.Cleanup(func() { common.OptionMap = original })
	response := bepusdtRequest(GetOptions, 1, nil)
	require.NotContains(t, response.Body.String(), "test-secret")
	require.Contains(t, response.Body.String(), "BepusdtBaseURL")
}

func TestBepusdtNonPaymentNotificationsNeverCredit(t *testing.T) {
	fixture := setupBepusdtTest(t)
	for _, status := range []int{1, 3, 4, 5, 6} {
		orderID := createBepusdtCheckoutForTest(t, fixture)
		require.Equal(t, http.StatusOK, bepusdtCallback(t, orderID, "test-secret", 2, status).Code)
		var user model.User
		require.NoError(t, fixture.db.First(&user, 1).Error)
		require.Equal(t, 100, user.Quota)
		expected := common.TopUpStatusPending
		if status == 3 || status == 4 || status == 6 {
			expected = common.TopUpStatusExpired
		}
		require.Equal(t, expected, model.GetTopUpByTradeNo(orderID).Status)
	}
}

func confirmPaymentComplianceForTest(t *testing.T) {
	t.Helper()
	paymentSetting := operation_setting.GetPaymentSetting()
	originalConfirmed := paymentSetting.ComplianceConfirmed
	originalTermsVersion := paymentSetting.ComplianceTermsVersion
	t.Cleanup(func() {
		paymentSetting.ComplianceConfirmed = originalConfirmed
		paymentSetting.ComplianceTermsVersion = originalTermsVersion
	})
	paymentSetting.ComplianceConfirmed = true
	paymentSetting.ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
}

func TestStripeWebhookEnabledRequiresTopUpAndWebhookConfig(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	originalAPISecret := setting.StripeApiSecret
	originalWebhookSecret := setting.StripeWebhookSecret
	originalPriceID := setting.StripePriceId
	t.Cleanup(func() {
		setting.StripeApiSecret = originalAPISecret
		setting.StripeWebhookSecret = originalWebhookSecret
		setting.StripePriceId = originalPriceID
	})

	setting.StripeWebhookSecret = ""
	setting.StripeApiSecret = "sk_test_123"
	setting.StripePriceId = "price_123"
	require.False(t, isStripeWebhookEnabled())

	setting.StripeWebhookSecret = "whsec_test"
	require.True(t, isStripeWebhookEnabled())

	setting.StripePriceId = ""
	require.False(t, isStripeWebhookEnabled())
}

func TestCreemWebhookEnabledRequiresTopUpAndWebhookConfig(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	originalAPIKey := setting.CreemApiKey
	originalProducts := setting.CreemProducts
	originalWebhookSecret := setting.CreemWebhookSecret
	t.Cleanup(func() {
		setting.CreemApiKey = originalAPIKey
		setting.CreemProducts = originalProducts
		setting.CreemWebhookSecret = originalWebhookSecret
	})

	setting.CreemWebhookSecret = ""
	setting.CreemApiKey = "creem_api_key"
	setting.CreemProducts = `[{"productId":"prod_123"}]`
	require.False(t, isCreemWebhookEnabled())

	setting.CreemWebhookSecret = "creem_secret"
	require.True(t, isCreemWebhookEnabled())

	setting.CreemProducts = "[]"
	require.False(t, isCreemWebhookEnabled())
}

func TestWaffoWebhookEnabledRequiresTopUpAndWebhookConfig(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	originalEnabled := setting.WaffoEnabled
	originalSandbox := setting.WaffoSandbox
	originalAPIKey := setting.WaffoApiKey
	originalPrivateKey := setting.WaffoPrivateKey
	originalPublicCert := setting.WaffoPublicCert
	originalSandboxAPIKey := setting.WaffoSandboxApiKey
	originalSandboxPrivateKey := setting.WaffoSandboxPrivateKey
	originalSandboxPublicCert := setting.WaffoSandboxPublicCert
	t.Cleanup(func() {
		setting.WaffoEnabled = originalEnabled
		setting.WaffoSandbox = originalSandbox
		setting.WaffoApiKey = originalAPIKey
		setting.WaffoPrivateKey = originalPrivateKey
		setting.WaffoPublicCert = originalPublicCert
		setting.WaffoSandboxApiKey = originalSandboxAPIKey
		setting.WaffoSandboxPrivateKey = originalSandboxPrivateKey
		setting.WaffoSandboxPublicCert = originalSandboxPublicCert
	})

	setting.WaffoEnabled = true
	setting.WaffoSandbox = false
	setting.WaffoApiKey = ""
	setting.WaffoPrivateKey = "private"
	setting.WaffoPublicCert = "public"
	require.False(t, isWaffoWebhookEnabled())

	setting.WaffoApiKey = "api"
	require.True(t, isWaffoWebhookEnabled())

	setting.WaffoEnabled = false
	require.False(t, isWaffoWebhookEnabled())

	setting.WaffoEnabled = true
	setting.WaffoSandbox = true
	setting.WaffoSandboxApiKey = ""
	setting.WaffoSandboxPrivateKey = "sandbox_private"
	setting.WaffoSandboxPublicCert = "sandbox_public"
	require.False(t, isWaffoWebhookEnabled())

	setting.WaffoSandboxApiKey = "sandbox_api"
	require.True(t, isWaffoWebhookEnabled())
}

func TestWaffoPancakeWebhookRemainsAvailableWhenPaymentsDisabled(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	originalEnabled := setting.WaffoPancakeEnabled
	originalMerchantID := setting.WaffoPancakeMerchantID
	originalPrivateKey := setting.WaffoPancakePrivateKey
	originalProductID := setting.WaffoPancakeProductID
	t.Cleanup(func() {
		setting.WaffoPancakeEnabled = originalEnabled
		setting.WaffoPancakeMerchantID = originalMerchantID
		setting.WaffoPancakePrivateKey = originalPrivateKey
		setting.WaffoPancakeProductID = originalProductID
	})

	setting.WaffoPancakeEnabled = false
	setting.WaffoPancakeMerchantID = ""
	setting.WaffoPancakePrivateKey = "private"
	setting.WaffoPancakeProductID = "product"
	require.False(t, isWaffoPancakeWebhookEnabled())

	setting.WaffoPancakeMerchantID = "merchant"
	require.True(t, isWaffoPancakeWebhookEnabled())
	require.False(t, isWaffoPancakeTopUpEnabled())
	setting.WaffoPancakeEnabled = true
	require.True(t, isWaffoPancakeTopUpEnabled())

	setting.WaffoPancakeProductID = ""
	require.True(t, isWaffoPancakeWebhookEnabled())
	require.False(t, isWaffoPancakeTopUpEnabled())

	setting.WaffoPancakeProductID = "product"
	setting.WaffoPancakePrivateKey = ""
	require.False(t, isWaffoPancakeWebhookEnabled())
}

func TestEpayWebhookEnabledRequiresTopUpAndWebhookConfig(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	originalPayAddress := operation_setting.PayAddress
	originalEpayID := operation_setting.EpayId
	originalEpayKey := operation_setting.EpayKey
	originalPayMethods := operation_setting.PayMethods
	t.Cleanup(func() {
		operation_setting.PayAddress = originalPayAddress
		operation_setting.EpayId = originalEpayID
		operation_setting.EpayKey = originalEpayKey
		operation_setting.PayMethods = originalPayMethods
	})

	operation_setting.PayAddress = "https://pay.example.com"
	operation_setting.EpayId = "epay_id"
	operation_setting.EpayKey = ""
	operation_setting.PayMethods = []map[string]string{{"type": "alipay"}}
	require.False(t, isEpayWebhookEnabled())

	operation_setting.EpayKey = "epay_key"
	require.True(t, isEpayWebhookEnabled())

	operation_setting.PayMethods = nil
	require.False(t, isEpayWebhookEnabled())
}

func TestEpayCallbacksVerifyBeforeSettlement(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	originalPayAddress := operation_setting.PayAddress
	originalEpayID := operation_setting.EpayId
	originalEpayKey := operation_setting.EpayKey
	originalPayMethods := operation_setting.PayMethods
	originalServerAddress := system_setting.ServerAddress
	originalDB := model.DB
	t.Cleanup(func() {
		operation_setting.PayAddress = originalPayAddress
		operation_setting.EpayId = originalEpayID
		operation_setting.EpayKey = originalEpayKey
		operation_setting.PayMethods = originalPayMethods
		system_setting.ServerAddress = originalServerAddress
		model.DB = originalDB
	})
	operation_setting.PayAddress = "https://pay.example.com"
	operation_setting.EpayId = "epay_id"
	operation_setting.EpayKey = "test-key"
	operation_setting.PayMethods = []map[string]string{{"type": "alipay"}}
	system_setting.ServerAddress = "https://dashboard.example.com"
	// Rejected callbacks and valid non-success events must never reach settlement.
	// A nil database makes an accidental attempt to settle fail the test.
	model.DB = nil
	require.True(t, isEpayWebhookEnabled())

	// Both ambiguous maps below had this same valid signing string in v0.0.4.
	// This must fail because of parameter ambiguity, not a mismatched signature.
	ambiguousSign := epay.MD5String("money=1.00&name=item&out_trade_no=other&out_trade_no=order&pid=epay_id&trade_status=TRADE_SUCCESS&type=alipay", "test-key")
	pendingSign := epay.MD5String("money=1.00&name=item%26other&out_trade_no=order&pid=epay_id&trade_status=WAIT_BUYER_PAY&type=alipay", "test-key")
	cases := []struct {
		name         string
		productName  string
		tradeNo      string
		status       string
		sign         string
		validPending bool
	}{
		{"separator in product name", "item&out_trade_no=other", "order", epay.StatusTradeSuccess, ambiguousSign, false},
		{"separator in order number", "item", "other&out_trade_no=order", epay.StatusTradeSuccess, ambiguousSign, false},
		{"invalid signature", "item", "order", epay.StatusTradeSuccess, "invalid", false},
		{"missing signature", "item", "order", epay.StatusTradeSuccess, "", false},
		{"valid pending with literal percent escape", "item%26other", "order", "WAIT_BUYER_PAY", pendingSign, true},
	}
	endpoints := []struct {
		name             string
		path             string
		handler          gin.HandlerFunc
		status           int
		rejectedBody     string
		pendingBody      string
		rejectedLocation string
		pendingLocation  string
	}{
		{
			name: "topup notify", path: "/api/user/epay/notify", handler: EpayNotify,
			status: http.StatusOK, rejectedBody: "fail", pendingBody: "success",
		},
		{
			name: "subscription notify", path: "/api/subscription/epay/notify", handler: SubscriptionEpayNotify,
			status: http.StatusOK, rejectedBody: "fail", pendingBody: "fail",
		},
		{
			name: "subscription return", path: "/api/subscription/epay/return", handler: SubscriptionEpayReturn,
			status:           http.StatusFound,
			rejectedLocation: "https://dashboard.example.com/wallet?pay=fail",
			pendingLocation:  "https://dashboard.example.com/wallet?pay=pending",
		},
	}
	router := gin.New()
	for _, endpoint := range endpoints {
		router.Any(endpoint.path, endpoint.handler)
	}
	for _, endpoint := range endpoints {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			for _, tc := range cases {
				t.Run(endpoint.name+"/"+method+"/"+tc.name, func(t *testing.T) {
					params := url.Values{
						"pid": {"epay_id"}, "type": {"alipay"}, "money": {"1.00"},
						"name": {tc.productName}, "out_trade_no": {tc.tradeNo},
						"trade_status": {tc.status}, "sign_type": {"MD5"},
					}
					if tc.sign != "" {
						params.Set("sign", tc.sign)
					}
					request := httptest.NewRequest(method, endpoint.path+"?"+params.Encode(), nil)
					if method == http.MethodPost {
						request = httptest.NewRequest(method, endpoint.path, strings.NewReader(params.Encode()))
						request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
					}
					recorder := httptest.NewRecorder()
					require.NotPanics(t, func() { router.ServeHTTP(recorder, request) })
					assert.Equal(t, endpoint.status, recorder.Code)
					wantBody, wantLocation := endpoint.rejectedBody, endpoint.rejectedLocation
					if tc.validPending {
						wantBody, wantLocation = endpoint.pendingBody, endpoint.pendingLocation
					}
					if wantBody != "" {
						assert.Equal(t, wantBody, recorder.Body.String())
					}
					assert.Equal(t, wantLocation, recorder.Header().Get("Location"))
				})
			}
		}
	}
}
