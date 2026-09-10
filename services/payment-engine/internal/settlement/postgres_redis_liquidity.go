package settlement

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

var (
	liquidityTracer           = otel.Tracer("umoja/payment-engine/settlement/liquidity")
	liquidityMeter            = otel.Meter("umoja/payment-engine/settlement/liquidity")
	liquidityChecks           = mustLiquidityCounter("umoja_settlement_liquidity_checks_total")
	liquidityDenials          = mustLiquidityCounter("umoja_settlement_liquidity_denials_total")
	liquidityLatency          = mustLiquidityHistogram("umoja_settlement_liquidity_check_duration_ms")
	liquidityLockReleaseFails = mustLiquidityCounter("umoja_settlement_liquidity_lock_release_failures_total")
)

func mustLiquidityCounter(name string) metric.Int64Counter {
	counter, err := liquidityMeter.Int64Counter(name)
	if err != nil {
		panic(err)
	}
	return counter
}

func mustLiquidityHistogram(name string) metric.Int64Histogram {
	histogram, err := liquidityMeter.Int64Histogram(name)
	if err != nil {
		panic(err)
	}
	return histogram
}

const liquidityEvidenceSQL = `
SELECT evidence_id, tenant_id, route_id, provider, currency,
       available_minor, reserved_minor, required_buffer_minor,
       observed_at, expires_at, source, evidence_digest
FROM liquidity_treasury_evidence
WHERE tenant_id = $1
  AND route_id = $2
  AND provider = $3
  AND currency = $4
  AND expires_at > now()
ORDER BY observed_at DESC
LIMIT 1
FOR UPDATE`

const releaseLiquidityLockScript = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

// PostgresRedisLiquidityVerifier treats PostgreSQL as the source of truth and
// Redis as a short-lived distributed admission lock/cache layer. Redis cache
// contents are never trusted for settlement authorization without a fresh
// PostgreSQL transaction.
const liquidityRedisKeyVersion = "v1"

// RedisTLSConfig describes the mandatory production transport settings for Redis.
// CA material is required when TLS is enabled; client certificates are optional
// and support mTLS/ACL deployments without weakening server verification.
type RedisTLSConfig struct {
	Enabled       bool
	RequireTLS    bool
	CACertPEM     []byte
	ClientCertPEM []byte
	ClientKeyPEM  []byte
	ServerName    string
	MinVersion    uint16
}

