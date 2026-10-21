package controller

import (
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
)

func isBepusdtTopUpEnabled() bool {
	config := setting.GetBepusdtConfig()
	return isPaymentComplianceConfirmed() && config.Enabled && config.Ready()
}

func bepusdtQuote(userID int, amount int64, config setting.BepusdtConfig) (*model.TopUp, *model.BepusdtOrder, error) {
	unit := common.QuotaPerUnit
	if amount <= 0 || unit <= 0 || math.IsNaN(unit) || math.IsInf(unit, 0) {
		return nil, nil, model.ErrInvalidTopUpQuota
	}
	credits := decimal.NewFromInt(amount)
	if operation_setting.GetQuotaDisplayType() == operation_setting.QuotaDisplayTypeTokens {
		credits = credits.Div(decimal.NewFromFloat(unit))
		if !credits.IsInteger() {
			return nil, nil, common.NewMessage("BEpusdt top-up amount must be a multiple of {{step}}", map[string]any{"step": unit})
		}
	}
	if credits.LessThan(decimal.NewFromInt(config.MinTopUp)) {
		return nil, nil, common.NewMessage("Top-up amount cannot be less than {{min}}", map[string]any{"min": config.MinTopUp})
	}
	if credits.GreaterThan(decimal.NewFromInt(common.MaxWalletQuota)) {
		return nil, nil, model.ErrInvalidTopUpQuota
	}
	quota, err := common.WalletQuotaFromDecimalStrict(credits.Mul(decimal.NewFromFloat(unit)))
	if err != nil || quota <= 0 {
		return nil, nil, model.ErrInvalidTopUpQuota
	}
	if err := model.ValidateTopUpQuotaCapacity(userID, quota); err != nil {
		if errors.Is(err, model.ErrInvalidTopUpQuota) || errors.Is(err, model.ErrTopUpQuotaLimitExceeded) || errors.Is(err, model.ErrWalletQuotaLimitExceeded) {
			return nil, nil, err
		}
		return nil, nil, common.NewMessage("Failed to create order")
	}
	user, err := model.GetUserById(userID, false)
	if err != nil {
		return nil, nil, common.NewMessage("User does not exist")
	}
	ratio := common.GetTopupGroupRatio(user.Group)
	if ratio == 0 {
		ratio = 1
	}
	discount := 1.0
	if value, ok := operation_setting.GetPaymentSetting().AmountDiscount[int(amount)]; ok && value > 0 {
		discount = value
	}
	if ratio <= 0 || discount <= 0 || math.IsNaN(ratio) || math.IsInf(ratio, 0) || math.IsNaN(discount) || math.IsInf(discount, 0) {
		return nil, nil, model.ErrInvalidTopUpQuota
	}
	price, err := decimal.NewFromString(config.UnitPrice)
	if err != nil || !price.IsPositive() {
		return nil, nil, model.ErrInvalidTopUpQuota
	}
	money := credits.Mul(price).Mul(decimal.NewFromFloat(ratio)).Mul(decimal.NewFromFloat(discount)).Round(2)
	cents, err := service.BepusdtMoneyCents(money.String())
	if err != nil {
		return nil, nil, common.NewMessage("Payment amount is too low or too large")
	}
	if !decimal.NewFromFloat(money.InexactFloat64()).Equal(money) {
		return nil, nil, model.ErrInvalidTopUpQuota
	}
	topUp := &model.TopUp{UserId: userID, Amount: credits.IntPart(), Money: money.InexactFloat64(), PaymentMethod: model.PaymentMethodBepusdt, PaymentProvider: model.PaymentProviderBepusdt, Status: common.TopUpStatusPending, CreateTime: common.GetTimestamp()}
	order := &model.BepusdtOrder{Quota: quota, MoneyCents: cents, Currency: "USD", ExpiresAt: common.GetTimestamp() + 900}
	return topUp, order, nil
}

func RequestBepusdtAmount(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	if !isBepusdtTopUpEnabled() {
		paymentError(c, common.NewMessage("BEpusdt payments are disabled or not configured"))
		return
	}
	var body AmountRequest
	if c.ShouldBindJSON(&body) != nil {
		paymentError(c, common.NewMessage("Invalid parameters"))
		return
	}
	_, order, err := bepusdtQuote(c.GetInt("id"), body.Amount, setting.GetBepusdtConfig())
	if err != nil {
		paymentError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "success", "data": decimal.NewFromInt(order.MoneyCents).Div(decimal.NewFromInt(100)).StringFixed(2), "currency": "USD"})
}

