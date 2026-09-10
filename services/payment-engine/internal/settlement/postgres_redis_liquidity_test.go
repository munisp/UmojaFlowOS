package settlement

import (
	"context"
	"crypto/tls"
	"errors"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func pgRedisVerifier(t *testing.T) (*PostgresRedisLiquidityVerifier, sqlmock.Sqlmock, *miniredis.Miniredis, func()) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	mock.MatchExpectationsInOrder(false)
	mini := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mini.Addr()})
	v := &PostgresRedisLiquidityVerifier{
		DB: db, Redis: client, RequireRedis: true,
		LockTTL: time.Second, LockAttempts: 1000, LockRetryDelay: time.Millisecond,
		CacheTTL: time.Minute,
		Now:      func() time.Time { return time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC) },
	}
	cleanup := func() { _ = client.Close(); _ = db.Close() }
	return v, mock, mini, cleanup
}

func liquidityTestIntent() Intent {
	in := validIntent()
	in.AmountMinor = 1000
	return in
}

func liquidityTestRoute() RouteDecision {
	return RouteDecision{Route: CorridorRoute{ID: "route-ng", TenantID: "tenant-a", SourceCurrency: "NGN"}, Provider: "bank-primary", Rail: "mojaloop"}
}

func expectLiquidityRow(mock sqlmock.Sqlmock, in Intent, route RouteDecision, available, reserved, buffer int64, observed, expires time.Time, digest string) {
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(liquidityEvidenceSQL)).
		WithArgs(in.TenantID, route.Route.ID, route.Provider, route.Route.SourceCurrency).
		WillReturnRows(sqlmock.NewRows([]string{"evidence_id", "tenant_id", "route_id", "provider", "currency", "available_minor", "reserved_minor", "required_buffer_minor", "observed_at", "expires_at", "source", "evidence_digest"}).
			AddRow("evidence-1", in.TenantID, route.Route.ID, route.Provider, route.Route.SourceCurrency, available, reserved, buffer, observed, expires, "treasury-signed", digest))
	mock.ExpectCommit()
}