func (c RedisTLSConfig) TLSConfig() (*tls.Config, error) {
	if !c.Enabled {
		if c.RequireTLS {
			return nil, errors.New("redis TLS is required but disabled")
		}
		return nil, nil
	}
	if len(c.CACertPEM) == 0 {
		return nil, errors.New("redis TLS requires a pinned CA certificate")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(c.CACertPEM) {
		return nil, errors.New("redis TLS CA certificate is malformed")
	}
	cfg := &tls.Config{MinVersion: c.MinVersion, RootCAs: roots, ServerName: c.ServerName, InsecureSkipVerify: false} // #nosec G402 -- verification is explicitly enabled.
	if cfg.MinVersion == 0 {
		cfg.MinVersion = tls.VersionTLS13
	}
	if (len(c.ClientCertPEM) == 0) != (len(c.ClientKeyPEM) == 0) {
		return nil, errors.New("redis mTLS requires both client certificate and private key")
	}
	if len(c.ClientCertPEM) > 0 {
		cert, err := tls.X509KeyPair(c.ClientCertPEM, c.ClientKeyPEM)
		if err != nil {
			return nil, fmt.Errorf("redis client certificate: %w", err)
		}
		cfg.Certificates = []tls.Certificate{cert}
	}
	return cfg, nil
}

// NewRedisUniversalClient creates the only supported production Redis client.
// Username/password are taken from redis.UniversalOptions for ACL authentication.
func NewRedisUniversalClient(opts redis.UniversalOptions, tlsConfig RedisTLSConfig) (redis.UniversalClient, error) {
	cfg, err := tlsConfig.TLSConfig()
	if err != nil {
		return nil, err
	}
	opts.TLSConfig = cfg
	if len(opts.Addrs) == 0 {
		return nil, errors.New("redis requires at least one address")
	}
	return redis.NewUniversalClient(&opts), nil
}

func NewPostgresRedisLiquidityVerifier(db *sql.DB, opts redis.UniversalOptions, tlsConfig RedisTLSConfig) (*PostgresRedisLiquidityVerifier, error) {
	tlsConfig.RequireTLS = true
	client, err := NewRedisUniversalClient(opts, tlsConfig)
	if err != nil {
		return nil, err
	}
	return &PostgresRedisLiquidityVerifier{DB: db, Redis: client, RequireRedis: true}, nil
}

type PostgresRedisLiquidityVerifier struct {
	DB             *sql.DB
	Redis          redis.UniversalClient
	LockTTL        time.Duration
	LockAttempts   int
	LockRetryDelay time.Duration
	CacheTTL       time.Duration
	Now            func() time.Time
	RequireRedis   bool
}

func (v *PostgresRedisLiquidityVerifier) Verify(ctx context.Context, in Intent, route RouteDecision) (LiquidityDecision, error) {
	start := time.Now()
	ctx, span := liquidityTracer.Start(ctx, "settlement.liquidity.verify", trace.WithAttributes(
		attribute.String("tenant.id", in.TenantID),
		attribute.String("corridor.route_id", route.Route.ID),
		attribute.String("settlement.provider", route.Provider),
		attribute.String("settlement.currency", route.Route.SourceCurrency),
	))
	defer span.End()
	defer func() { liquidityLatency.Record(ctx, time.Since(start).Milliseconds()) }()

	now := time.Now().UTC()
	if v.Now != nil {
		now = v.Now().UTC()
	}
	attrs := []attribute.KeyValue{
		attribute.String("tenant.id", in.TenantID),
		attribute.String("corridor.route_id", route.Route.ID),
		attribute.String("settlement.provider", route.Provider),
	}
	liquidityChecks.Add(ctx, 1, metric.WithAttributes(attrs...))

	if v == nil || v.DB == nil {
		span.RecordError(ErrLiquidityUnavailable)
		liquidityDenials.Add(ctx, 1, metric.WithAttributes(attrs...))
		return LiquidityDecision{CheckedAt: now, Reason: "postgres liquidity store is unavailable"}, ErrLiquidityUnavailable
	}
	if v.RequireRedis && v.Redis == nil {
		span.RecordError(ErrLiquidityUnavailable)
		liquidityDenials.Add(ctx, 1, metric.WithAttributes(attrs...))
		return LiquidityDecision{CheckedAt: now, Reason: "redis admission lock is unavailable"}, ErrLiquidityUnavailable
	}
	if strings.TrimSpace(in.TenantID) == "" || strings.TrimSpace(route.Route.ID) == "" || strings.TrimSpace(route.Provider) == "" || strings.TrimSpace(route.Route.SourceCurrency) == "" {
		span.RecordError(ErrLiquidityUnavailable)
		liquidityDenials.Add(ctx, 1, metric.WithAttributes(attrs...))
		return LiquidityDecision{CheckedAt: now, Reason: "liquidity identity is incomplete"}, ErrLiquidityUnavailable
	}

	unlock, err := v.acquireLock(ctx, liquidityLockKey(in.TenantID, route), span, attrs)
	if err != nil {
		span.RecordError(err)
		liquidityDenials.Add(ctx, 1, metric.WithAttributes(attrs...))
		return LiquidityDecision{CheckedAt: now, Reason: "liquidity admission lock unavailable"}, ErrLiquidityUnavailable
	}
	defer unlock()

	tx, err := v.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted, ReadOnly: false})
	if err != nil {
		span.RecordError(err)
		liquidityDenials.Add(ctx, 1, metric.WithAttributes(attrs...))
		return LiquidityDecision{CheckedAt: now, Reason: "liquidity transaction unavailable"}, ErrLiquidityUnavailable
	}
	defer tx.Rollback()

	var evidence LiquidityEvidence
	err = tx.QueryRowContext(ctx, liquidityEvidenceSQL, in.TenantID, route.Route.ID, route.Provider, route.Route.SourceCurrency).Scan(
		&evidence.EvidenceID, &evidence.TenantID, &evidence.RouteID, &evidence.Provider, &evidence.Currency,
		&evidence.AvailableMinor, &evidence.ReservedMinor, &evidence.RequiredBufferMinor,
		&evidence.ObservedAt, &evidence.ExpiresAt, &evidence.Source, &evidenceDigestScanner{target: &evidence},
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = ErrLiquidityUnavailable
		}
		span.RecordError(err)
		liquidityDenials.Add(ctx, 1, metric.WithAttributes(attrs...))
		return LiquidityDecision{CheckedAt: now, Reason: "fresh liquidity evidence not found"}, err
	}
	if err := tx.Commit(); err != nil {
		span.RecordError(err)
		liquidityDenials.Add(ctx, 1, metric.WithAttributes(attrs...))
		return LiquidityDecision{Evidence: evidence, CheckedAt: now, Reason: "liquidity transaction commit failed"}, ErrLiquidityUnavailable
	}

	decision, err := verifyLiquidityEvidence(in, route, evidence, now)
	if err != nil {
		span.RecordError(err)
		liquidityDenials.Add(ctx, 1, metric.WithAttributes(attrs...))
		return decision, err
	}
	span.SetAttributes(attribute.String("liquidity.evidence_id", evidence.EvidenceID), attribute.Bool("liquidity.allowed", true))
	v.cacheEvidence(ctx, liquidityCacheKey(in.TenantID, route), evidence)
	return decision, nil
}

// evidenceDigestScanner preserves the exact digest bytes while allowing the
// adapter to reject malformed database values after Scan.
type evidenceDigestScanner struct{ target *LiquidityEvidence }

