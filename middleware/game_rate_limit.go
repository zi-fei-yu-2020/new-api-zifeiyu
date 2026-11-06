package middleware

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
)

// UserRateLimit limits an authenticated user to maxRequestNum requests per
// duration seconds under its own scope. Unlike UserCriticalRateLimit it is
// always on, so latency-sensitive but abusable endpoints (game input sync)
// get a user-keyed ceiling that does not depend on the critical limiter or on
// the client IP. Must be used AFTER authentication middleware.
func UserRateLimit(scope string, maxRequestNum int, duration int64) func(c *gin.Context) {
	return userRateLimitFactory(maxRequestNum, duration, "UR:"+scope)
}

// GlobalAPIRateLimitWithRelaxedRoute behaves like GlobalAPIRateLimit, except
// that one route (method + registered path) is counted in its own per-IP bucket
// with a budget relaxedFactor times larger. Latency-sensitive duel input sync would otherwise
// share the 2 req/s default IP budget with every other dashboard call.
func GlobalAPIRateLimitWithRelaxedRoute(method, fullPath string, relaxedFactor int) func(c *gin.Context) {
	if !common.GlobalApiRateLimitEnable {
		return defNext
	}
	global := rateLimitFactory(common.GlobalApiRateLimitNum, common.GlobalApiRateLimitDuration, "GA")
	relaxed := rateLimitFactory(common.GlobalApiRateLimitNum*relaxedFactor, common.GlobalApiRateLimitDuration, "GAR")
	return func(c *gin.Context) {
		if c.Request.Method == method && c.FullPath() == fullPath {
			relaxed(c)
			return
		}
		global(c)
	}
}
