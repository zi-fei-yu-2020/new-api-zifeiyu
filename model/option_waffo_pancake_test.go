package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting"
	"github.com/stretchr/testify/require"
)

func TestWaffoPancakeOptionReloadControlsPaymentsWithoutClearingCredentials(t *testing.T) {
	originalMap := common.OptionMap
	originalEnabled := setting.WaffoPancakeEnabled
	originalMerchantID := setting.WaffoPancakeMerchantID
	originalPrivateKey := setting.WaffoPancakePrivateKey
	originalProductID := setting.WaffoPancakeProductID
	common.OptionMap = map[string]string{}
	t.Cleanup(func() {
		common.OptionMap = originalMap
		setting.WaffoPancakeEnabled = originalEnabled
		setting.WaffoPancakeMerchantID = originalMerchantID
		setting.WaffoPancakePrivateKey = originalPrivateKey
		setting.WaffoPancakeProductID = originalProductID
	})
	setting.WaffoPancakeEnabled = false
	require.NoError(t, updateOptionMap("WaffoPancakeMerchantID", "test-merchant"))
	require.NoError(t, updateOptionMap("WaffoPancakePrivateKey", "test-private-key"))
	require.NoError(t, updateOptionMap("WaffoPancakeProductID", "test-product"))
	require.False(t, setting.WaffoPancakeEnabled)
	require.NoError(t, updateOptionMap("WaffoPancakeEnabled", "true"))
	require.True(t, setting.WaffoPancakeEnabled)
	require.NoError(t, updateOptionMap("WaffoPancakeEnabled", "false"))
	require.False(t, setting.WaffoPancakeEnabled)
	require.Equal(t, "false", common.OptionMap["WaffoPancakeEnabled"])
	require.Equal(t, "test-merchant", setting.WaffoPancakeMerchantID)
	require.Equal(t, "test-private-key", setting.WaffoPancakePrivateKey)
	require.Equal(t, "test-product", setting.WaffoPancakeProductID)
}