func RequestBepusdtPay(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	config := setting.GetBepusdtConfig()
	if !isPaymentComplianceConfirmed() || !config.Enabled || !config.Ready() {
		paymentError(c, common.NewMessage("BEpusdt payments are disabled or not configured"))
		return
	}
	var body AmountRequest
	if c.ShouldBindJSON(&body) != nil {
		paymentError(c, common.NewMessage("Invalid parameters"))
		return
	}
	topUp, order, err := bepusdtQuote(c.GetInt("id"), body.Amount, config)
	if err != nil {
		paymentError(c, err)
		return
	}
	topUp.TradeNo = "BEP-" + common.GetUUID()
	order.TradeNo = topUp.TradeNo
	notifyURL := strings.TrimRight(service.GetCallbackAddress(), "/") + "/api/bepusdt/notify"
	returnURL := paymentReturnPath("/wallet") + "?bepusdt_order=" + url.QueryEscape(topUp.TradeNo)
	order.GatewayURL, order.NotifyURL, order.ReturnURL, order.Currencies = config.BaseURL, notifyURL, returnURL, config.Currencies
	for _, address := range []string{notifyURL, returnURL} {
		parsed, err := url.Parse(address)
		if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || (address == notifyURL && parsed.RawQuery != "") || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			paymentError(c, common.NewMessage("Configure the server address before accepting payments"))
			return
		}
	}
	if err := model.CreateBepusdtOrder(topUp, order); err != nil {
		paymentError(c, common.NewMessage("Failed to create order"))
		return
	}
	checkout, err := service.CreateBepusdtCheckout(c.Request.Context(), config, order.TradeNo, order.MoneyCents, notifyURL, returnURL)
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText("BEpusdt checkout failed: order=%s error=%s", order.TradeNo, err.Error()))
		paymentError(c, common.NewMessage("Unable to start BEpusdt payment. Please try again later"))
		return
	}
	if err := model.BindBepusdtOrder(order.TradeNo, checkout.TradeID); err != nil {
		paymentError(c, common.NewMessage("Unable to start BEpusdt payment. Please try again later"))
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "success", "data": gin.H{"pay_link": checkout.PaymentURL, "order_id": order.TradeNo, "currency": "USD"}})
}

func BepusdtNotify(c *gin.Context) {
	config := setting.GetBepusdtConfig()
	if config.APIKey == "" {
		c.String(http.StatusServiceUnavailable, "fail")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 65536)
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.String(http.StatusBadRequest, "fail")
		return
	}
	event, err := service.VerifyBepusdtNotification(raw, config.APIKey)
	if err != nil {
		logger.LogWarn(c.Request.Context(), common.LogText("BEpusdt callback rejected: invalid signature or payload"))
		c.String(http.StatusForbidden, "fail")
		return
	}
	if event.Status == 2 {
		var topUp model.TopUp
		if err := model.DB.Where("trade_no = ? AND payment_provider = ?", event.OrderID, model.PaymentProviderBepusdt).First(&topUp).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				c.String(http.StatusBadRequest, "fail")
			} else {
				c.String(http.StatusInternalServerError, "fail")
			}
			return
		}
		if topUp.Status != common.TopUpStatusSuccess {
			var snapshot model.BepusdtOrder
			if err := model.DB.First(&snapshot, "trade_no = ?", event.OrderID).Error; err != nil {
				c.String(http.StatusInternalServerError, "fail")
				return
			}
			if snapshot.MoneyCents != event.MoneyCents || snapshot.Currency != "USD" || (snapshot.GatewayTradeID != nil && *snapshot.GatewayTradeID != event.TradeID) {
				c.String(http.StatusBadRequest, "fail")
				return
			}
			verificationConfig := setting.BepusdtConfig{BaseURL: snapshot.GatewayURL, APIKey: config.APIKey, UnitPrice: "1", MinTopUp: 1, Currencies: snapshot.Currencies}
			verifyContext, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
			verified, verifyErr := service.CreateBepusdtCheckout(verifyContext, verificationConfig, event.OrderID, snapshot.MoneyCents, snapshot.NotifyURL, snapshot.ReturnURL)
			cancel()
			if verifyErr != nil || verified.Status != 2 || verified.TradeID != event.TradeID {
				logger.LogWarn(c.Request.Context(), common.LogText("BEpusdt payment verification failed: order=%s", event.OrderID))
				c.String(http.StatusServiceUnavailable, "fail")
				return
			}
		}
	}
	err = model.SettleBepusdtOrder(event.OrderID, event.TradeID, event.MoneyCents, event.Status, c.ClientIP())
	if err != nil {
		logger.LogWarn(c.Request.Context(), common.LogText("BEpusdt settlement failed: order=%s error=%s", event.OrderID, err.Error()))
		if errors.Is(err, model.ErrBepusdtOrderMismatch) || errors.Is(err, model.ErrPaymentMethodMismatch) || errors.Is(err, model.ErrTopUpStatusInvalid) || errors.Is(err, gorm.ErrRecordNotFound) {
			c.String(http.StatusBadRequest, "fail")
			return
		}
		c.String(http.StatusInternalServerError, "fail")
		return
	}
	logger.LogInfo(c.Request.Context(), common.LogText("BEpusdt callback accepted: order=%s status=%d", event.OrderID, event.Status))
	c.String(http.StatusOK, "ok")
}

func GetBepusdtPaymentStatus(c *gin.Context) {
	order, err := model.GetUserBepusdtOrder(c.GetInt("id"), c.Param("trade_no"))
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "Order not found"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "Unable to load BEpusdt payment status."})
		}
		return
	}
	status := order.Status
	if status == common.TopUpStatusPending {
		var snapshot model.BepusdtOrder
		if err := model.DB.First(&snapshot, "trade_no = ?", order.TradeNo).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "Unable to load BEpusdt payment status."})
			return
		}
		if snapshot.ExpiresAt <= common.GetTimestamp() {
			status = common.TopUpStatusExpired
		}
	}
	common.ApiSuccess(c, gin.H{"status": status, "order_id": order.TradeNo})
}
