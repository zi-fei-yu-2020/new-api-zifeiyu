package model

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func TestBepusdtDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			dsn := "local"
			if dialect != "sqlite" {
				dsn = os.Getenv("TEST_BEPUSDT_" + strings.ToUpper(dialect) + "_DSN")
				if dsn == "" {
					t.Skip("isolated BEpusdt database not configured")
				}
				require.Contains(t, dsn, "newapi_bepusdt_test")
			}
			oldPath := common.SQLitePath
			common.SQLitePath = filepath.Join(t.TempDir(), "bepusdt.db")
			t.Cleanup(func() { common.SQLitePath = oldPath })
			t.Setenv("BEPUSDT_TEST_DSN", dsn)
			db, kind, err := chooseDB("BEPUSDT_TEST_DSN", false)
			require.NoError(t, err)
			previousDB, previousLog, previousRedis, previousUnit := DB, LOG_DB, common.RedisEnabled, common.QuotaPerUnit
			previousKind, previousLogKind := common.MainDatabaseType(), common.LogDatabaseType()
			DB, LOG_DB = db, db
			common.RedisEnabled = false
			common.SetDatabaseTypes(kind, kind)
			t.Cleanup(func() {
				DB, LOG_DB = previousDB, previousLog
				common.RedisEnabled = previousRedis
				common.QuotaPerUnit = previousUnit
				common.SetDatabaseTypes(previousKind, previousLogKind)
				sqlDB, _ := db.DB()
				_ = sqlDB.Close()
			})
			versionQuery := "select version()"
			if dialect == "sqlite" {
				versionQuery = "select sqlite_version()"
			}
			var version string
			require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
			t.Log(dialect, version)
			for _, scenario := range []string{"fresh", "upgrade"} {
				t.Run(scenario, func(t *testing.T) {
					tables := []any{&BepusdtOrder{}, &TopUp{}, &User{}, &Log{}}
					require.NoError(t, db.Migrator().DropTable(tables...))
					t.Cleanup(func() { require.NoError(t, db.Migrator().DropTable(tables...)) })
					if scenario == "upgrade" {
						require.NoError(t, db.AutoMigrate(&TopUp{}))
						require.NoError(t, db.Create(&TopUp{TradeNo: "existing-epay", PaymentProvider: PaymentProviderEpay, Amount: 99, Money: 99, Status: common.TopUpStatusSuccess}).Error)
					}
					for range 2 {
						require.NoError(t, db.AutoMigrate(tables...))
					}
					if scenario == "upgrade" {
						var prior TopUp
						require.NoError(t, db.First(&prior, "trade_no = ?", "existing-epay").Error)
						require.EqualValues(t, 99, prior.Amount)
						require.Equal(t, common.TopUpStatusSuccess, prior.Status)
					}
					require.NoError(t, db.Create(&User{Id: 1, Username: "bepusdt-user", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Quota: 100, AuthVersion: 1}).Error)
					create := func(id string) {
						topUp := &TopUp{UserId: 1, TradeNo: id, Amount: 1, Money: 1.25, PaymentMethod: PaymentMethodBepusdt, PaymentProvider: PaymentProviderBepusdt, Status: common.TopUpStatusPending}
						order := &BepusdtOrder{TradeNo: id, Quota: 500000, MoneyCents: 125, Currency: "USD", GatewayURL: "https://pay.example", NotifyURL: "https://console.example/api/bepusdt/notify", ReturnURL: "https://console.example/wallet", Currencies: "USDT,USDC"}
						require.NoError(t, CreateBepusdtOrder(topUp, order))
					}
					balance := func() int { var user User; require.NoError(t, db.First(&user, 1).Error); return user.Quota }
					create("BEP-exact")
					require.ErrorIs(t, SettleBepusdtOrder("BEP-exact", "gateway-exact", 124, 2, "127.0.0.1"), ErrBepusdtOrderMismatch)
					require.Equal(t, 100, balance())
					require.NoError(t, SettleBepusdtOrder("BEP-exact", "gateway-exact", 125, 1, "127.0.0.1"))
					require.Equal(t, 100, balance())
					common.QuotaPerUnit = 999
					require.NoError(t, SettleBepusdtOrder("BEP-exact", "gateway-exact", 125, 2, "127.0.0.1"))
					require.Equal(t, 500100, balance(), "settlement uses the frozen quota, not current configuration")
					require.NoError(t, SettleBepusdtOrder("BEP-exact", "gateway-exact", 125, 2, "127.0.0.1"))
					require.ErrorIs(t, SettleBepusdtOrder("BEP-exact", "other-gateway", 125, 2, "127.0.0.1"), ErrBepusdtOrderMismatch)
					require.Equal(t, 500100, balance())
					create("BEP-late")
					require.NoError(t, SettleBepusdtOrder("BEP-late", "gateway-late", 125, 5, "127.0.0.1"))
					require.Equal(t, common.TopUpStatusPending, GetTopUpByTradeNo("BEP-late").Status)
					require.Equal(t, 500100, balance())
					for _, status := range []int{4, 6} {
						require.NoError(t, SettleBepusdtOrder("BEP-late", "gateway-late", 125, status, "127.0.0.1"))
						require.Equal(t, common.TopUpStatusExpired, GetTopUpByTradeNo("BEP-late").Status)
						require.Equal(t, 500100, balance())
					}
					require.NoError(t, SettleBepusdtOrder("BEP-late", "gateway-late", 125, 3, "127.0.0.1"))
					require.NoError(t, SettleBepusdtOrder("BEP-late", "gateway-late", 125, 1, "127.0.0.1"))
					require.Equal(t, common.TopUpStatusExpired, GetTopUpByTradeNo("BEP-late").Status)
					require.NoError(t, SettleBepusdtOrder("BEP-late", "gateway-late", 125, 2, "127.0.0.1"))
					require.Equal(t, 1000100, balance())
					create("BEP-provider")
					require.NoError(t, db.Model(&TopUp{}).Where("trade_no = ?", "BEP-provider").Update("payment_provider", PaymentProviderEpay).Error)
					require.ErrorIs(t, SettleBepusdtOrder("BEP-provider", "gateway-provider", 125, 2, "127.0.0.1"), ErrPaymentMethodMismatch)
					create("BEP-reused-id")
					require.Error(t, SettleBepusdtOrder("BEP-reused-id", "gateway-exact", 125, 2, "127.0.0.1"))
					require.Equal(t, 1000100, balance())
					create("BEP-capacity")
					require.NoError(t, db.Model(&User{}).Where("id = ?", 1).Update("quota", common.MaxWalletQuota).Error)
					require.ErrorIs(t, SettleBepusdtOrder("BEP-capacity", "gateway-capacity", 125, 2, "127.0.0.1"), ErrTopUpQuotaLimitExceeded)
					require.Equal(t, common.TopUpStatusPending, GetTopUpByTradeNo("BEP-capacity").Status)
					require.Equal(t, common.MaxWalletQuota, balance())
					require.NoError(t, db.Model(&User{}).Where("id = ?", 1).Update("quota", 100).Error)
					create("BEP-race")
					var wait sync.WaitGroup
					results := make(chan error, 8)
					for range 8 {
						wait.Go(func() { results <- SettleBepusdtOrder("BEP-race", "gateway-race", 125, 2, "127.0.0.1") })
					}
					wait.Wait()
					close(results)
					for err := range results {
						if err != nil {
							require.Equal(t, "sqlite", dialect)
							require.Contains(t, strings.ToLower(err.Error()), "locked")
							require.NoError(t, SettleBepusdtOrder("BEP-race", "gateway-race", 125, 2, "127.0.0.1"))
						}
					}
					require.Equal(t, 500100, balance(), "concurrent callbacks credit only once")
					create("BEP-manual")
					require.NoError(t, ManualCompleteTopUp("BEP-manual", "127.0.0.1"))
					require.Equal(t, 1000100, balance(), "manual completion also uses the frozen quota")
					require.NoError(t, SettleBepusdtOrder("BEP-manual", "gateway-manual", 125, 2, "127.0.0.1"))
					require.Equal(t, 1000100, balance())
				})
			}
		})
	}
}