func TestPostgresRedisLiquidityVerifierAllowsFreshTransactionalEvidence(t *testing.T) {
	v, mock, _, cleanup := pgRedisVerifier(t)
	defer cleanup()
	in, route := liquidityTestIntent(), liquidityTestRoute()
	now := v.Now()
	expectLiquidityRow(mock, in, route, 10000, 1000, 100, now.Add(-time.Minute), now.Add(time.Minute), "0000000000000000000000000000000000000000000000000000000000000000")

	decision, err := v.Verify(context.Background(), in, route)
	if err != nil || !decision.Allowed || decision.Evidence.EvidenceDigest == "" {
		t.Fatalf("decision=%+v err=%v", decision, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresRedisLiquidityVerifierFailsClosedOnInsufficientFunds(t *testing.T) {
	v, mock, _, cleanup := pgRedisVerifier(t)
	defer cleanup()
	in, route := liquidityTestIntent(), liquidityTestRoute()
	now := v.Now()
	expectLiquidityRow(mock, in, route, 1000, 100, 100, now.Add(-time.Minute), now.Add(time.Minute), "0000000000000000000000000000000000000000000000000000000000000000")

	decision, err := v.Verify(context.Background(), in, route)
	if !errors.Is(err, ErrLiquidityInsufficient) || decision.Allowed {
		t.Fatalf("decision=%+v err=%v", decision, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresRedisLiquidityVerifierFailsClosedOnStaleEvidence(t *testing.T) {
	v, mock, _, cleanup := pgRedisVerifier(t)
	defer cleanup()
	in, route := liquidityTestIntent(), liquidityTestRoute()
	now := v.Now()
	expectLiquidityRow(mock, in, route, 10000, 0, 0, now.Add(-2*time.Hour), now.Add(-time.Minute), "0000000000000000000000000000000000000000000000000000000000000000")

	_, err := v.Verify(context.Background(), in, route)
	if !errors.Is(err, ErrTreasuryStale) {
		t.Fatalf("err=%v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresRedisLiquidityVerifierRejectsMalformedEvidenceDigest(t *testing.T) {
	v, mock, _, cleanup := pgRedisVerifier(t)
	defer cleanup()
	in, route := liquidityTestIntent(), liquidityTestRoute()
	now := v.Now()
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(liquidityEvidenceSQL)).
		WithArgs(in.TenantID, route.Route.ID, route.Provider, route.Route.SourceCurrency).
		WillReturnRows(sqlmock.NewRows([]string{"evidence_id", "tenant_id", "route_id", "provider", "currency", "available_minor", "reserved_minor", "required_buffer_minor", "observed_at", "expires_at", "source", "evidence_digest"}).
			AddRow("evidence-1", in.TenantID, route.Route.ID, route.Provider, route.Route.SourceCurrency, int64(10000), int64(0), int64(0), now.Add(-time.Minute), now.Add(time.Minute), "treasury-signed", "not-a-sha256"))

	_, err := v.Verify(context.Background(), in, route)
	if err == nil || !strings.Contains(err.Error(), "invalid evidence digest") {
		t.Fatalf("err=%v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresRedisLiquidityVerifierRequiresRedis(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	v := &PostgresRedisLiquidityVerifier{DB: db, RequireRedis: true}
	_, err = v.Verify(context.Background(), liquidityTestIntent(), liquidityTestRoute())
	if !errors.Is(err, ErrLiquidityUnavailable) {
		t.Fatalf("err=%v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentTreasuryUpdatesFailClosedAcrossMultiRailSettlement(t *testing.T) {
	v, mock, _, cleanup := pgRedisVerifier(t)
	defer cleanup()
	in, route := liquidityTestIntent(), liquidityTestRoute()
	now := v.Now()
	digest := "0000000000000000000000000000000000000000000000000000000000000000"
	const workers = 20
	for i := 0; i < workers; i++ {
		available := int64(10000)
		if i%2 == 1 {
			available = 1000
		}
		expectLiquidityRow(mock, in, route, available, 100, 100, now.Add(-time.Minute), now.Add(time.Minute), digest)
	}

	var allowed atomic.Int64
	var denied atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			decision, err := v.Verify(context.Background(), in, route)
			if err == nil && decision.Allowed {
				allowed.Add(1)
			} else {
				denied.Add(1)
			}
		}()
	}
	wg.Wait()
	if allowed.Load()+denied.Load() != workers || allowed.Load() == 0 || denied.Load() == 0 {
		t.Fatalf("concurrent admission did not observe both allowed and fail-closed outcomes: allowed=%d denied=%d", allowed.Load(), denied.Load())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresRedisLiquidityVerifierFailsClosedOnRedisPartition(t *testing.T) {
	v, mock, mini, cleanup := pgRedisVerifier(t)
	defer cleanup()
	in, route := liquidityTestIntent(), liquidityTestRoute()
	mini.Close()

	decision, err := v.Verify(context.Background(), in, route)
	if !errors.Is(err, ErrLiquidityUnavailable) || decision.Allowed {
		t.Fatalf("redis partition must deny admission: decision=%+v err=%v", decision, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("postgres must not be consulted after redis partition: %v", err)
	}
}

func TestRedisTLSConfigFailsClosedWithoutPinnedCA(t *testing.T) {
	if _, err := (RedisTLSConfig{Enabled: true}).TLSConfig(); err == nil {
		t.Fatal("expected TLS configuration without a pinned CA to fail closed")
	}
	if _, err := (RedisTLSConfig{RequireTLS: true}).TLSConfig(); err == nil {
		t.Fatal("expected RequireTLS with disabled TLS to fail closed")
	}
	cfg, err := (RedisTLSConfig{Enabled: false}).TLSConfig()
	if err != nil || cfg != nil {
		t.Fatalf("disabled optional TLS should return nil config, cfg=%v err=%v", cfg, err)
	}
	if tls.VersionTLS13 == 0 {
		t.Fatal("TLS 1.3 must be available in the runtime")
	}
}

func TestLiquidityRedisKeysAreVersionedAndSeparatedByRail(t *testing.T) {
	route := liquidityTestRoute()
	route.Route.DestinationCurrency = "GBP"
	route.Route.Direction = Direction("onramp")
	route.Route.Asset = "fiat"
	mojaloop := liquidityLockKey("tenant-a", route)
	route.Rail = "bank"
	bank := liquidityLockKey("tenant-a", route)
	if mojaloop == bank {
		t.Fatal("different settlement rails must not share a liquidity lock key")
	}
	if !strings.Contains(mojaloop, "umoja:liquidity:v1:lock:") {
		t.Fatalf("lock key missing versioned namespace: %s", mojaloop)
	}
	if liquidityCacheKey("tenant-a", route) == bank {
		t.Fatal("lock and evidence cache namespaces must be distinct")
	}
}

func TestAcquireLockEmitsReleaseFailureEventAndMetric(t *testing.T) {
	mini := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mini.Addr()})
	defer client.Close()

	exporter := tracetest.NewInMemoryExporter()
	provider := trace.NewTracerProvider(trace.WithSpanProcessor(trace.NewSimpleSpanProcessor(exporter)))
	reader := sdkmetric.NewManualReader()
	meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	otel.SetMeterProvider(meterProvider)
	defer provider.Shutdown(context.Background())
	tracer := provider.Tracer("umoja/test/liquidity")
	ctx, span := tracer.Start(context.Background(), "test-lock-release")

	v := &PostgresRedisLiquidityVerifier{Redis: client, RequireRedis: true, LockTTL: time.Minute, LockAttempts: 1}
	unlock, err := v.acquireLock(ctx, "umoja:liquidity:v1:lock:test", span, nil)
	if err != nil {
		t.Fatal(err)
	}
	mini.Close()
	unlock()
	span.End()
	if err := provider.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}

	spans := exporter.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("expected one recorded span, got %d", len(spans))
	}
	found := false
	for _, event := range spans[0].Events {
		if event.Name == "liquidity.lock.release_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected liquidity.lock.release_failed event, events=%v", spans[0].Events)
	}
	var metrics metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &metrics); err != nil {
		t.Fatal(err)
	}
	metricFound := false
	for _, scope := range metrics.ScopeMetrics {
		for _, emitted := range scope.Metrics {
			if emitted.Name == "umoja_settlement_liquidity_lock_release_failures_total" {
				metricFound = true
			}
		}
	}
	if !metricFound {
		t.Fatal("expected lock-release failure metric to be exported")
	}
}
