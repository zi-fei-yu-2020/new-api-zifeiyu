package setting

import (
	"errors"
	"math"
	"net/url"
	"strconv"
	"strings"
	"sync"

	"github.com/shopspring/decimal"
)

type BepusdtConfig struct {
	Enabled    bool
	BaseURL    string
	APIKey     string
	UnitPrice  string
	MinTopUp   int64
	Currencies string
}

var bepusdtMu sync.RWMutex
var bepusdtConfig = BepusdtConfig{UnitPrice: "1", MinTopUp: 1, Currencies: "USDT,USDC"}

func GetBepusdtConfig() BepusdtConfig {
	bepusdtMu.RLock()
	defer bepusdtMu.RUnlock()
	return bepusdtConfig
}

func (config BepusdtConfig) Ready() bool {
	parsed, err := url.Parse(config.BaseURL)
	price, priceErr := decimal.NewFromString(config.UnitPrice)
	return err == nil && parsed.Host != "" && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == "" && strings.TrimSpace(config.APIKey) != "" && priceErr == nil && price.IsPositive() && config.MinTopUp > 0 && (config.Currencies == "USDT" || config.Currencies == "USDC" || config.Currencies == "USDT,USDC")
}

func BepusdtOptionValues() map[string]string {
	config := GetBepusdtConfig()
	return map[string]string{
		"BepusdtEnabled":    strconv.FormatBool(config.Enabled),
		"BepusdtBaseURL":    config.BaseURL,
		"BepusdtApiKey":     config.APIKey,
		"BepusdtUnitPrice":  config.UnitPrice,
		"BepusdtMinTopUp":   strconv.FormatInt(config.MinTopUp, 10),
		"BepusdtCurrencies": config.Currencies,
	}
}

func applyBepusdtOption(config *BepusdtConfig, key, value string) error {
	invalid := errors.New("Invalid BEpusdt configuration")
	value = strings.TrimSpace(value)
	switch key {
	case "BepusdtEnabled":
		if value != "true" && value != "false" {
			return invalid
		}
		config.Enabled = value == "true"
	case "BepusdtBaseURL":
		if value != "" {
			parsed, err := url.Parse(value)
			if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
				return invalid
			}
		}
		config.BaseURL = strings.TrimRight(value, "/")
	case "BepusdtApiKey":
		config.APIKey = value
	case "BepusdtUnitPrice":
		numeric, parseErr := strconv.ParseFloat(value, 64)
		if parseErr != nil || math.IsNaN(numeric) || math.IsInf(numeric, 0) || numeric <= 0 {
			return invalid
		}
		price, err := decimal.NewFromString(value)
		if err != nil || !price.IsPositive() {
			return invalid
		}
		config.UnitPrice = price.String()
	case "BepusdtMinTopUp":
		amount, err := strconv.ParseInt(value, 10, 64)
		if err != nil || amount < 1 || amount > 1<<53-1 {
			return invalid
		}
		config.MinTopUp = amount
	case "BepusdtCurrencies":
		if value != "USDT" && value != "USDC" && value != "USDT,USDC" {
			return invalid
		}
		config.Currencies = value
	default:
		return invalid
	}
	return nil
}

func ValidateBepusdtOption(key, value string) error {
	config := GetBepusdtConfig()
	if err := applyBepusdtOption(&config, key, value); err != nil {
		return err
	}
	if config.Enabled && !config.Ready() {
		return errors.New("Configure the BEpusdt gateway URL and API token before enabling payments")
	}
	return nil
}

func SetBepusdtOption(key, value string) error {
	bepusdtMu.Lock()
	defer bepusdtMu.Unlock()
	return applyBepusdtOption(&bepusdtConfig, key, value)
}