type MigrationIdentityFields struct {
	ID        int    `gorm:"primaryKey"`
	Name      string `gorm:"size:64;unique"`
	Reference string `gorm:"size:64;uniqueIndex"`
	Provider  string `gorm:"size:32;uniqueIndex:,composite:provider_subject"`
	Subject   string `gorm:"size:64;uniqueIndex:,composite:provider_subject"`
}

type migrationIdentityV1 struct {
	MigrationIdentityFields
	Digest string `gorm:"type:char(32)"`
}

type migrationIdentityV2 struct {
	MigrationIdentityFields
	Digest string `gorm:"type:char(64)"`
	Note   string `gorm:"size:128"`
}

type migrationConstraintV1 struct {
	ID   int    `gorm:"primaryKey"`
	Name string `gorm:"size:64"`
}

type migrationConstraintV2 struct {
	ID   int    `gorm:"primaryKey"`
	Name string `gorm:"size:64;unique"`
}

type migrationDecimalV1 struct {
	ID    int     `gorm:"primaryKey"`
	Price float64 `gorm:"type:decimal(10,6);default:0"`
}

type migrationDecimalV2 struct {
	ID    int     `gorm:"primaryKey"`
	Price float64 `gorm:"type:decimal(12,6);not null;default:0"`
}

type migrationDecimalV3 struct {
	ID    int     `gorm:"primaryKey"`
	Price float64 `gorm:"type:decimal(12,6);not null;default:1.25"`
}

