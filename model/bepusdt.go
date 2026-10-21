package model

import (
	"errors"
	"fmt"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"gorm.io/gorm"
)

type BepusdtOrder struct {
	GatewayURL     string  `gorm:"type:varchar(2048)"`
	NotifyURL      string  `gorm:"type:varchar(2048)"`
	ReturnURL      string  `gorm:"type:varchar(2048)"`
	Currencies     string  `gorm:"type:varchar(32)"`
	TradeNo        string  `gorm:"type:varchar(64);primaryKey"`
	GatewayTradeID *string `gorm:"type:varchar(128);uniqueIndex:idx_bepusdt_gateway_trade"`
	Quota          int
	MoneyCents     int64
	Currency       string `gorm:"type:varchar(8)"`
	ExpiresAt      int64
}

var ErrBepusdtOrderMismatch = errors.New("BEpusdt order does not match the payment")

func CreateBepusdtOrder(topUp *TopUp, order *BepusdtOrder) error {
	if topUp == nil || order == nil || topUp.TradeNo == "" || topUp.TradeNo != order.TradeNo || topUp.PaymentProvider != PaymentProviderBepusdt || topUp.PaymentMethod != PaymentMethodBepusdt || topUp.Status != common.TopUpStatusPending || order.Currency != "USD" || order.MoneyCents <= 0 || order.MoneyCents > common.MaxWalletQuota {
		return ErrBepusdtOrderMismatch
	}
	if _, err := topUpQuotaMaxCurrent(order.Quota); err != nil {
		return err
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(topUp).Error; err != nil {
			return err
		}
		return tx.Create(order).Error
	})
}

func BindBepusdtOrder(tradeNo, gatewayID string) error {
	if gatewayID == "" || len(gatewayID) > 128 {
		return ErrBepusdtOrderMismatch
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var order BepusdtOrder
		if err := lockForUpdate(tx).First(&order, "trade_no = ?", tradeNo).Error; err != nil {
			return err
		}
		if order.GatewayTradeID != nil {
			if *order.GatewayTradeID != gatewayID {
				return ErrBepusdtOrderMismatch
			}
			return nil
		}
		return tx.Model(&order).Update("gateway_trade_id", gatewayID).Error
	})
}

func SettleBepusdtOrder(tradeNo, gatewayID string, cents int64, status int, callerIP string) error {
	if tradeNo == "" || gatewayID == "" || len(gatewayID) > 128 || cents <= 0 || status < 1 || status > 6 {
		return ErrBepusdtOrderMismatch
	}
	var topUp TopUp
	var credited int
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).First(&topUp, "trade_no = ?", tradeNo).Error; err != nil {
			return err
		}
		if topUp.PaymentProvider != PaymentProviderBepusdt || topUp.PaymentMethod != PaymentMethodBepusdt {
			return ErrPaymentMethodMismatch
		}
		var order BepusdtOrder
		if err := lockForUpdate(tx).First(&order, "trade_no = ?", tradeNo).Error; err != nil {
			return err
		}
		if order.Currency != "USD" || cents != order.MoneyCents || (order.GatewayTradeID != nil && *order.GatewayTradeID != gatewayID) {
			return ErrBepusdtOrderMismatch
		}
		if order.GatewayTradeID == nil {
			if err := tx.Model(&order).Update("gateway_trade_id", gatewayID).Error; err != nil {
				return err
			}
		}
		if topUp.Status == common.TopUpStatusSuccess {
			return nil
		}
		if status != 2 {
			// BEpusdt: 1 waiting, 3 expired, 4 canceled, 5 confirming, 6 failed.
			// Closed orders remain eligible for a later verified paid notification.
			if (status == 3 || status == 4 || status == 6) && topUp.Status == common.TopUpStatusPending {
				return tx.Model(&topUp).Update("status", common.TopUpStatusExpired).Error
			}
			return nil
		}
		if topUp.Status != common.TopUpStatusPending && topUp.Status != common.TopUpStatusExpired {
			return ErrTopUpStatusInvalid
		}
		if err := creditTopUpQuota(tx, topUp.UserId, order.Quota, nil); err != nil {
			return err
		}
		topUp.Status, topUp.CompleteTime = common.TopUpStatusSuccess, common.GetTimestamp()
		if err := tx.Save(&topUp).Error; err != nil {
			return err
		}
		credited = order.Quota
		return nil
	})
	if err != nil {
		return err
	}
	if credited > 0 {
		syncCreditUserQuotaCache(topUp.UserId, credited, "BEpusdt top-up")
		RecordTopupLog(topUp.UserId, common.NewMessage("{{provider}} top-up succeeded, amount added: {{quota}}, payment amount: {{amount}}", map[string]any{"provider": "BEpusdt", "quota": logger.FormatQuota(credited), "amount": fmt.Sprintf("USD %.2f", topUp.Money)}), callerIP, PaymentMethodBepusdt, PaymentProviderBepusdt)
	}
	return nil
}

func GetUserBepusdtOrder(userID int, tradeNo string) (*TopUp, error) {
	var order TopUp
	err := DB.Where("user_id = ? AND trade_no = ? AND payment_provider = ?", userID, tradeNo, PaymentProviderBepusdt).First(&order).Error
	return &order, err
}
