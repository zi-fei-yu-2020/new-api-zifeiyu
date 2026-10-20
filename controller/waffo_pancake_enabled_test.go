package controller

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestWaffoPancakeWalletVisibilityRequiresExplicitEnable(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	originalEnabled := setting.WaffoPancakeEnabled
	originalMerchantID := setting.WaffoPancakeMerchantID
	originalPrivateKey := setting.WaffoPancakePrivateKey
	originalProductID := setting.WaffoPancakeProductID
	originalMethods := operation_setting.PayMethods
	t.Cleanup(func() {
		setting.WaffoPancakeEnabled = originalEnabled
		setting.WaffoPancakeMerchantID = originalMerchantID
		setting.WaffoPancakePrivateKey = originalPrivateKey
		setting.WaffoPancakeProductID = originalProductID
		operation_setting.PayMethods = originalMethods
	})
	setting.WaffoPancakeMerchantID = "merchant"
	setting.WaffoPancakePrivateKey = "private"
	setting.WaffoPancakeProductID = "product"
	for _, enabled := range []bool{false, true, false} {
		setting.WaffoPancakeEnabled = enabled
		for _, listed := range []bool{false, true} {
			operation_setting.PayMethods = []map[string]string{{"type": "epay", "name": "Existing payment"}}
			if listed {
				operation_setting.PayMethods = append(operation_setting.PayMethods, map[string]string{"type": model.PaymentMethodWaffoPancake})
			}
			beforeCount := len(operation_setting.PayMethods)
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			GetTopUpInfo(ctx)
			var response struct {
				Data struct {
					Enabled bool                `json:"enable_waffo_pancake_topup"`
					Methods []map[string]string `json:"pay_methods"`
				} `json:"data"`
			}
			require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
			require.Equal(t, enabled, response.Data.Enabled)
			pancakeCount := 0
			for _, method := range response.Data.Methods {
				if method["type"] == model.PaymentMethodWaffoPancake {
					pancakeCount++
				}
			}
			if enabled {
				require.Equal(t, 1, pancakeCount)
			} else {
				require.Zero(t, pancakeCount)
			}
			require.Contains(t, response.Data.Methods, map[string]string{"type": "epay", "name": "Existing payment"})
			require.Len(t, operation_setting.PayMethods, beforeCount)
		}
	}
}

func TestWaffoPancakeDisabledRejectsDirectPaymentRequests(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	originalEnabled := setting.WaffoPancakeEnabled
	t.Cleanup(func() { setting.WaffoPancakeEnabled = originalEnabled })
	setting.WaffoPancakeEnabled = false
	for _, testCase := range []struct {
		name    string
		handler gin.HandlerFunc
	}{
		{"amount", RequestWaffoPancakeAmount},
		{"topup", RequestWaffoPancakePay},
		{"subscription", SubscriptionRequestWaffoPancakePay},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest("POST", "/", strings.NewReader(`{"amount":10,"plan_id":1}`))
			ctx.Request.Header.Set("Content-Type", "application/json")
			testCase.handler(ctx)
			require.Contains(t, recorder.Body.String(), "Waffo Pancake payments are disabled or not configured")
		})
	}
}