func TestMigrationSchemaStability(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			var dsn string
			switch dialect {
			case "sqlite":
				dsn = "local"
				previousPath := common.SQLitePath
				common.SQLitePath = filepath.Join(t.TempDir(), "migration.db")
				t.Cleanup(func() { common.SQLitePath = previousPath })
			case "mysql":
				dsn = os.Getenv("TEST_MYSQL_DSN")
			case "postgres":
				dsn = os.Getenv("TEST_POSTGRES_DSN")
			}
			if dsn == "" {
				t.Skip("test database DSN is not configured")
			}
			t.Setenv("MIGRATION_TEST_DSN", dsn)
			db, _, err := chooseDB("MIGRATION_TEST_DSN", false)
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			t.Cleanup(func() { _ = sqlDB.Close() })
			recorder := &migrationSQLRecorder{}
			db = db.Session(&gorm.Session{Logger: recorder})

			t.Run("identity_and_indexes", func(t *testing.T) {
				const table = "migration_identity_test"
				t.Cleanup(func() { _ = db.Migrator().DropTable(table) })
				require.NoError(t, db.Table(table).AutoMigrate(&migrationIdentityV1{}))
				row := migrationIdentityV1{
					MigrationIdentityFields: MigrationIdentityFields{ID: 1, Name: "root", Reference: "token-reference", Provider: "oidc", Subject: "subject"},
					Digest:                  "old-digest",
				}
				require.NoError(t, db.Table(table).Create(&row).Error)
				recorder.reset()
				require.NoError(t, db.Table(table).AutoMigrate(&migrationIdentityV1{}))
				assert.Empty(t, recorder.schemaMutations())

				require.NoError(t, db.Table(table).AutoMigrate(&migrationIdentityV2{}))
				columns, err := db.Table(table).Migrator().ColumnTypes(&migrationIdentityV2{})
				require.NoError(t, err)
				for _, column := range columns {
					if column.Name() == "digest" {
						length, ok := column.Length()
						require.True(t, ok)
						assert.EqualValues(t, 64, length)
					}
				}
				assert.True(t, db.Table(table).Migrator().HasColumn(&migrationIdentityV2{}, "note"))
				recorder.reset()
				require.NoError(t, db.Table(table).AutoMigrate(&migrationIdentityV2{}))
				assert.Empty(t, recorder.schemaMutations())
				var saved migrationIdentityV2
				require.NoError(t, db.Table(table).First(&saved, 1).Error)
				assert.Equal(t, row.MigrationIdentityFields, saved.MigrationIdentityFields)
				expectedDigest := row.Digest
				if dialect == "postgres" {
					expectedDigest += strings.Repeat(" ", 64-len(row.Digest))
				}
				assert.Equal(t, expectedDigest, saved.Digest)
				for _, duplicate := range []migrationIdentityV2{
					{MigrationIdentityFields: MigrationIdentityFields{Name: "root", Reference: "other-1", Provider: "other", Subject: "1"}},
					{MigrationIdentityFields: MigrationIdentityFields{Name: "other-2", Reference: "token-reference", Provider: "other", Subject: "2"}},
					{MigrationIdentityFields: MigrationIdentityFields{Name: "other-3", Reference: "other-3", Provider: "oidc", Subject: "subject"}},
				} {
					assert.Error(t, db.Table(table).Create(&duplicate).Error)
				}
			})

			t.Run("unique_constraint_changes", func(t *testing.T) {
				const table = "migration_constraint_test"
				t.Cleanup(func() { _ = db.Migrator().DropTable(table) })
				require.NoError(t, db.Table(table).AutoMigrate(&migrationConstraintV1{}))
				require.NoError(t, db.Table(table).Create(&migrationConstraintV1{Name: "existing"}).Error)
				require.NoError(t, db.Table(table).AutoMigrate(&migrationConstraintV2{}))
				assert.Error(t, db.Table(table).Create(&migrationConstraintV2{Name: "existing"}).Error)
				recorder.reset()
				require.NoError(t, db.Table(table).AutoMigrate(&migrationConstraintV2{}))
				assert.Empty(t, recorder.schemaMutations())
				require.NoError(t, db.Table(table).AutoMigrate(&migrationConstraintV1{}))
				require.NoError(t, db.Table(table).Create(&migrationConstraintV1{Name: "existing"}).Error)
			})

			if dialect == "postgres" {
				t.Run("renamed_unique_constraints", func(t *testing.T) {
					const table = "migration_renamed_unique"
					t.Cleanup(func() { _ = db.Migrator().DropTable(table) })
					tableDB := db.Table(table).Session(&gorm.Session{})
					require.NoError(t, tableDB.AutoMigrate(&migrationConstraintV1{}))
					original := migrationConstraintV1{Name: "existing"}
					require.NoError(t, tableDB.Create(&original).Error)
					for _, name := range []string{"models_model_name_key", `imported "model" name`} {
						require.NoError(t, db.Exec("ALTER TABLE ? ADD CONSTRAINT ? UNIQUE (name)", clause.Table{Name: table}, clause.Column{Name: name}).Error)
					}
					require.NoError(t, db.Exec("ALTER TABLE ? ADD CONSTRAINT keep_composite UNIQUE (id, name)", clause.Table{Name: table}).Error)
					require.NoError(t, db.Exec("CREATE INDEX keep_name_lookup ON ? (name)", clause.Table{Name: table}).Error)
					// A unique field must keep the old names and still reject duplicates.
					require.NoError(t, tableDB.AutoMigrate(&migrationConstraintV2{}))
					require.Error(t, tableDB.Create(&migrationConstraintV2{Name: "existing"}).Error)
					require.NoError(t, db.Exec("CREATE TABLE migration_unique_reference (name varchar(64) REFERENCES migration_renamed_unique(name))").Error)
					t.Cleanup(func() { _ = db.Migrator().DropTable("migration_unique_reference") })
					require.NoError(t, db.Exec("INSERT INTO migration_unique_reference (name) VALUES (?)", "existing").Error)
					require.Error(t, tableDB.AutoMigrate(&migrationConstraintV1{}), "dependent foreign keys must not be cascaded away")
					for _, name := range []string{"models_model_name_key", `imported "model" name`} {
						assert.True(t, tableDB.Migrator().HasConstraint(&migrationConstraintV1{}, name), "all old constraints must survive rollback")
					}
					var references int64
					require.NoError(t, db.Table("migration_unique_reference").Count(&references).Error)
					assert.EqualValues(t, 1, references)
					require.NoError(t, db.Migrator().DropTable("migration_unique_reference"))
					// Removing column uniqueness must resolve both actual constraint names.
					require.NoError(t, tableDB.AutoMigrate(&migrationConstraintV1{}))
					recorder.reset()
					require.NoError(t, tableDB.AutoMigrate(&migrationConstraintV1{}))
					assert.Empty(t, recorder.schemaMutations())
					require.NoError(t, tableDB.Create(&migrationConstraintV1{Name: "existing"}).Error)
					assert.True(t, tableDB.Migrator().HasConstraint(&migrationConstraintV1{}, "keep_composite"))
					assert.True(t, tableDB.Migrator().HasIndex(&migrationConstraintV1{}, "keep_name_lookup"))
					var rows []migrationConstraintV1
					require.NoError(t, tableDB.Order("id").Find(&rows).Error)
					require.Len(t, rows, 2)
					assert.Equal(t, original, rows[0])
				})
			}

			if dialect == "mysql" {
				t.Run("decimal_default_and_real_changes", func(t *testing.T) {
					const table = "migration_decimal_test"
					t.Cleanup(func() { _ = db.Migrator().DropTable(table) })
					require.NoError(t, db.Table(table).AutoMigrate(&migrationDecimalV1{}))
					require.NoError(t, db.Table(table).Create(&migrationDecimalV1{ID: 1, Price: 12.345678}).Error)
					for _, target := range []any{&migrationDecimalV1{}, &migrationDecimalV2{}, &migrationDecimalV3{}} {
						require.NoError(t, db.Table(table).AutoMigrate(target))
						recorder.reset()
						require.NoError(t, db.Table(table).AutoMigrate(target))
						assert.Empty(t, recorder.schemaMutations())
					}
					columns, err := db.Table(table).Migrator().ColumnTypes(&migrationDecimalV3{})
					require.NoError(t, err)
					for _, column := range columns {
						if column.Name() == "price" {
							precision, scale, ok := column.DecimalSize()
							require.True(t, ok)
							assert.EqualValues(t, 12, precision)
							assert.EqualValues(t, 6, scale)
							nullable, ok := column.Nullable()
							require.True(t, ok)
							assert.False(t, nullable)
						}
					}
					require.NoError(t, db.Table(table).Create(&map[string]any{"id": 2}).Error)
					var prices []float64
					require.NoError(t, db.Table(table).Order("id").Pluck("price", &prices).Error)
					assert.Equal(t, []float64{12.345678, 1.25}, prices)
				})
			}
		})
	}
}