func (s *evidenceDigestScanner) Scan(src any) error {
	switch value := src.(type) {
	case string:
		if len(value) != 64 {
			return fmt.Errorf("invalid evidence digest length")
		}
		if _, err := hex.DecodeString(value); err != nil {
			return err
		}
		s.target.EvidenceDigest = value
		return nil
	case []byte:
		if len(value) != 64 {
			return fmt.Errorf("invalid evidence digest length")
		}
		text := string(value)
		if _, err := hex.DecodeString(text); err != nil {
			return err
		}
		s.target.EvidenceDigest = text
		return nil
	default:
		return fmt.Errorf("invalid evidence digest type %T", src)
	}
}

func verifyLiquidityEvidence(in Intent, route RouteDecision, e LiquidityEvidence, now time.Time) (LiquidityDecision, error) {
	if e.TenantID != in.TenantID || e.RouteID != route.Route.ID || e.Provider != route.Provider || e.Currency != route.Route.SourceCurrency || strings.TrimSpace(e.EvidenceID) == "" || len(e.EvidenceDigest) != 64 {
		return LiquidityDecision{Evidence: e, CheckedAt: now, Reason: "liquidity evidence identity mismatch"}, ErrLiquidityUnavailable
	}
	if e.ObservedAt.IsZero() || e.ExpiresAt.IsZero() || e.ObservedAt.After(now) || !e.ExpiresAt.After(now) {
		return LiquidityDecision{Evidence: e, CheckedAt: now, Reason: "liquidity evidence is stale or invalid"}, ErrTreasuryStale
	}
	if e.AvailableMinor < 0 || e.ReservedMinor < 0 || e.RequiredBufferMinor < 0 || e.ReservedMinor > e.AvailableMinor {
		return LiquidityDecision{Evidence: e, CheckedAt: now, Reason: "liquidity evidence is contradictory"}, ErrLiquidityUnavailable
	}
	if e.AvailableMinor-e.ReservedMinor < in.AmountMinor+e.RequiredBufferMinor {
		return LiquidityDecision{Evidence: e, CheckedAt: now, Reason: "liquidity buffer is insufficient"}, ErrLiquidityInsufficient
	}
	return LiquidityDecision{Allowed: true, Evidence: e, CheckedAt: now, Reason: "fresh transactional liquidity verified"}, nil
}

func liquidityLockKey(tenant string, route RouteDecision) string {
	return "umoja:liquidity:" + liquidityRedisKeyVersion + ":lock:" + hashLiquidityKey(tenant, route.Route.ID, route.Provider, route.Route.SourceCurrency, route.Route.DestinationCurrency, string(route.Route.Direction), route.Route.Asset, route.Rail)
}
func liquidityCacheKey(tenant string, route RouteDecision) string {
	return "umoja:liquidity:" + liquidityRedisKeyVersion + ":evidence:" + hashLiquidityKey(tenant, route.Route.ID, route.Provider, route.Route.SourceCurrency, route.Route.DestinationCurrency, string(route.Route.Direction), route.Route.Asset, route.Rail)
}
func hashLiquidityKey(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte{0})
		h.Write([]byte(p))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (v *PostgresRedisLiquidityVerifier) acquireLock(ctx context.Context, key string, span trace.Span, attrs []attribute.KeyValue) (func(), error) {
	if v.Redis == nil {
		if v.RequireRedis {
			return func() {}, ErrLiquidityUnavailable
		}
		return func() {}, nil
	}
	ttl := v.LockTTL
	if ttl <= 0 {
		ttl = 5 * time.Second
	}
	attempts := v.LockAttempts
	if attempts <= 0 {
		attempts = 3
	}
	delay := v.LockRetryDelay
	if delay <= 0 {
		delay = 20 * time.Millisecond
	}
	tokenBytes := make([]byte, 16)
	if _, err := rand.Read(tokenBytes); err != nil {
		return func() {}, err
	}
	token := hex.EncodeToString(tokenBytes)
	for attempt := 0; attempt < attempts; attempt++ {
		ok, err := v.Redis.SetNX(ctx, key, token, ttl).Result()
		if err != nil {
			return func() {}, err
		}
		if ok {
			return func() {
				releaseErr := v.Redis.Eval(context.Background(), releaseLiquidityLockScript, []string{key}, token).Err()
				if releaseErr != nil {
					liquidityLockReleaseFails.Add(context.Background(), 1, metric.WithAttributes(attrs...))
					span.AddEvent("liquidity.lock.release_failed", trace.WithAttributes(attribute.String("error.type", fmt.Sprintf("%T", releaseErr)), attribute.String("error.message", releaseErr.Error())))
				}
			}, nil
		}
		select {
		case <-ctx.Done():
			return func() {}, ctx.Err()
		case <-time.After(delay):
		}
	}
	return func() {}, ErrLiquidityUnavailable
}

func (v *PostgresRedisLiquidityVerifier) cacheEvidence(ctx context.Context, key string, e LiquidityEvidence) {
	if v.Redis == nil {
		return
	}
	ttl := v.CacheTTL
	if ttl <= 0 {
		ttl = time.Minute
	}
	payload, err := json.Marshal(e)
	if err != nil {
		return
	}
	_ = v.Redis.Set(ctx, key, payload, ttl).Err()
}
